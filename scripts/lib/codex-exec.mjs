// Runtime helpers for codexgrill. Wraps the public `codex exec` CLI.
//
// All Codex calls go through runCodexExec. The session is pinned by passing the
// thread_id captured from iter 1's JSONL stream to `codex exec resume <id>` in
// later iterations — nothing else can collide with the thread by construction.
//
// Containment is enforced by hashing every dirty + untracked path in the git
// working tree before and after each invocation (the codex sandbox is NOT used
// because read-only mode blocks command execution and breaks the review).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// Paths that auto-mutate while the user has an IDE / editor open, plus the
// plugin's own per-run scratch directory. We skip these in the working-tree
// containment check so they never trip a false positive. Anything not listed
// here that changes still triggers the neutral "was this you or Codex?"
// prompt — the command files offer to add such paths to .gitignore.
export const DEFAULT_IGNORED_PATTERNS = [
  // codexgrill's own per-run scratch — prompt.txt, codex.jsonl, final.txt,
  // result.json, state.json, etc. live here. These are wrapper-internal
  // bookkeeping, not source code. In projects that don't gitignore .claude/
  // the wrapper's writes would otherwise trip the containment check as
  // "new untracked files" (false positive).
  '.claude/temp/codexgrill/**',
  // IDE config / state (JetBrains family, Visual Studio, VSCode, Cursor)
  '.idea/**',
  '.vs/**',
  '.vscode/**',
  '.cursor/**',
  '.history/**',
  '*.suo',
  '*.user',
  // Editor swap / backup files
  '*.swp',
  '*.swo',
  '*~',
  '*.bak',
  // OS / metadata
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
];

// Minimal glob matcher for DEFAULT_IGNORED_PATTERNS. Supports:
//   - exact path:      `.idea/workspace.xml`
//   - prefix glob:     `.idea/**`              (matches anything under the prefix)
//   - suffix glob:     `*.swp`, `*~`           (matches any path ending with the literal suffix)
//   - bare basename:   `Thumbs.db`             (matches that basename anywhere)
// Path is normalized to forward slashes before matching.
export function matchesIgnorePattern(filePath, patterns = DEFAULT_IGNORED_PATTERNS) {
  const p = String(filePath).replaceAll('\\', '/');
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (p === prefix || p.startsWith(prefix + '/')) return true;
      continue;
    }
    if (pattern.startsWith('*') && !pattern.slice(1).includes('*') && !pattern.includes('/')) {
      if (p.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (!pattern.includes('/') && !pattern.includes('*')) {
      // Bare basename — match anywhere in tree
      if (p === pattern || p.endsWith('/' + pattern)) return true;
      continue;
    }
    if (p === pattern) return true;
  }
  return false;
}

// Cross-platform codex resolver. Returns `{ exec, prefixArgs }` so the caller
// can `spawn(exec, [...prefixArgs, ...args], { shell: false })`.
//
// POSIX: `codex` is a real binary (or a node script with a shebang that the OS
// resolves), so a direct spawn with shell:false works as-is.
//
// Windows: `codex` ships as `codex.cmd`, an npm-bin batch shim. Routing through
// `shell: true` would expand `%VAR%` even inside double-quoted args (cmd.exe
// semantics + Node DEP0190). Spawning the .cmd directly with shell:false throws
// EINVAL on modern Node (CVE-2024-27980 mitigation). So we resolve the shim to
// its underlying JS entrypoint and spawn `node <codex.js>` directly. Native
// `.exe`/`.com` installs are detected and spawned directly without `node`.
let resolvedCodexCache = null;

