#!/usr/bin/env node
// codexgrill security-audit wrapper.
//
// Sibling of plan-review.mjs. Drives a single `codex exec` iteration in
// validate-and-extend mode: Claude has already written a security plan at
// PLAN_PATH; Codex reads the plan, validates each finding against the real
// code, and extends with vulnerabilities Claude missed.
//
// Differs from plan-review.mjs in three places:
//   1. Repeatable `--scope <path>` flag (collected into a scopes[] array).
//   2. Security-focused prompt body (XML blocks per gpt-5-4-prompting).
//   3. Explicit pre/post SHA256 hash of PLAN_PATH on top of the git-status
//      snapshot — because PLAN_PATH lives under .claude/plans/ which is
//      gitignored, the git-status containment check does NOT see mutations
//      there. The extra hash closes that gap.
//
// CLI:
//   node security-audit.mjs --plan <path> --run-dir <path>
//                           --scope <path> [--scope <path> ...]
//                           [--mode fresh|resume] [--resume-thread-id <uuid>]
//                           [--iter <N>] [--effort <level>] [--model <name>]
//                           [--refuted-log <path>] [--cwd <path>] [--ephemeral]
//
// Exit codes (identical to plan-review.mjs):
//   0   success — Codex's final message on stdout
//   1   codex exec failed (turn.failed, non-zero exit, network, auth)
//   2   working tree changed (could be Codex or user) — may include PLAN_PATH
//   3   codex CLI not installed
//   4   not a git working tree (containment check requires git)
//   64  usage error (missing/invalid flag)

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertCodexInstalled,
  validateEffort,
  runCodexExec,
  snapshotWorkingTree,
  assertContainment,
  createPreIterStash,
  matchesIgnorePattern,
  diffNoIndex,
  gitRepoRoot,
  CodexNotInstalledError,
  CodexExecFailedError,
  WorkingTreeChangedError,
  NotAGitRepoError,
  GitUnavailableError,
  InvalidEffortError,
} from './lib/codex-exec.mjs';

// Same pathological-diff threshold as plan-review.mjs: when the diff would be
// bigger than 80% of the plan body, the diff is no longer cheaper than
// inlining the full plan. Fall back for completeness/accuracy.
const PATHOLOGICAL_DIFF_RATIO = 0.8;

const FRESH_PROMPT_TEMPLATE_HEAD = `<task>
You are a senior application-security engineer. The user has written an initial
security audit plan for a codebase. Your job is to validate every finding in
that plan against the real code and external advisory sources, then EXTEND the
plan with any vulnerabilities they missed.

The plan author already did a first pass. You are the adversarial second
opinion — confirm what holds, refute what doesn't, and surface what's missing.
</task>

<action_safety>
This is a READ-ONLY review. You have unrestricted sandbox/network access for
the practical purpose of running read commands (grep, git log/diff/status,
file readers) and web search. BUT YOU MUST NOT modify, create, or delete any
file — INCLUDING the plan file itself. Do not apply patches. Do not propose
diffs in patch format. Do not run build commands, install packages, or run
anything destructive. The wrapper hashes both the working tree AND the plan
file before and after this run; ANY file modification will cause the entire
run to be REJECTED and your work discarded.
</action_safety>

<grounding_rules>
Ground every claim in code you read or external sources you cite. Do not
present inferences as facts; label hypotheses clearly.
- Cite \`path:line\` for every code finding.
- Cite CWE-XXXX where applicable.
- For every dependency finding, cite the specific CVE-YYYY-ZZZZ or GHSA-XXXX
  identifier and a primary-source URL (GitHub Security Advisories, NVD,
  vendor advisory). No aggregators.
- Distinguish CONFIRMED (verified against the code/source) from INFERRED
  (pattern-matched but unverified) — never treat inferred as confirmed.
- If you cannot read a file you'd need to verify a claim, mark it
  UNVERIFIABLE and say which file is missing.
</grounding_rules>

<missing_context_gating>
Do not guess missing repository facts. If required context is absent,
retrieve it with tools (grep, file readers, web search) or state exactly
what remains unknown.
</missing_context_gating>

<dig_deeper_nudge>
After validating each finding, check for second-order issues the plan author
may have missed: chained vulnerabilities, defense-in-depth gaps, transitive
dependency risks, configuration drift, and any issue category not covered by
the plan's existing findings.
</dig_deeper_nudge>

<structured_output_contract>
First line: one-word verdict — AUDIT CLEAN, NEEDS REVISION, or CRITICAL ISSUES.

Then two sections (omit either if empty):

## Validation of plan's findings
For each finding in the plan, one entry:
- [severity] <finding summary>
  - Verdict: CONFIRMED | REFUTED | EXTENDED — <one-line reason with cite>
  - (if EXTENDED) Additional evidence: <new \`path:line\` or new advisory URL>
  - (if REFUTED) Counter-evidence: <\`path:line\` showing it's not vulnerable>

## New findings the plan missed
For each new vuln, one entry:
- [severity] <summary>
  - Location: \`path/to/file.ext:LINE\` (or \`<package>@<version>\` for deps)
  - CWE / CVE / GHSA: <id + primary URL>
  - Evidence: <code excerpt or registry link>
  - Recommended fix: <concrete code/config change>

Optional trailing section:
## External refs checked
- <URLs consulted>

Keep the response compact. No long preambles. No closing summary.
</structured_output_contract>

<verification_loop>
Before stating the verdict AUDIT CLEAN, re-check that every CONFIRMED finding
in your validation section actually has a concrete fix recommendation in the
plan. If any CONFIRMED finding lacks a fix or has a vague one, the verdict
must be at least NEEDS REVISION.
</verification_loop>

`;

