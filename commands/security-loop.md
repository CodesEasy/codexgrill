---
description: Security audit loop. Claude + Codex iterate until the audit is clean.
argument-hint: "[path ...] [--max=N] [--effort=<level>] [--model=<name>]"
---

Iteratively audit the codebase for security issues with Codex (read-only) and Claude (validates + edits). The loop pins Codex to one thread: iter 1 captures the `thread_id` from Codex's JSONL stream; every later iter passes that UUID to `codex exec resume <id>` to preserve conversation context. Iter 1 sends Claude's initial security plan inline; resume iterations send a unified diff of plan changes plus the absolute path to the current plan (Codex pulls full context on demand). The wrapper falls back to inlining the full plan when the prior snapshot is missing, the diff is empty, or the diff is pathologically large.

Raw arguments: `$ARGUMENTS`

## Setup

### 1. Parse `$ARGUMENTS`

- `--max=N` → `MAX_ITERS`. Default: `7`.
- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Everything else is a positional path. Collect into `SCOPES`:
  - Zero paths → `SCOPES = ["."]` (whole repo).
  - One or more paths → `SCOPES = [path1, path2, ...]`.

### 2. Resolve `RUN_DIR` and `PLAN_PATH`

1. `UNIX_SECS = <current unix timestamp in seconds>`.
2. `SCOPE_TAG`: `"all"` if `SCOPES == ["."]`, else basenames joined by `-`, non-alphanumeric replaced with `-`, lowercased, capped at 40 chars.
3. `RUN_ID = security-loop-$UNIX_SECS-$SCOPE_TAG`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`.
4. `PLAN_PATH = .claude/plans/security-audit-$UNIX_SECS.md`. **Edited in place across iterations**; not inside `$RUN_DIR`.

### 3. Phase 1 — Claude's initial security review (no Codex yet)

Same as `commands/security-once.md` Phase 1: read scopes, read dependency manifests, run `WebSearch`/`WebFetch` for advisories, scan for OWASP/CWE categories, write the structured plan at `PLAN_PATH`. See `security-once.md` for the full category list and findings-format template.

### 4. Initialize `state.json`

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

Print a heading `## Iteration <i>` and run these steps:

### A. Invoke the wrapper (REQUIRED every iteration, do not skip)

**You MUST run the wrapper each iteration.** Skipping it leaves you with Claude's first-pass plan only, defeating the whole loop. **Plan mode is fine** — the wrapper is read-only by construction (SHA256 hashes the working tree and `PLAN_PATH` before and after Codex runs; exits 2 if anything changed). The Bash invocation below is safe in any mode.

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

**How to wait for completion.** Launch the wrapper with `run_in_background: true`. The system will notify you when the background command exits — that notification is the **only** authoritative "done" signal. Do **not**:
- start a Monitor on the wrapper's stderr to check whether it's "done" — the wrapper streams progress lines (e.g. `[codex] $ <command>`, `[codex] ✗ tool returned code N`, `[codex] » <message>`) that describe Codex's internal activity, not wrapper status;
- read `result-iter<i>.json` / `final-iter<i>.txt` / `codex-iter<i>.jsonl` before the completion notification — they are written incrementally or only-on-exit; the `result-iter<i>.json` file does not exist until the wrapper finishes, and absence of `turn.completed` mid-stream is not failure;
- infer context-window exhaustion (or any other cause) from stderr volume, JSONL length, or prompt size while the wrapper is still running.

When the notification arrives, branch on the background command's exit code per the table below. For diagnosis details, read `$RUN_DIR/result-iter<i>.json` — its `errorReason` field is the authoritative Codex error, parsed from the JSONL `turn.failed` / `error` events.

### B. Branch on the exit code

- **0** — continue to step C.
- **2** — working-tree changed. See "Exit 2 — working-tree changed" below.
- **3** — codex CLI not installed. Tell the user: `npm install -g @openai/codex`, then `codex login`. Stop.
- **4** — not a git working tree. Tell the user to `git init` or `cd` into the repo. Stop. Do not call `ExitPlanMode`.
- **1** — codex exec failed. Read `$RUN_DIR/result-iter<i>.json` and quote its `errorReason` field verbatim — that is Codex's own error message (parsed from the JSONL `turn.failed` / `error` events) and the authoritative diagnosis. Do not infer the cause from stderr text, stream length, or prompt size. If `errorReason` literally contains `context window`, then (and only then) suggest `--effort=high`. For auth or rate-limit messages, halt with the verbatim text. Otherwise halt with the exact `errorReason`. Never auto-retry and never silently fall back to `--mode fresh`.
- **64** — wrapper rejected the call. Print stderr verbatim. Fix the arg if user-supplied, else it's a plugin wiring bug.

#### Exit 2 — working-tree changed

Read the stderr marker `WORKING_TREE_CHANGED:<comma-separated-files>` and `$RUN_DIR/result-iter<i>.json` for `preIterStash.hash` / `preIterStash.isEmpty` / `preIterStash.noHead`. Note that `changedFiles` may include `PLAN_PATH` itself (gitignored-plan-file SHA256 check). **STOP THE LOOP** at this iteration. Print under `### Working-tree changed (iter <i>)`:

