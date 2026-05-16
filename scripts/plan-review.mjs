#!/usr/bin/env node
// codexgrill plan-review wrapper.
//
// Drives a single `codex exec` review iteration. Once-mode and loop-mode each
// shell out to this script per iteration; loop-mode pins the thread by passing
// the captured thread_id back via --resume-thread-id.
//
// CLI:
//   node plan-review.mjs --plan <path> --run-dir <path> [--mode fresh|resume]
//                        [--resume-thread-id <uuid>] [--iter <N>]
//                        [--effort <level>] [--model <name>]
//                        [--refuted-log <path>] [--cwd <path>] [--ephemeral]
//
// Exit codes:
//   0   success — Codex's final message on stdout
//   1   codex exec failed (turn.failed, non-zero exit, network, auth)
//   2   working tree changed (could be Codex or user)
//   3   codex CLI not installed
//   4   not a git working tree (containment check requires git)
//   64  usage error (missing/invalid flag)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertCodexInstalled,
  validateEffort,
  runCodexExec,
  snapshotWorkingTree,
  assertContainment,
  createPreIterStash,
  CodexNotInstalledError,
  CodexExecFailedError,
  WorkingTreeChangedError,
  NotAGitRepoError,
  GitUnavailableError,
  InvalidEffortError,
} from './lib/codex-exec.mjs';

const PROMPT_TEMPLATE = `<task>
You are a senior staff engineer doing a strict pre-implementation review of a
proposed plan against the current codebase. The plan has NOT been implemented
yet — you are sanity-checking it before any code is written. Enumerate every
file, function, package, env var, migration, endpoint, and behavior change it
touches, then verify each against the real code in this repository.
</task>

<action_safety>
This is a READ-ONLY review. You have unrestricted sandbox/network access for
the practical purpose of running read commands (grep, git log/diff/status,
file readers) and web search. BUT YOU MUST NOT modify, create, or delete any
file. Do not apply patches. Do not propose diffs in patch format. Do not run
build commands, install packages, or run anything destructive. The wrapper
hashes the working tree before and after this run; ANY file modification will
cause the entire run to be REJECTED and your work discarded.
</action_safety>

<grounding_rules>
Ground every claim in code you read or external sources you cite. Do not
present inferences as facts; label hypotheses clearly. Every code claim cites
\`path:line\`. Every external claim cites a URL (prefer primary sources: vendor
docs, package registries, advisory databases).
</grounding_rules>

<missing_context_gating>
Do not guess missing repository facts. If required context is absent, retrieve
it with tools (grep, file readers, web search) or state exactly what remains
unknown.
</missing_context_gating>

<dig_deeper_nudge>
After you find the first plausible issue, check for second-order failures,
empty-state behavior, retries, stale state, rollback paths, ordering risks,
concurrency, migration safety, and security implications before finalizing.
</dig_deeper_nudge>

<structured_output_contract>
First line: one-word verdict — SOUND, NEEDS REVISION, or FUNDAMENTAL ISSUES.
Then bulleted findings, highest-severity first:
  - [severity] short issue — \`path:line\` (or URL) — concrete correction.
  - severity ∈ {critical, important, minor}.
Optional sections (omit if empty):
  - "What to add" — things the plan should include but doesn't.
  - "What to remove" — things in the plan that are wrong or unnecessary.
  - "External refs checked" — URLs consulted.
Keep the response compact. No long preambles. No closing summary.
</structured_output_contract>

<plan_under_review>
`;

const PROMPT_TEMPLATE_TAIL = `
</plan_under_review>
`;

function parseArgs(argv) {
  const out = {
    plan: null,
    runDir: null,
    mode: 'fresh',
    resumeThreadId: null,
    iter: 1,
    effort: null,
    model: null,
    refutedLog: null,
    cwd: null,
    ephemeral: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--plan': out.plan = next(); break;
      case '--run-dir': out.runDir = next(); break;
      case '--mode': out.mode = next(); break;
      case '--resume-thread-id': out.resumeThreadId = next(); break;
      case '--iter': out.iter = parseInt(next(), 10); break;
      case '--effort': out.effort = next(); break;
      case '--model': out.model = next(); break;
      case '--refuted-log': out.refutedLog = next(); break;
      case '--cwd': out.cwd = next(); break;
      case '--ephemeral': out.ephemeral = true; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        process.stderr.write(`unknown argument: ${a}\n`);
        process.exit(64);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
`Usage:
  plan-review.mjs --plan <path> --run-dir <path> [--mode fresh|resume]
                  [--resume-thread-id <uuid>] [--iter <N>]
                  [--effort <level>] [--model <name>]
                  [--refuted-log <path>] [--cwd <path>] [--ephemeral]

Flags:
  --plan <path>            Path to the plan markdown file (required).
  --run-dir <path>         Directory for prompt/final/jsonl/result artifacts (required).
  --mode <m>               'fresh' (default) or 'resume'.
  --resume-thread-id <id>  Thread UUID captured from iter 1 (required when mode=resume).
  --iter <N>               Iteration number (default 1). Controls artifact naming.
  --effort <level>         Reasoning effort: none|minimal|low|medium|high|xhigh.
  --model <name>           Override the model for this run.
  --refuted-log <path>     Prepended verbatim to the prompt if non-empty.
  --cwd <path>             Working directory passed to codex via --cd (default: process cwd).
  --ephemeral              Pass --ephemeral to codex (skips session persistence).
                           Once-mode only — never use in loop-mode iter 1.

Exit codes:
  0   success
  1   codex exec failed
  2   working tree changed (could be Codex or user)
  3   codex CLI not installed
  4   not a git working tree
  64  usage error
`);
}