function buildScopeBlock(scopes) {
  if (!scopes || scopes.length === 0) return '<audit_scope>.</audit_scope>\n\n';
  const lines = scopes.map((s) => `  - ${s}`).join('\n');
  return `<audit_scope>\n${lines}\n</audit_scope>\n\n`;
}

function buildPlanPathBlock(absolutePlanPath) {
  return `<plan_file_path>${absolutePlanPath}</plan_file_path>\n\n`;
}

const PLAN_OPEN_TAG = '<plan_under_review>\n';
const PLAN_CLOSE_TAG = '\n</plan_under_review>\n';

const RESUME_PROMPT_PREFIX = `I have applied the CONFIRMED findings from your prior review and edited the
security audit plan accordingly. Below is the FULL updated plan — review the
current text, not your memory of the earlier version. Focus on whether the
edits addressed the prior findings and on any new issues that the edits
introduced or that you spot on a fresh pass.

Same READ-ONLY contract as before: do not modify, create, or delete files —
including the plan file. Same output contract: first-line verdict
(AUDIT CLEAN / NEEDS REVISION / CRITICAL ISSUES), then "Validation of plan's
findings" and "New findings the plan missed" sections.

`;

const RESUME_DIFF_PROMPT_PREFIX = `I have applied the CONFIRMED findings from your prior review and edited the
security audit plan. To keep this turn small, I am sending you the UNIFIED
DIFF of the plan since your last review, not the whole plan body. The full
updated plan lives on disk at the path below — use your file-reading tools to
load any section you need surrounding context for before issuing a finding.
Do NOT rely on your memory of the earlier plan text; load the current file
when in doubt.

Same READ-ONLY contract as before: do not modify, create, or delete files —
including the plan file. Same output contract: first-line verdict
(AUDIT CLEAN / NEEDS REVISION / CRITICAL ISSUES), then "Validation of plan's
findings" and "New findings the plan missed" sections.

Focus on whether the edits addressed prior findings and on any new issues the
edits introduced. If a prior finding's region is unchanged in the diff, state
explicitly whether you are re-raising it or withdrawing it.

`;

const RESUME_NOCHANGE_PROMPT_PREFIX = `The plan is byte-identical to what you reviewed in the prior iteration — no
edits were applied. Only the previously-refuted log (below, if any) has
changed. Please re-confirm whether your prior findings still hold against the
current plan at the path below, or withdraw any that you now reconsider.
Same READ-ONLY + output contract as before.

`;