async function resolveCodex() {
  if (resolvedCodexCache) return resolvedCodexCache;

  if (process.platform !== 'win32') {
    resolvedCodexCache = { exec: 'codex', prefixArgs: [] };
    return resolvedCodexCache;
  }

  // Walk PATH × PATHEXT to find the codex shim. Real Windows default PATHEXT
  // puts .COM/.EXE before .CMD/.BAT — honor that order so a native install
  // beats a .cmd shim when both exist.
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC')
    .split(';').map((s) => s.trim()).filter(Boolean);
  let found = null;
  outer: for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, 'codex' + ext);
      try {
        await fs.access(candidate);
        found = candidate;
        break outer;
      } catch { /* keep looking */ }
    }
  }
  if (!found) {
    throw new CodexNotInstalledError(`'codex' not found on PATH (searched ${exts.join(', ')})`);
  }

  const ext = path.extname(found).toLowerCase();
  const cmdDir = path.dirname(found);

  // Native executable: spawn directly with shell:false (no shim needed).
  if (ext === '.exe' || ext === '.com') {
    resolvedCodexCache = { exec: found, prefixArgs: [] };
    return resolvedCodexCache;
  }

  // .cmd / .bat: npm-bin shim. Resolve the underlying JS entrypoint.
  // (A) Canonical layout — works for global and local npm installs alike.
  const canonicalJs = path.join(cmdDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try {
    await fs.access(canonicalJs);
    resolvedCodexCache = { exec: process.execPath, prefixArgs: [canonicalJs] };
    return resolvedCodexCache;
  } catch { /* fall through to parser */ }

  // (B) Fallback: parse the .cmd for the JS path. The npm-bin shim declares
  // `SET dp0=%~dp0` and then quotes `"%dp0%\..."`. Expand `%dp0%` ourselves —
  // otherwise path.resolve produces a path with the literal `%dp0%` token in
  // it (which doesn't exist on disk).
  const cmdText = await fs.readFile(found, 'utf8');
  const m = cmdText.match(/"%[^%"]+%"\s+"([^"]+\.[mc]?js)"\s+%\*/);
  if (!m) {
    throw new CodexNotInstalledError(
      `codex installed at ${found} but couldn't derive JS entrypoint (tried ${canonicalJs} and shim parse)`,
    );
  }
  const expanded = m[1].replace(/%dp0%/gi, cmdDir);
  const jsResolved = path.resolve(cmdDir, expanded);
  try {
    await fs.access(jsResolved);
  } catch {
    throw new CodexNotInstalledError(
      `derived JS entrypoint ${jsResolved} from ${found} does not exist`,
    );
  }
  resolvedCodexCache = { exec: process.execPath, prefixArgs: [jsResolved] };
  return resolvedCodexCache;
}

// Codex on Windows fails with "os error 2" when --cd receives a backslash path
// (verified with codex-cli 0.130.0). Forward slashes work for all path flags.
function toCodexPath(p) {
  if (process.platform !== 'win32') return p;
  return String(p).replaceAll('\\', '/');
}

// Strip the shell-wrapper prefix codex adds to commands so the meaningful
// part shows in the live progress line. Two layers:
//   1. Outer shell: `"...\powershell.exe" -Command '<inner>'`, `bash -c '<inner>'`, `cmd /c '<inner>'`
//   2. Inner boilerplate: codex's PowerShell line-numbering idiom
//      `$i=0; Get-Content -LiteralPath '<file>' | ForEach-Object { "$i++; ..." }` → `Get-Content -LiteralPath '<file>'`
function stripShellWrapper(cmd) {
  if (typeof cmd !== 'string') return cmd;
  let inner = cmd;
  let m = inner.match(/powershell(?:\.exe)?["']?\s+-Command\s+['"]?([\s\S]+?)['"]?$/i);
  if (m) inner = m[1];
  else if ((m = inner.match(/(?:^|\/)(?:bash|sh|zsh)(?:\.exe)?["']?\s+-c\s+['"]?([\s\S]+?)['"]?$/))) inner = m[1];
  else if ((m = inner.match(/^cmd(?:\.exe)?\s+\/[a-z]+\s+['"]?([\s\S]+?)['"]?$/i))) inner = m[1];
  // Drop the `$i=0; ... | ForEach-Object { ... }` line-numbering noise
  inner = inner.replace(/^\$i\s*=\s*0\s*;\s*/i, '').replace(/\s*\|\s*ForEach-Object\s*\{[\s\S]*\}\s*$/i, '');
  return inner.trim();
}

// Compact one-line summary of a codex JSONL event, for live progress on stderr.
// Returns null for events that aren't worth showing (avoids noisy double-prints
// of started/completed pairs for successful commands).
function summarizeEvent(evt) {
  const t = evt?.type;
  const trunc = (s, n = 100) => {
    const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
  };
  if (t === 'thread.started') {
    const id = typeof evt.thread_id === 'string' ? evt.thread_id.slice(0, 8) : '?';
    return `[codex] thread ${id} started`;
  }
  if (t === 'turn.started') return `[codex] turn started`;
  if (t === 'item.started') {
    const it = evt.item;
    if (!it) return null;
    if (it.type === 'command_execution') return `[codex] $ ${trunc(stripShellWrapper(it.command))}`;
    if (it.type === 'web_search') return `[codex] search: ${trunc(it.query)}`;
    if (it.type === 'file_change') return `[codex] writing ${it.changes?.length ?? '?'} file(s)`;
    if (it.type === 'reasoning') return `[codex] reasoning…`;
    if (it.type === 'mcp_tool_call') return `[codex] tool ${it.server ?? '?'}/${it.tool ?? '?'}`;
    if (it.type === 'dynamic_tool_call') return `[codex] tool ${it.tool ?? '?'}`;
    if (it.type === 'agent_message') return null;
    return `[codex] ${it.type}`;
  }
  if (t === 'item.completed') {
    const it = evt.item;
    if (!it) return null;
    if (it.type === 'agent_message' && typeof it.text === 'string') {
      return `[codex] » ${trunc(it.text, 100)}`;
    }
    if (it.type === 'command_execution') {
      const code = it.exit_code ?? it.exitCode;
      if (code != null && code !== 0) return `[codex] ✗ command (exit ${code})`;
      return null;
    }
    return null;
  }
  if (t === 'turn.completed') {
    const u = evt.usage;
    if (!u) return `[codex] turn complete`;
    const parts = [`in=${u.input_tokens}`];
    if (u.cached_input_tokens != null) parts.push(`cached=${u.cached_input_tokens}`);
    parts.push(`out=${u.output_tokens}`);
    if (u.reasoning_output_tokens) parts.push(`reason=${u.reasoning_output_tokens}`);
    return `[codex] turn complete (${parts.join(', ')})`;
  }
  if (t === 'turn.failed') return `[codex] turn FAILED: ${trunc(evt.error?.message ?? evt.error ?? '?', 120)}`;
  if (t === 'error') return `[codex] ERROR: ${trunc(evt.error?.message ?? evt.message ?? JSON.stringify(evt), 120)}`;
  return null;
}

export class CodexNotInstalledError extends Error {
  constructor(detail) {
    super(`CODEX_NOT_INSTALLED: ${detail}`);
    this.code = 'CODEX_NOT_INSTALLED';
  }
}

export class CodexExecFailedError extends Error {
  constructor(message, { exitCode, stderr, errorReason, signal } = {}) {
    super(message);
    this.code = 'CODEX_EXEC_FAILED';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.errorReason = errorReason;
    this.signal = signal;
  }
}

export class WorkingTreeChangedError extends Error {
  constructor(changedFiles) {
    super(`WORKING_TREE_CHANGED:${changedFiles.join(',')}`);
    this.code = 'WORKING_TREE_CHANGED';
    this.changedFiles = changedFiles;
  }
}

export class NotAGitRepoError extends Error {
  constructor(cwd) {
    super(`NOT_A_GIT_REPO: ${cwd} is not inside a git working tree`);
    this.code = 'NOT_A_GIT_REPO';
    this.cwd = cwd;
  }
}

export class GitUnavailableError extends Error {
  constructor(reason) {
    super(`GIT_UNAVAILABLE: ${reason}`);
    this.code = 'GIT_UNAVAILABLE';
  }
}

export class InvalidEffortError extends Error {
  constructor(value) {
    super(`invalid --effort value: ${value} (must be one of: ${VALID_EFFORTS.join(', ')})`);
    this.code = 'INVALID_EFFORT';
  }
}

export function validateEffort(value) {
  if (!VALID_EFFORTS.includes(value)) throw new InvalidEffortError(value);
  return value;
}

// Probe that `codex` is on PATH and runnable. Throws CodexNotInstalledError on
// ENOENT or non-zero exit.
export async function assertCodexInstalled() {
  const resolved = await resolveCodex();
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.exec, [...resolved.prefixArgs, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(new CodexNotInstalledError(`failed to spawn 'codex': ${err.message}`));
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new CodexNotInstalledError(`'codex' binary not found on PATH`));
      } else {
        reject(new CodexNotInstalledError(`failed to spawn 'codex': ${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new CodexNotInstalledError(`'codex --version' exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

// Run a single `codex exec` (or `codex exec resume <id>`) invocation.
//
// opts:
//   promptText        full prompt text (already includes refuted-log if any).
//   mode              'fresh' or 'resume'.
//   resumeThreadId    required when mode==='resume'; the UUID from iter 1.
//   runDir            absolute path to the run directory.
//   iter              integer iteration number (used for file suffixes).
//   cwd               --cd <DIR> for the codex invocation.
//   effort            optional; mapped to `-c model_reasoning_effort=<level>`.
//   model             optional; mapped to `-m <name>`.
//   ephemeral         optional; if true, adds --ephemeral. (Must be false when
//                     mode==='fresh' inside a loop run — persistence is needed
//                     for the next iteration's resume.)
//
// Returns: { threadId, finalMessage, usage, exitCode, errorReason }.
//   threadId       UUID captured from thread.started event, or null on early failure.
//   finalMessage   last item.completed (agent_message) text, or '' if none.
//   usage          turn.completed.usage object, or null.
//   exitCode       child's exit code (0 on success).
//   errorReason    turn.failed.error.message or top-level error event message, if any.
export async function runCodexExec(opts) {
  const {
    promptText,
    mode,
    resumeThreadId,
    runDir,
    iter,
    cwd,
    effort,
    model,
    ephemeral = false,
  } = opts;

  if (mode !== 'fresh' && mode !== 'resume') {
    throw new Error(`runCodexExec: mode must be 'fresh' or 'resume' (got: ${mode})`);
  }
  if (mode === 'resume' && !resumeThreadId) {
    throw new Error(`runCodexExec: resumeThreadId is required when mode='resume'`);
  }
  if (effort != null) validateEffort(effort);

  await fs.mkdir(runDir, { recursive: true });

  // Caller controls file naming via opts (once-mode uses bare names; loop-mode
  // uses -iter<N> suffixes); fall back to iter-derived defaults.
  const promptName = opts.promptFileName || (iter === 1 ? 'prompt.txt' : `prompt-iter${iter}.txt`);
  const finalName = opts.finalFileName || (iter === 1 ? 'final.txt' : `final-iter${iter}.txt`);
  const jsonlName = opts.jsonlFileName || (iter === 1 ? 'codex.jsonl' : `codex-iter${iter}.jsonl`);

  const promptPath = path.join(runDir, promptName);
  const finalPath = path.join(runDir, finalName);
  const jsonlPath = path.join(runDir, jsonlName);

  await fs.writeFile(promptPath, promptText, 'utf8');

  const resolved = await resolveCodex();

  const args = [];
  args.push('exec');
  if (mode === 'resume') {
    args.push('resume', resumeThreadId);
  }
  args.push(
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-o', toCodexPath(finalPath),
  );
  // `codex exec resume` doesn't accept --cd (the working dir is inherited from
  // the session created in iter 1). Only pass --cd for fresh runs.
  if (mode === 'fresh') {
    args.push('--cd', toCodexPath(cwd));
  }
  if (effort != null) {
    args.push('-c', `model_reasoning_effort=${effort}`);
  }
  if (model != null) {
    args.push('-m', model);
  }
  if (ephemeral) {
    args.push('--ephemeral');
  }
  // Prompt from stdin (the `-` sentinel).
  args.push('-');

  let threadId = null;
  let finalMessage = '';
  let usage = null;
  let errorReason = null;
  let stderrBuf = '';

  const jsonlStream = createWriteStream(jsonlPath, { flags: 'w' });
  const closeJsonl = () => new Promise((res) => jsonlStream.end(res));

  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.exec, [...resolved.prefixArgs, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      jsonlStream.end();
      reject(new CodexExecFailedError(`failed to spawn 'codex exec': ${err.message}`));
      return;
    }

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', (line) => {
      jsonlStream.write(line + '\n');
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      const summary = summarizeEvent(evt);
      if (summary) process.stderr.write(summary + '\n');
      const t = evt?.type;
      if (t === 'thread.started') {
        if (typeof evt.thread_id === 'string') threadId = evt.thread_id;
      } else if (t === 'item.completed') {
        const item = evt.item;
        if (item && item.type === 'agent_message' && typeof item.text === 'string') {
          finalMessage = item.text;
        }
      } else if (t === 'turn.completed') {
        if (evt.usage) usage = evt.usage;
      } else if (t === 'turn.failed') {
        const msg = evt?.error?.message || evt?.error || 'turn.failed';
        errorReason = typeof msg === 'string' ? msg : JSON.stringify(msg);
      } else if (t === 'error') {
        const msg = evt?.error?.message || evt?.message || JSON.stringify(evt);
        errorReason = typeof msg === 'string' ? msg : String(msg);
      }
    });

    child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

    child.on('error', async (err) => {
      await closeJsonl();
      if (err.code === 'ENOENT') {
        reject(new CodexNotInstalledError(`'codex' binary not found on PATH`));
      } else {
        reject(new CodexExecFailedError(`failed to spawn 'codex exec': ${err.message}`));
      }
    });

    child.on('close', async (code, signal) => {
      await closeJsonl();
      resolve({ exitCode: code ?? 0, signal: signal || null });
    });

    // Pipe the prompt in and close stdin so codex doesn't hang waiting for EOF.
    child.stdin.on('error', () => { /* ignore EPIPE if codex exits early */ });
    child.stdin.end(promptText, 'utf8');
  });

  // Cross-check final message from the -o file if the stream didn't carry it.
  if (!finalMessage) {
    try {
      const fromFile = await fs.readFile(finalPath, 'utf8');
      if (fromFile.trim().length > 0) finalMessage = fromFile;
    } catch {
      // -o file may not exist on early failure.
    }
  }

  return {
    threadId,
    finalMessage,
    usage,
    exitCode: result.exitCode,
    signal: result.signal,
    errorReason,
    stderr: stderrBuf,
    promptPath,
    finalPath,
    jsonlPath,
  };
}

// Snapshot the working tree's content state for containment checking.
// Returns { [pathRelToCwd]: sha256hex | null } for every dirty + untracked path
// reported by `git status --porcelain=v1 -z`.
export async function snapshotWorkingTree(cwd = process.cwd()) {
  const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
    } catch (err) {
      reject(new GitUnavailableError(err.message));
      return;
    }
    const outChunks = [];
    let errOut = '';
    child.stdout.on('data', (d) => { outChunks.push(d); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (err) => {
      reject(new GitUnavailableError(err.message));
    });
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: errOut,
        exitCode: code ?? 0,
      });
    });
  });

  if (exitCode !== 0) {
    if (/not a git repository/i.test(stderr)) {
      throw new NotAGitRepoError(cwd);
    }
    throw new Error(`git status failed (${exitCode}): ${stderr.trim() || 'no stderr'}`);
  }

  const parts = stdout.split('\0');
  const paths = new Set();
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry || entry.length < 3) { i++; continue; }
    const status = entry.slice(0, 2);
    const newPath = entry.slice(3);
    if (newPath) paths.add(newPath);
    if (status.includes('R') || status.includes('C')) {
      const oldPath = parts[i + 1];
      if (oldPath) paths.add(oldPath);
      i += 2;
    } else {
      i += 1;
    }
  }

  const snapshot = {};
  for (const p of paths) {
    const absPath = path.resolve(cwd, p);
    try {
      const data = await fs.readFile(absPath);
      snapshot[p] = createHash('sha256').update(data).digest('hex');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        snapshot[p] = null;
      } else {
        throw err;
      }
    }
  }
  return snapshot;
}

// Compare two snapshots. Throws WorkingTreeChangedError listing every changed path.
export function assertContainment(before, after) {
  const allPaths = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  const changed = [];
  for (const p of allPaths) {
    const b = before ? before[p] : undefined;
    const a = after ? after[p] : undefined;
    if (b !== a) changed.push(p);
  }
  if (changed.length === 0) return [];
  changed.sort();
  throw new WorkingTreeChangedError(changed);
}

// Compute a unified diff between two files using `git diff --no-index`. Works
// inside or outside a git repo; both paths should be absolute. Returns:
//   { exitCode, stdout, stderr }
// Exit code semantics (different from most git subcommands):
//   0   — files are identical (stdout empty)
//   1   — files differ (stdout contains the unified diff) — SUCCESS, not error
//   >=2 — real failure (missing file, IO) — throws Error with stderr tail
// Spawn failures (git binary missing) throw GitUnavailableError so the caller
// can fall back to a diff-free prompt path without aborting the whole run.
//
// `--ignore-cr-at-eol` defends against editor-induced LF/CRLF drift creating
// spurious diffs on Windows. `--` guards against paths with leading `-`.
export async function diffNoIndex(oldPath, newPath, { contextLines = 10, cwd = process.cwd() } = {}) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', [
        'diff',
        '--no-index',
        '--ignore-cr-at-eol',
        `-U${contextLines}`,
        '--',
        oldPath,
        newPath,
      ], { cwd });
    } catch (err) {
      reject(new GitUnavailableError(err.message));
      return;
    }
    const outChunks = [];
    let errOut = '';
    child.stdout.on('data', (d) => { outChunks.push(d); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (err) => {
      reject(new GitUnavailableError(err.message));
    });
    child.on('close', (code) => {
      const exitCode = code ?? 0;
      const stdout = Buffer.concat(outChunks).toString('utf8');
      if (exitCode >= 2) {
        reject(new Error(`git diff --no-index failed (exit ${exitCode}): ${errOut.trim() || 'no stderr'}`));
        return;
      }
      resolve({ exitCode, stdout, stderr: errOut });
    });
  });
}

