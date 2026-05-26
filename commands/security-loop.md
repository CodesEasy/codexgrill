---
description: Security audit loop. Claude + Codex iterate until the audit is clean.
argument-hint: "[path ...] [--max=N] [--effort=<level>] [--model=<name>]"
---

Iteratively audit the codebase for security issues with Codex (read-only) and Claude (validates + edits). The loop pins Codex to one thread: iter 1 captures the `thread_id` from Codex's JSONL stream; every later iter passes that UUID to `codex exec resume <id>` to preserve conversation context. The wrapper auto-selects unified-diff vs full-plan-inline resume prompts. Loop until both models agree the audit is AUDIT CLEAN.

Raw arguments: `$ARGUMENTS`

## 1. PARSE ARGS

- `--max=N` → `MAX_ITERS`. Default: `7`.
- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Everything else is a positional path. Collect into `SCOPES`:
  - Zero paths → `SCOPES = ["."]` (whole repo).
  - One or more paths → `SCOPES = [path1, path2, ...]`.

## 2. RESOLVE RUN_DIR + PLAN_PATH

`UNIX_SECS = <current unix timestamp in seconds>`. `SCOPE_TAG`: `"all"` if `SCOPES == ["."]`, else basenames joined by `-`, non-alphanumeric replaced with `-`, lowercased, capped at 40 chars.

`RUN_ID = security-loop-$UNIX_SECS-$SCOPE_TAG`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`. `PLAN_PATH = .claude/plans/security-audit-$UNIX_SECS.md`. **Edited in place across iterations**; not inside `$RUN_DIR`.

## 2a. PHASE 1 — Claude's initial security review (no Codex yet)

Same as `commands/security-once.md` step 2a: read `SCOPES`, read dependency manifests (`package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, etc.), run `WebSearch`/`WebFetch` against authoritative advisory sources (GHSA, NVD, vendor, registry tabs — cite primary sources only), scan for OWASP/CWE categories, write the structured plan at `PLAN_PATH`. **Zero findings → still write the file with `Critical: 0 · High: 0 · Medium: 0 · Low: 0 · Info: 0` and a "No issues found" note** (signals the empty-audit branch at finalization). See `security-once.md` for the full category list and findings-format template.

## 3. INITIALIZE state.json

`Write` `$RUN_DIR/state.json`:

```json
{
  "run_name": "security audit: <SCOPE_TAG>",
  "run_dir": "<RUN_DIR>",
  "plan_path": "<PLAN_PATH>",
  "audit_scope": ["<scope1>", "<scope2>", ...],
  "started_at": "<ISO timestamp>",
  "max_iters": <MAX_ITERS>,
  "effort": "<EFFORT or null>",
  "model": "<MODEL or null>",
  "codex_thread_id": null,
  "current_iter": 0,
  "iterations": []
}
```

## The loop (iteration `i = 1..MAX_ITERS`)

Print a heading `## Iteration <i>` and run steps A-I:

### A. WRAPPER (REQUIRED every iteration — plan mode is fine)

**You MUST run the wrapper each iteration.** Skipping it leaves you with Claude's first-pass plan only, defeating the whole loop. **Run the Bash below — even in plan mode.** Read-only by SHA256 contract on (working tree, PLAN_PATH); exits 2 if either mutated. `$RUN_DIR` writes excluded via `DEFAULT_IGNORED_PATTERNS`.

