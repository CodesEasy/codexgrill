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
import path from 'node:path';
import readline from 'node:readline';

export const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// Paths that auto-mutate while the user has an IDE / editor open. We skip
// these in the working-tree containment check so they never trip a false
// positive. Anything not listed here that changes still triggers the
// neutral "was this you or Codex?" prompt — the command files offer to
// add such paths to .gitignore.
export const DEFAULT_IGNORED_PATTERNS = [
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

// On Windows the `codex` binary installed by npm is `codex.cmd` (a batch shim).
// Node's `spawn` does NOT search PATHEXT, so it can't find .cmd files directly —
// we have to delegate the PATH lookup to cmd.exe via `shell: true`. Mirrors the
// official @openai/codex plugin's process.mjs.
const CODEX_SPAWN_OPTS = {
  shell: process.platform === 'win32' ? (process.env.SHELL || true) : false,
  windowsHide: true,
};

// With shell:true on Windows, args are concatenated into a single command string
// without escaping (Node DEP0190). Wrap anything containing whitespace or cmd
// metachars in double quotes so paths like `C:\My Project\...` survive.
function escapeCodexArgs(args) {
  if (process.platform !== 'win32') return args;
  return args.map((a) => {
    const s = String(a);
    if (!/[\s"&|<>^()%!`]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  });
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
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('codex', escapeCodexArgs(['--version']), { stdio: ['ignore', 'pipe', 'pipe'], ...CODEX_SPAWN_OPTS });
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
    '--cd', toCodexPath(cwd),
    '-o', toCodexPath(finalPath),
  );
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
      child = spawn('codex', escapeCodexArgs(args), { stdio: ['pipe', 'pipe', 'pipe'], ...CODEX_SPAWN_OPTS });
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
      child = spawn('git', ['status', '--porcelain=v1', '-z'], { cwd });
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

// Capture the dirty + untracked working-tree state in a commit without
// modifying the working tree or the stash list. Pin it with a permanent ref
// so it survives gc and can be applied later by the user for revert.
// Returns: { stashHash: string|null, refName: string|null, isEmpty: boolean, noHead?: boolean }.
// stashHash is null when the working tree is clean (nothing to stash) OR when
// the repo has no initial commit (HEAD missing). The noHead flag distinguishes
// the second case so the exit-2 handler can tell the user revert isn't available.
export async function createPreIterStash(cwd, runId, iter) {
  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['stash', 'create', '-u'], { cwd });
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
      if (code !== 0) {
        if (/not a git repository/i.test(stderr)) {
          reject(new NotAGitRepoError(cwd));
          return;
        }
        // Fresh repo with no commits yet — `git stash create` needs HEAD.
        // Skip the stash cleanly; the run continues, but revert won't be available.
        if (/do not have the initial commit|bad revision .?HEAD/i.test(stderr)) {
          resolve({ hash: null, noHead: true });
          return;
        }
        reject(new Error(`git stash create failed (${code}): ${stderr.trim() || 'no stderr'}`));
        return;
      }
      resolve({ hash: stdout.trim() || null, noHead: false });
    });
  });

  if (result.noHead) {
    return { stashHash: null, refName: null, isEmpty: true, noHead: true };
  }
  if (!result.hash) {
    return { stashHash: null, refName: null, isEmpty: true };
  }
  const stashHash = result.hash;

  const refName = `refs/codexgrill/${runId}/iter-${iter}-pre`;
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['update-ref', refName, stashHash], { cwd });
    } catch (err) {
      reject(new GitUnavailableError(err.message));
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => reject(new GitUnavailableError(err.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git update-ref ${refName} failed (${code}): ${stderr.trim() || 'no stderr'}`));
        return;
      }
      resolve();
    });
  });

  return { stashHash, refName, isEmpty: false };
}