// Non-throwing git runner. Returns `{ stdout, stderr, exitCode }` for any
// process completion (including non-zero exits) so probes can branch on the
// code; throws `GitUnavailableError` only when spawn itself fails (e.g., git
// binary missing).
async function runGit(args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new GitUnavailableError(err.message));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => reject(new GitUnavailableError(err.message)));
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

// Must-succeed wrapper. Throws on non-zero exit so a failed plumbing step
// can't silently produce an empty sha that gets passed to the next command.
async function runGitOrThrow(args, opts = {}) {
  const r = await runGit(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim() || 'no stderr'}`);
  }
  return r;
}

// Resolve the git repo root for the given cwd. Returns the absolute path with
// forward slashes — matching the namespace of `git status --porcelain` output,
// which is repo-root-anchored regardless of cwd. Throws `NotAGitRepoError`
// when cwd is not inside a git working tree, and propagates `GitUnavailableError`
// when the git binary is missing.
export async function gitRepoRoot(cwd) {
  const r = await runGit(['rev-parse', '--show-toplevel'], { cwd });
  if (r.exitCode !== 0) {
    if (/not a git repository/i.test(r.stderr)) throw new NotAGitRepoError(cwd);
    throw new Error(`git rev-parse --show-toplevel failed (${r.exitCode}): ${r.stderr.trim() || 'no stderr'}`);
  }
  return r.stdout.trim().replaceAll('\\', '/');
}

// Capture tracked + untracked working-tree content as a single tree-commit,
// pinned under a permanent ref like `refs/codexgrill/<runId>/iter-<N>-pre`.
// Uses a temporary index (GIT_INDEX_FILE) so the user's index, working tree,
// and stash list are untouched. Works with or without an initial commit — in
// no-HEAD repos the snapshot is a parentless root commit so the same restore
// procedure applies.
//
// Returns: { stashHash, refName, isEmpty, noHead }.
//   stashHash  snapshot commit sha, or null when isEmpty.
//   refName    pinned ref name, or null when isEmpty.
//   isEmpty    true when there were no dirty / untracked / staged paths.
//   noHead     true when the repo has no initial commit (recovery semantics
//              differ slightly — see commands/once.md / commands/loop.md).
export async function createPreIterStash(cwd, runId, iter) {
  // 0. HEAD probe. Non-zero exit means either "not a git repo" (throw) or
  //    "no initial commit yet" (proceed with noHead=true). Does NOT short-
  //    circuit — even in no-HEAD repos we still build a snapshot so the
  //    recovery procedure can undo Codex modifications to already-staged files.
  const headProbe = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd });
  if (headProbe.exitCode !== 0 && /not a git repository/i.test(headProbe.stderr)) {
    throw new NotAGitRepoError(cwd);
  }
  const noHead = headProbe.exitCode !== 0;
  const headSha = noHead ? null : headProbe.stdout.trim();
  const refName = `refs/codexgrill/${runId}/iter-${iter}-pre`;

  // 1. Cheap "nothing to capture" short-circuit.
  const dirty = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd },
  );
  if (dirty.exitCode !== 0) {
    if (/not a git repository/i.test(dirty.stderr)) {
      throw new NotAGitRepoError(cwd);
    }
    throw new Error(`git status failed (${dirty.exitCode}): ${dirty.stderr.trim() || 'no stderr'}`);
  }
  if (!dirty.stdout) {
    return { stashHash: null, refName: null, isEmpty: true, noHead };
  }

  // 2. Build the snapshot tree in a TEMP index so the user's index isn't touched.
  const tmpIndex = path.join(os.tmpdir(), `codexgrill-idx-${runId}-${iter}-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    if (!noHead) {
      // Seed temp index from HEAD so deletions register as deletions.
      await runGitOrThrow(['read-tree', 'HEAD'], { cwd, env });
    }
    // Stage tracked-dirty + untracked into the temp index.
    await runGitOrThrow(['add', '-A'], { cwd, env });
    const treeSha = (await runGitOrThrow(['write-tree'], { cwd, env })).stdout.trim();

    // commit-tree: with HEAD → parent=HEAD; without HEAD → parentless root commit.
    const commitArgs = ['commit-tree', treeSha];
    if (headSha) commitArgs.push('-p', headSha);
    commitArgs.push('-m', `codexgrill pre-iter ${iter}${noHead ? ' (no HEAD)' : ''}`);
    const stashSha = (await runGitOrThrow(commitArgs, { cwd, env })).stdout.trim();

    // Pin BEFORE deleting the temp index so the commit is reachable.
    await runGitOrThrow(['update-ref', refName, stashSha], { cwd });
    return { stashHash: stashSha, refName, isEmpty: false, noHead };
  } finally {
    await fs.unlink(tmpIndex).catch(() => { });
  }
}