> Hi — I found these files changed during the security audit loop:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the loop was running. Were these changes made by you?

Wait for the user's answer. Do not call `ExitPlanMode`.

- **User says yes (they edited / it was their IDE) — continue the loop:** acknowledge ("OK, continuing the loop") and resume at iter `<i+1>`. **No special handling needed** — the next iteration's wrapper run takes a fresh `snapshotBefore` that already includes the user's edits. Additionally, **if the changed file looks like auto-generated noise that's currently tracked**, offer to add it to `.gitignore` (same logic as the plan loop).
- **User says no / "it must be Codex":** say:
  > Then this looks like Codex breaking the read-only contract. What would you like me to do?
  > - **Revert** the working tree to the content state from before iter `<i>`. Originally-untracked files re-appear as staged additions. Note: the security plan file at `PLAN_PATH` is gitignored, so the revert does NOT restore its pre-iter contents — Phase 3 edits since iter start may be lost.
  > - **Stop** the loop and leave the changes in place so you can inspect.

  If the user accepts revert, dispatch on `preIterStash` (same three branches as `plan-loop.md`):
  - `preIterStash.isEmpty === false` → `git restore --source=<preIterStash.hash> --staged --worktree -- :/ && git clean -fd`
  - `preIterStash.isEmpty === true && noHead === false` → `git restore --source=HEAD --staged --worktree -- :/ && git clean -fd`
  - `preIterStash.isEmpty === true && noHead === true` → `git clean -fd` only

### C. Print Codex's review

Under `### Codex review (iter <i>)`, paste the wrapper's stdout verbatim — verdict (`AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES`), per-finding validation (CONFIRMED / REFUTED / EXTENDED), and new findings. If chat output was truncated, `Read` `$RUN_DIR/final-iter<i>.txt`.

### D. After iter 1 ONLY: capture the thread_id

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json` by setting its `codex_thread_id` field to that UUID. This is the pin every later iteration's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), halt the loop — resuming an unidentified thread is not safe.

### E. Validate every Codex finding

**MANDATORY: invoke `Read` on the cited file in THIS iteration before marking any verdict — context memory does not count.**

Under `### Claude validation (iter <i>)`, for every Codex finding (validation of existing + NEW):

```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```

For claims spanning many files, dispatch parallel `Agent` calls. For external claims (CVE/GHSA, versions, vendor behavior), use `WebSearch` / `WebFetch` against primary sources. Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### F. Update the refuted-log (cumulative)

If any REFUTED findings exist (this iter or prior), `Write` `$RUN_DIR/refuted-log.txt` with the cumulative list. The next iter's wrapper call prepends it to the prompt. If no refutations exist yet, do **not** write the file.

```
PREVIOUSLY REFUTED — do not re-raise without new evidence:
- "<Codex's claim>" → <reason with path:line cite>
...
```

### G. Record this iteration in `state.json`

Read `$RUN_DIR/state.json`, set `current_iter = <i>`, append:

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

### H. Decide if the audit is clean — both models must agree

Exit only when **all** hold:
- Codex's verdict this iter was **AUDIT CLEAN**.
- All CONFIRMED findings (Claude's verdicts on Codex's claims) are addressed in `PLAN_PATH`.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might NOT be — if real, it isn't. **Yes** → finalization. **No** → step I.

### I. Update `PLAN_PATH`

- Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE → list under the plan's "## Unverified items flagged to user" section.
- Recompute the "## Summary" counts.
- Plan file stays clean of plugin metadata. In your chat reply, summarize what you changed. Continue to the next iteration.

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit: stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

**Self-check before finalizing:** Confirm at least one iteration's wrapper invocation (step A) actually ran. If you skipped the wrapper in every iteration — for any reason, including plan-mode caution about Bash — **stop and go back to iter 1's step A now**. Presenting Claude's first-pass plan without any Codex validation is not the contract of this skill.

Tell the user where artifacts live (`<RUN_DIR>`). Then run a final Claude validation pass — re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality (heavier than per-iter validation; use parallel `Agent` calls for cross-file claims and `WebSearch` / `WebFetch` for external facts). Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode` or `AskUserQuestion`; print the issue and wait.

Otherwise present per the **Phase 4** rules from `commands/security-once.md`:

- **Empty-audit branch:** If `PLAN_PATH` has zero findings, print "No security issues found" and either `ExitPlanMode` (plan mode active) or stop.
- **Plan mode active:** read `PLAN_PATH` and call `ExitPlanMode` with the full plan content. (Fetch `ExitPlanMode` schema via `ToolSearch` with `select:ExitPlanMode` if not loaded.)
- **Plan mode NOT active:** ask: "Audit complete. Plan: `<PLAN_PATH>`. Review it and let me know — should I proceed with the fixes, or do you want to make changes first?" Wait for explicit go-ahead before applying fixes (TodoWrite list, severity-ordered, see `security-once.md` step 10).