function resolveFromCwd(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function readIfExists(p) {
  if (!p) return '';
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function buildFreshPrompt({ planPath, refutedLogPath }) {
  const planBody = await fs.readFile(planPath, 'utf8');
  const refuted = await readIfExists(refutedLogPath);
  const parts = [];
  if (refuted.trim().length > 0) {
    parts.push(refuted.endsWith('\n') ? refuted : refuted + '\n');
    parts.push('\n');
  }
  parts.push(PROMPT_TEMPLATE);
  parts.push(planBody);
  parts.push(PROMPT_TEMPLATE_TAIL);
  return parts.join('');
}

async function buildResumePrompt({ planPath, refutedLogPath }) {
  const refuted = await readIfExists(refutedLogPath);
  const parts = [];
  parts.push(
`I have applied the CONFIRMED findings from your prior review and edited the
plan accordingly. Please re-review the plan focusing on the changes and any
new issues. The plan path is \`${planPath}\` (you have file-read access from
your earlier turn — re-read it if needed).

Same READ-ONLY contract as before: do not modify, create, or delete files.
Same output contract: first-line verdict (SOUND / NEEDS REVISION / FUNDAMENTAL
ISSUES), bulleted findings with severity + \`path:line\` / URL citations,
optional "What to add" / "What to remove" / "External refs checked" sections.
`);
  if (refuted.trim().length > 0) {
    parts.push('\n');
    parts.push(refuted.endsWith('\n') ? refuted : refuted + '\n');
  }
  return parts.join('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.plan) {
    process.stderr.write('--plan <path> is required\n');
    process.exit(64);
  }
  if (!opts.runDir) {
    process.stderr.write('--run-dir <path> is required\n');
    process.exit(64);
  }
  if (opts.mode !== 'fresh' && opts.mode !== 'resume') {
    process.stderr.write(`--mode must be 'fresh' or 'resume' (got: ${opts.mode})\n`);
    process.exit(64);
  }
  if (opts.mode === 'resume' && !opts.resumeThreadId) {
    process.stderr.write(`--resume-thread-id <uuid> is required when --mode=resume\n`);
    process.exit(64);
  }
  if (!Number.isInteger(opts.iter) || opts.iter < 1) {
    process.stderr.write(`--iter must be a positive integer (got: ${opts.iter})\n`);
    process.exit(64);
  }
  if (opts.effort != null) {
    try {
      validateEffort(opts.effort);
    } catch (err) {
      if (err instanceof InvalidEffortError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(64);
      }
      throw err;
    }
  }

  const planPath = resolveFromCwd(opts.plan);
  try {
    await fs.access(planPath);
  } catch {
    process.stderr.write(`plan not found: ${opts.plan}\n`);
    process.exit(64);
  }

  const runDir = resolveFromCwd(opts.runDir);
  await fs.mkdir(runDir, { recursive: true });

  try {
    await assertCodexInstalled();
  } catch (err) {
    if (err instanceof CodexNotInstalledError) {
      process.stderr.write(`${err.message}\n`);
      process.stderr.write(`Install the Codex CLI: npm install -g @openai/codex (then run: codex login)\n`);
      process.exit(3);
    }
    throw err;
  }

  const cwd = opts.cwd ? resolveFromCwd(opts.cwd) : process.cwd();

  const refutedLogPath = opts.refutedLog ? resolveFromCwd(opts.refutedLog) : null;

  const promptText = opts.mode === 'fresh'
    ? await buildFreshPrompt({ planPath, refutedLogPath })
    : await buildResumePrompt({ planPath, refutedLogPath });

  let snapshotBefore;
  try {
    snapshotBefore = await snapshotWorkingTree(cwd);
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof GitUnavailableError) {
      process.stderr.write(`NOT_A_GIT_REPO: containment check requires a git working tree (${err.message})\n`);
      process.exit(4);
    }
    throw err;
  }

  const runId = path.basename(runDir);
  let preIterStash;
  try {
    preIterStash = await createPreIterStash(cwd, runId, opts.iter);
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof GitUnavailableError) {
      process.stderr.write(`NOT_A_GIT_REPO: containment check requires a git working tree (${err.message})\n`);
      process.exit(4);
    }
    throw err;
  }

  // once-mode (ephemeral fresh iter 1) → bare filenames; loop-mode → iter suffix.
  const onceNaming = opts.iter === 1 && opts.mode === 'fresh' && opts.ephemeral;
  const promptFileName = onceNaming ? 'prompt.txt' : `prompt-iter${opts.iter}.txt`;
  const finalFileName = onceNaming ? 'final.txt' : `final-iter${opts.iter}.txt`;
  const jsonlFileName = onceNaming ? 'codex.jsonl' : `codex-iter${opts.iter}.jsonl`;

  let execResult;
  try {
    execResult = await runCodexExec({
      promptText,
      mode: opts.mode,
      resumeThreadId: opts.resumeThreadId,
      runDir,
      iter: opts.iter,
      cwd,
      effort: opts.effort,
      model: opts.model,
      ephemeral: opts.ephemeral,
      promptFileName,
      finalFileName,
      jsonlFileName,
    });
  } catch (err) {
    if (err instanceof CodexNotInstalledError) {
      process.stderr.write(`${err.message}\n`);
      process.stderr.write(`Install the Codex CLI: npm install -g @openai/codex (then run: codex login)\n`);
      process.exit(3);
    }
    if (err instanceof CodexExecFailedError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  let snapshotAfter;
  try {
    snapshotAfter = await snapshotWorkingTree(cwd);
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof GitUnavailableError) {
      process.stderr.write(`NOT_A_GIT_REPO: containment check requires a git working tree (${err.message})\n`);
      process.exit(4);
    }
    throw err;
  }

  // Filter snapshots so the wrapper's own run-dir artifacts (prompt.txt,
  // codex.jsonl, final.txt, result.json) never trip containment — they're
  // created by us between snapshotBefore and snapshotAfter. The check only
  // fires for changes outside the run-dir.
  const runDirRel = path.relative(cwd, runDir).split(path.sep).join('/');
  const filterRunDir = (snap) => {
    const out = {};
    for (const [p, h] of Object.entries(snap)) {
      const normalized = p.split(path.sep).join('/');
      if (runDirRel && (normalized === runDirRel || normalized.startsWith(runDirRel + '/'))) continue;
      out[p] = h;
    }
    return out;
  };
  const beforeFiltered = filterRunDir(snapshotBefore);
  const afterFiltered = filterRunDir(snapshotAfter);

  let containmentExit = 0;
  let changedFiles = [];
  try {
    assertContainment(beforeFiltered, afterFiltered);
  } catch (err) {
    if (err instanceof WorkingTreeChangedError) {
      changedFiles = err.changedFiles;
      process.stderr.write(`WORKING_TREE_CHANGED:${err.changedFiles.join(',')}\n`);
      containmentExit = 2;
    } else {
      throw err;
    }
  }

  const resultFileName = onceNaming ? 'result.json' : `result-iter${opts.iter}.json`;
  const resultPath = path.join(runDir, resultFileName);
  const resultPayload = {
    mode: opts.mode,
    iter: opts.iter,
    threadId: execResult.threadId,
    exitCode: execResult.exitCode,
    signal: execResult.signal,
    errorReason: execResult.errorReason,
    usage: execResult.usage,
    promptPath: execResult.promptPath,
    finalMessagePath: execResult.finalPath,
    jsonlPath: execResult.jsonlPath,
    preIterStash: {
      hash: preIterStash.stashHash,
      refName: preIterStash.refName,
      isEmpty: preIterStash.isEmpty,
      noHead: preIterStash.noHead === true,
    },
    workingTreeChanged: containmentExit === 2,
    changedFiles,
  };
  await fs.writeFile(resultPath, JSON.stringify(resultPayload, null, 2), 'utf8');

  if (containmentExit !== 0) {
    process.exit(containmentExit);
  }

  if (execResult.errorReason) {
    process.stderr.write(`codex turn failed: ${execResult.errorReason}\n`);
    process.exit(1);
  }

  if (execResult.exitCode !== 0) {
    const tail = execResult.stderr ? `: ${execResult.stderr.trim().split('\n').slice(-5).join(' | ')}` : '';
    process.stderr.write(`codex exec exited ${execResult.exitCode}${execResult.signal ? ` (signal=${execResult.signal})` : ''}${tail}\n`);
    process.exit(1);
  }

  // Emit the final review to stdout verbatim.
  process.stdout.write(execResult.finalMessage);
  if (!execResult.finalMessage.endsWith('\n')) process.stdout.write('\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`unhandled error: ${err?.stack || err}\n`);
  process.exit(1);
});