**Iteration 1** (fresh thread — must NOT use `--ephemeral`; persistence is required for iter 2's resume):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/security-audit.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --scope "<SCOPES[0]>" [--scope "<SCOPES[1]>" ...] \
  --mode fresh \
  --iter 1 \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Iteration 2+** (resume the pinned thread; wrapper auto-selects unified-diff prompt when iter 1 wrote a snapshot, falling back to full-plan inline for missing-snapshot / no-change / pathological-diff cases):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/security-audit.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --scope "<SCOPES[0]>" [--scope "<SCOPES[1]>" ...] \
  --mode resume \
  --resume-thread-id "<state.json.codex_thread_id>" \
  --iter <i> \
  --refuted-log "<RUN_DIR>/refuted-log.txt" \
  [--effort <EFFORT>] [--model <MODEL>]
```

Omit `--refuted-log` for iter 2 if no refutations exist yet — the wrapper treats a missing path as empty.

**Wait:** `run_in_background: true`. Codex can take 30+ min. **Completion notification = ONLY done signal** — mid-run stderr is Codex's internal noise (`[codex] $ ...` lines describe Codex's activity, not wrapper status), `result-iter<i>.json` / `final-iter<i>.txt` / `codex-iter<i>.jsonl` don't exist until exit, prompt size never proves context exhaustion. Verification starts after the notification.

### B. BRANCH ON EXIT CODE

| code | action |
|---|---|
| 0 | continue to step C |
| 1 | Quote `errorReason` from `$RUN_DIR/result-iter<i>.json` verbatim — that's the authoritative diagnosis. If it contains `context window`, suggest `--effort=high`. For auth or rate-limit messages, halt verbatim. Otherwise **halt with the exact `errorReason`**. Never auto-retry; never silently fall back to `--mode fresh`; never infer from stderr or prompt size. |
| 2 | Working-tree changed → step B.1 |
| 3 | codex CLI missing → tell user: `npm install -g @openai/codex && codex login`. Stop. |
| 4 | Not a git repo → tell user to `git init` or `cd` here. Stop. No `ExitPlanMode`. |
| 64 | Wrapper rejected. Print stderr verbatim. Fix arg or it's a plugin wiring bug. |

### B.1. EXIT 2 — WORKING-TREE CHANGED

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result-iter<i>.json`. Note: `changedFiles` may include `PLAN_PATH` itself (gitignored-plan-file SHA256 check). **STOP THIS ITER.** Print under `### Working-tree changed (iter <i>)`:

> Hi — I found these files changed during the security audit loop:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the loop was running. Were these changes made by you?

Wait for the user. Do not call `ExitPlanMode`.

- **User says yes (their edit / IDE) — continue at iter <i+1>:** acknowledge ("OK, continuing the loop"). **No special handling needed** — the next iter's wrapper run takes a fresh `snapshotBefore` that already includes the user's edits as the new baseline. If the file looks auto-generated and tracked, offer to add to `.gitignore` before resuming.
- **User says no / "must be Codex":** offer Revert (destructive — confirm first, verify with `git status` after) OR Stop. **Note: the security plan file at `PLAN_PATH` is gitignored, so the revert does NOT restore its pre-iter contents — plan edits made this iter (steps E–I) may be lost.** Originally-untracked files re-appear as staged additions. Revert dispatch on `preIterStash`:
  - `isEmpty === false` → `git restore --source=<hash> --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === false` → `git restore --source=HEAD --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === true` → `git clean -fd` only (no prior content to restore)

### C. PRINT CODEX'S REVIEW + BRIDGE

Under `### Codex review (iter <i>)`, paste the wrapper's stdout verbatim — verdict (`AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES`), per-finding validation (CONFIRMED / REFUTED / EXTENDED), and new findings. Truncated? `Read` `$RUN_DIR/review-iter<i>.md` (fresh-mode iter 1 only — has quote-validation tags). For resume iters (2+), or if `review-iter<i>.md` is absent, fall back to `final-iter<i>.txt` (plain markdown).

Then print this exact bridge line:

> **Now revalidating each Codex finding against the actual code — no plan changes until every verdict is printed below.**

### D. After iter 1 ONLY: CAPTURE THREAD_ID

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json`: set `codex_thread_id` to that UUID. This is the pin every later iter's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), **halt the loop** — resuming an unidentified thread is not safe.

### E. CLAUDE VALIDATES EVERY FINDING (MANDATORY)

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file in THIS iteration before marking any verdict — context memory does NOT count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**. **Print the full `### Claude validation (iter <i>)` BEFORE any edit to `PLAN_PATH`** — the user sees every verdict before the plan changes.

For **every** Codex finding (validation of existing + NEW), all five lines required:

```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```

Dispatch parallel `Agent` calls for multi-file claims; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### E.5. PHASE 3.5 — Priority handling for [unverified_citation] / [line_drift] tags (iter <i>)

Same procedure as `security-once.md` step 6a. Any finding tagged `[unverified_citation]` or `[line_drift]` by the wrapper gets priority validation against the cited file before the refuted-log is updated. **UNVERIFIABLE items accumulate in `PLAN_PATH`'s `## Unverified items flagged to user` section across iterations** — they are resolved in ONE batch at finalization, never per iter.

### F. UPDATE REFUTED-LOG (cumulative)

If any REFUTED findings exist (this iter or prior), `Write` `$RUN_DIR/refuted-log.txt` with the cumulative list. The next iter's wrapper prepends it to the prompt:

```
PREVIOUSLY REFUTED — do not re-raise without new evidence:
- "<Codex's claim>" → <reason with path:line cite>
...
```

If no refutations exist yet, do **not** write the file.

### G. RECORD ITERATION in state.json

Read `$RUN_DIR/state.json`, set `current_iter = <i>`, append. Note: this schema deliberately **OMITS** `unverifiable_items[]` (unlike `plan-loop.md`) — UNVERIFIABLE items for security accumulate in `PLAN_PATH`'s `## Unverified items flagged to user` section instead, and are resolved in ONE batch at finalization (per E.5 above).

```json
{
  "iter": <i>,
  "codex_thread_id": "<state.codex_thread_id>",
  "codex_verdict": "AUDIT CLEAN | NEEDS REVISION | CRITICAL ISSUES",
  "claude_validation": {"confirmed": N, "refuted": N, "unverifiable": N},
  "containment_ok": true,
  "usage": "<from result-iter<i>.json.usage, optional>"
}
```

Write the updated JSON back.

### H. BOTH-MODELS-AGREE CHECK

Exit only when **all** hold:
- Codex's verdict this iter was **AUDIT CLEAN**.
- All CONFIRMED findings (Claude's verdicts on Codex's claims) are addressed in `PLAN_PATH`.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might NOT be — if real, it isn't. **Yes** → finalization. **No** → step I, then next iteration.

### I. UPDATE PLAN_PATH

Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE → list under the plan's `## Unverified items flagged to user` section (accumulates across iters; resolved in one batch at finalization).

Recompute the `## Summary` counts.

**Plan body = deliverable, not provenance.** Contains only: *what* the issue is, *where* (`path:line`), *how to fix it*. No process metadata — no iteration markers (`iter N` / `(iter <i>)`), no model attributions (`Codex flagged` / `per Codex` / `from review N`), no validation tags (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]` / `[user-confirmed-despite-unverifiable]` / `[unverified_citation]` / `[line_drift]`), no run/thread IDs, no `$RUN_DIR` paths, no review narratives. Only the structured sections from `security-once.md` Phase 1 belong in the plan. **When editing the plan, strip any pre-existing process residue you encounter** — the plan must read identically whether the user runs this once or three times.

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit:

**Unverifiable batch-question (cap-reached path):** Even though we're stopping without convergence, if `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty, run the **batch-question procedure** from `commands/security-once.md` step 8 now — the user shouldn't be left with unresolved unverified items just because the loop hit the cap. Apply decisions to the plan, then print the ⏸ message and stop as written.

Stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

**Self-check:** Did at least one iteration's step A actually run? If you skipped the wrapper in every iter — including because of plan-mode caution about Bash — go back to iter 1's step A now. Presenting Claude's first-pass plan without any Codex validation is not the contract of this skill. The wrapper is read-only by construction.

Tell the user where artifacts live (`<RUN_DIR>`). Then run a **final Claude validation pass** — heavier than per-iter validation: re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality. Use parallel `Agent` calls for cross-file claims; `WebSearch` / `WebFetch` for external facts. Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode` or `AskUserQuestion`; print the issue and wait.

**Unverifiable batch-question (finalization path):** If `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty after convergence, halt and run the **batch-question procedure** from `commands/security-once.md` step 8 verbatim. Resolve all unverifiable items in one user round-trip. Apply decisions to the plan exactly as security-once specifies (including recomputing severity counts). Then continue to the per-mode presentation rules below.

Otherwise present per the **step 8** rules from `commands/security-once.md`:

- **Empty-audit branch:** If `PLAN_PATH` has zero findings, print "No security issues found" and either `ExitPlanMode` (plan mode active) or stop.
- **Plan mode active:** read `PLAN_PATH` and call `ExitPlanMode` with the full plan content. (Fetch via `ToolSearch select:ExitPlanMode` if schema not loaded.)
- **Plan mode NOT active:** ask: "Audit complete. Plan: `<PLAN_PATH>`. Review it and let me know — should I proceed with the fixes, or do you want to make changes first?" Wait for explicit go-ahead before applying fixes (TodoWrite list, severity-ordered, see `security-once.md` step 9).