function parseArgs(argv) {
  const out = {
    plan: null,
    runDir: null,
    scopes: [],
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
      case '--scope': out.scopes.push(next()); break;
      case '--mode': out.mode = next(); break;
      case '--resume-thread-id': out.resumeThreadId = next(); break;
      case '--iter': {
        const raw = next();
        if (!/^\d+$/.test(raw)) {
          process.stderr.write(`--iter must be a positive integer (got: ${raw})\n`);
          process.exit(64);
        }
        out.iter = parseInt(raw, 10);
        break;
      }
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
  security-audit.mjs --plan <path> --run-dir <path>
                     --scope <path> [--scope <path> ...]
                     [--mode fresh|resume] [--resume-thread-id <uuid>]
                     [--iter <N>] [--effort <level>] [--model <name>]
                     [--refuted-log <path>] [--cwd <path>] [--ephemeral]

Flags:
  --plan <path>            Path to the security audit plan markdown file (required).
  --run-dir <path>         Directory for prompt/final/jsonl/result artifacts (required).
  --scope <path>           Audit scope path. Repeatable. Defaults to ['.'] if none given.
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
  2   working tree (or plan file) changed
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

async function sha256OfFile(p) {
  const buf = await fs.readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function buildFreshPrompt({ planPath, refutedLogPath, scopes, absolutePlanPath }) {
  const planBody = await fs.readFile(planPath, 'utf8');
  const refuted = await readIfExists(refutedLogPath);
  const parts = [];
  if (refuted.trim().length > 0) {
    parts.push(refuted.endsWith('\n') ? refuted : refuted + '\n');
    parts.push('\n');
  }
  parts.push(FRESH_PROMPT_TEMPLATE_HEAD);
  parts.push(buildScopeBlock(scopes));
  parts.push(buildPlanPathBlock(absolutePlanPath));
  parts.push(PLAN_OPEN_TAG);
  parts.push(planBody);
  parts.push(PLAN_CLOSE_TAG);
  return parts.join('');
}

async function buildResumePromptFull({ planPath, refutedLogPath }) {
  const planBody = await fs.readFile(planPath, 'utf8');
  const refuted = await readIfExists(refutedLogPath);
  const parts = [];
  parts.push(RESUME_PROMPT_PREFIX);
  parts.push(PLAN_OPEN_TAG);
  parts.push(planBody);
  parts.push(PLAN_CLOSE_TAG);
  if (refuted.trim().length > 0) {
    parts.push('\n');
    parts.push(refuted.endsWith('\n') ? refuted : refuted + '\n');
  }
  return parts.join('');
}

function buildResumePromptDiff({ absolutePlanPath, refutedLog, diffOutput, contextLines = 10 }) {
  const parts = [];
  parts.push(RESUME_DIFF_PROMPT_PREFIX);
  parts.push(`<current_plan_path>\n${absolutePlanPath}\n</current_plan_path>\n`);
  if (refutedLog && refutedLog.trim().length > 0) {
    parts.push(`\n<previously_refuted>\n${refutedLog.endsWith('\n') ? refutedLog : refutedLog + '\n'}</previously_refuted>\n`);
  }
  parts.push(`\n<plan_diff format="unified" context_lines="${contextLines}">\n${diffOutput.endsWith('\n') ? diffOutput : diffOutput + '\n'}</plan_diff>\n`);
  return parts.join('');
}

function buildResumePromptNoChange({ absolutePlanPath, refutedLog }) {
  const parts = [];
  parts.push(RESUME_NOCHANGE_PROMPT_PREFIX);
  parts.push(`<current_plan_path>${absolutePlanPath}</current_plan_path>\n`);
  if (refutedLog && refutedLog.trim().length > 0) {
    parts.push(`\n<previously_refuted>\n${refutedLog.endsWith('\n') ? refutedLog : refutedLog + '\n'}</previously_refuted>\n`);
  }
  return parts.join('');
}

function parseDiffStats(diffOutput) {
  let addedLines = 0;
  let removedLines = 0;
  const lines = String(diffOutput || '').split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) addedLines++;
    else if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines };
}

async function writePlanSnapshot(runDir, iter, planPath) {
  const snapshotPath = path.join(runDir, `plan-snapshot-iter${iter}.md`);
  await fs.copyFile(planPath, snapshotPath);
  return snapshotPath;
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
  if (opts.ephemeral && opts.mode === 'resume') {
    process.stderr.write(`--ephemeral is only valid with --mode fresh (codex resume requires session persistence)\n`);
    process.exit(64);
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

  // Default scope when none provided.
  const scopes = opts.scopes.length > 0 ? opts.scopes : ['.'];

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

  // Resume-mode dispatch artifacts.
  let resumePromptMode = null;     // 'diff' | 'full-plan-fallback' | 'no-change' (null for fresh)
  let planDiffPath = null;
  let planDiffStats = null;

  let promptText;
  if (opts.mode === 'fresh') {
    promptText = await buildFreshPrompt({
      planPath,
      refutedLogPath,
      scopes,
      absolutePlanPath: planPath,
    });
  } else {
    const priorSnapshotPath = path.join(runDir, `plan-snapshot-iter${opts.iter - 1}.md`);
    let priorSnapshotExists = false;
    try {
      await fs.access(priorSnapshotPath);
      priorSnapshotExists = true;
    } catch { /* missing → fallback */ }

    const refutedLog = await readIfExists(refutedLogPath);

    const fallbackToFullPlan = async (reason) => {
      process.stderr.write(`[wrapper] resume: ${reason}, falling back to full-plan inline\n`);
      resumePromptMode = 'full-plan-fallback';
      promptText = await buildResumePromptFull({ planPath, refutedLogPath });
    };

    if (!priorSnapshotExists) {
      await fallbackToFullPlan('prior snapshot missing');
    } else {
      let diffResult;
      try {
        diffResult = await diffNoIndex(priorSnapshotPath, planPath, { cwd });
      } catch (err) {
        if (err instanceof GitUnavailableError) {
          await fallbackToFullPlan(`git diff unavailable (${err.message})`);
        } else {
          await fallbackToFullPlan(`git diff failed (${err.message})`);
        }
        diffResult = null;
      }

      if (diffResult) {
        const diffOutput = diffResult.stdout;
        const diffBytes = Buffer.byteLength(diffOutput, 'utf8');
        const planBytes = (await fs.stat(planPath)).size;

        if (diffResult.exitCode === 0) {
          // Exit 0 = files identical — empty diff branch.
          resumePromptMode = 'no-change';
          process.stderr.write(`[wrapper] resume mode: no-change (plan=${planBytes}b, diff=0b)\n`);
          promptText = buildResumePromptNoChange({
            absolutePlanPath: planPath,
            refutedLog,
          });
        } else if (diffOutput.length === 0) {
          const stderrTail = (diffResult.stderr || '').trim().split('\n').slice(-2).join(' | ') || '(no stderr)';
          await fallbackToFullPlan(`empty diff body despite exit 1 (${stderrTail})`);
        } else if (diffBytes > planBytes * PATHOLOGICAL_DIFF_RATIO) {
          const pct = Math.round((diffBytes / planBytes) * 100);
          await fallbackToFullPlan(`diff too large (${pct}% of plan)`);
        } else {
          resumePromptMode = 'diff';
          const stats = parseDiffStats(diffOutput);
          planDiffStats = { ...stats, planBytes, diffBytes };
          const candidateDiffPath = path.join(runDir, `plan-diff-iter${opts.iter}.diff`);
          try {
            await fs.writeFile(candidateDiffPath, diffOutput, 'utf8');
            planDiffPath = candidateDiffPath;
          } catch (err) {
            process.stderr.write(`[wrapper] failed to write plan-diff-iter${opts.iter}.diff: ${err.message} (continuing with in-memory diff)\n`);
          }
          process.stderr.write(
            `[wrapper] resume mode: diff (added=${stats.addedLines}, removed=${stats.removedLines}, plan=${planBytes}b, diff=${diffBytes}b)\n`,
          );
          promptText = buildResumePromptDiff({
            absolutePlanPath: planPath,
            refutedLog,
            diffOutput,
          });
        }
      }
    }
  }

  // Working-tree snapshot BEFORE Codex runs.
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

  // Explicit PLAN_PATH SHA256 BEFORE Codex runs. Defense-in-depth: the plan
  // lives under .claude/plans/ which is gitignored, so snapshotWorkingTree
  // (git status-based) won't detect mutations to it.
  let planHashBefore;
  try {
    planHashBefore = await sha256OfFile(planPath);
  } catch (err) {
    process.stderr.write(`failed to hash plan file before run: ${err.message}\n`);
    process.exit(1);
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

  // Working-tree snapshot AFTER Codex runs.
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

  // Explicit PLAN_PATH SHA256 AFTER Codex runs.
  let planHashAfter;
  try {
    planHashAfter = await sha256OfFile(planPath);
  } catch (err) {
    process.stderr.write(`failed to hash plan file after run: ${err.message}\n`);
    process.exit(1);
  }

  // Filter snapshots so two classes of paths never trip containment:
  //   1. The wrapper's own run-dir artifacts (created between snapshots).
  //   2. Auto-mutating IDE/OS state.
  // Anchor runDirRel against the git repo root (matching the namespace of
  // `git status --porcelain` output) — `path.relative(cwd, ...)` would be
  // cwd-anchored and would miss matches when invoked from a subdirectory.
  let repoRoot;
  try {
    repoRoot = await gitRepoRoot(cwd);
  } catch (err) {
    if (err instanceof NotAGitRepoError || err instanceof GitUnavailableError) {
      process.stderr.write(`NOT_A_GIT_REPO: containment check requires a git working tree (${err.message})\n`);
      process.exit(4);
    }
    throw err;
  }
  const runDirRel = path.relative(repoRoot, runDir).split(path.sep).join('/');
  const filterSnapshot = (snap) => {
    const out = {};
    for (const [p, h] of Object.entries(snap)) {
      const normalized = p.split(path.sep).join('/');
      if (runDirRel && (normalized === runDirRel || normalized.startsWith(runDirRel + '/'))) continue;
      if (matchesIgnorePattern(normalized)) continue;
      out[p] = h;
    }
    return out;
  };
  const beforeFiltered = filterSnapshot(snapshotBefore);
  const afterFiltered = filterSnapshot(snapshotAfter);

  let containmentExit = 0;
  let changedFiles = [];
  try {
    assertContainment(beforeFiltered, afterFiltered);
  } catch (err) {
    if (err instanceof WorkingTreeChangedError) {
      changedFiles = err.changedFiles;
      containmentExit = 2;
    } else {
      throw err;
    }
  }

  // Additional check: plan file SHA256. If it mutated, surface as a containment
  // breach even though git-status would miss it.
  let planFileChanged = false;
  if (planHashBefore !== planHashAfter) {
    planFileChanged = true;
    const planPathRel = path.relative(cwd, planPath).split(path.sep).join('/');
    if (!changedFiles.includes(planPathRel)) {
      changedFiles = [...changedFiles, planPathRel];
    }
    containmentExit = 2;
  }

  if (containmentExit === 2) {
    process.stderr.write(`WORKING_TREE_CHANGED:${changedFiles.join(',')}\n`);
  }

  // Snapshot the plan body for next iter's diff prompt. Only when the iter
  // succeeded cleanly (no containment breach, no codex error). Loop-mode only.
  const willWriteSnapshot = !onceNaming
    && containmentExit === 0
    && !execResult.errorReason
    && execResult.exitCode === 0;

  let actualSnapshotPath = null;
  if (willWriteSnapshot) {
    try {
      actualSnapshotPath = await writePlanSnapshot(runDir, opts.iter, planPath);
    } catch (err) {
      process.stderr.write(`[wrapper] failed to write plan-snapshot-iter${opts.iter}.md: ${err.message}\n`);
    }
  }

  const resultFileName = onceNaming ? 'result.json' : `result-iter${opts.iter}.json`;
  const resultPath = path.join(runDir, resultFileName);
  const resultPayload = {
    mode: opts.mode,
    iter: opts.iter,
    scopes,
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
    planFileChanged,
    planHashBefore,
    planHashAfter,
    changedFiles,
    resumePromptMode,
    planSnapshotPath: actualSnapshotPath,
    planDiffPath,
    planDiffStats,
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

  // Emit Codex's final review to stdout verbatim.
  process.stdout.write(execResult.finalMessage);
  if (!execResult.finalMessage.endsWith('\n')) process.stdout.write('\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`unhandled error: ${err?.stack || err}\n`);
  process.exit(1);
});
