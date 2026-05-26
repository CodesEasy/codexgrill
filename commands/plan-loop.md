---
description: Loop Codex review + Claude validation until convergence, then present.
argument-hint: "[path/to/plan.md] [--max=N] [--effort=<level>] [--model=<name>]"
---

Grill the plan iteratively with Codex (read-only) and Claude (validates + edits). The loop pins Codex to one thread: iter 1 captures the `thread_id` from Codex's JSONL stream; every later iter passes that UUID to `codex exec resume <id>` to preserve conversation context. The wrapper auto-selects unified-diff vs full-plan-inline resume prompts. Loop until both models agree it's SOUND.

Raw arguments: `$ARGUMENTS`

## 1. PARSE ARGS

- `--max=N` → `MAX_ITERS`. Default: `7`.
- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Anything else → the plan path (or empty).

## 2. RESOLVE PLAN_PATH + RUN_DIR

`UNIX_SECS = <current unix timestamp in seconds>`. Resolve `PLAN_PATH` (must be a file path — the loop edits it in place):

- plan-path arg given and file exists → `PLAN_PATH = <that path>`.
- Else, if this session's `.claude/plans/*.md` path is known → `PLAN_PATH = <that path>`.
- Else, if there's an `ExitPlanMode` plan in this conversation → copy it:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/copy-plan.mjs" "<source-path>" ".claude/plans/codexgrill-<UNIX_SECS>.md"
  ```
  Exit 0 → use the destination. Non-zero / uncertain → `Write` the most recent `ExitPlanMode` plan **verbatim** to `.claude/plans/codexgrill-<UNIX_SECS>.md` and use that path.
- Else ask:
  > I can't find a plan file. Is this the one [`<best-guess>`], or do you want to share something else?

`PLAN_BASENAME = <basename of PLAN_PATH with .md stripped, non-alphanumeric → `-`>`. `RUN_ID = loop-$UNIX_SECS-$PLAN_BASENAME`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`. `$RUN_DIR` holds run-state only (per-iter prompts, finals, JSONL streams, refuted-log, `state.json`). **`PLAN_PATH` is not inside `$RUN_DIR`** — edited in place.

## 3. INITIALIZE state.json

`Write` `$RUN_DIR/state.json` (the `Write` tool creates `$RUN_DIR` for you):

```json
{
  "run_name": "grill: <PLAN_BASENAME>",
  "run_dir": "<RUN_DIR>",
  "plan_path": "<PLAN_PATH>",
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

**Run the Bash below — even in plan mode.** Read-only by SHA256 contract on (working tree, PLAN_PATH); exits 2 if either mutated. `$RUN_DIR` writes excluded via `DEFAULT_IGNORED_PATTERNS`.

**Iteration 1** (fresh thread — must NOT use `--ephemeral`; persistence is required for iter 2's resume):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Iteration 2+** (resume the pinned thread; wrapper auto-selects unified-diff prompt when iter 1 wrote a snapshot, falling back to full-plan inline for missing-snapshot / no-change / pathological-diff cases — see `resumePromptMode` field in `result-iter<i>.json`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
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

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result-iter<i>.json`. **STOP THIS ITER.** Print under `### Working-tree changed (iter <i>)`:

> Hi — I found these files changed during the codexgrill loop:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the loop was running. Were these changes made by you?

Wait for the user. Do not call `ExitPlanMode`.

- **User says yes (their edit / IDE) — continue at iter <i+1>:** acknowledge ("OK, continuing the loop"). **No special handling needed** — the next iter's wrapper run takes a fresh `snapshotBefore` that already includes the user's edits as the new baseline. If the file looks auto-generated and tracked (`.idea/*.iml`, build artifacts, framework caches), offer to add to `.gitignore` before resuming.
- **User says no / "must be Codex":** offer Revert (destructive — confirm first, verify with `git status` after) OR Stop. Note originally-untracked files re-appear as staged additions (bytes match). Revert dispatch on `preIterStash`:
  - `isEmpty === false` → `git restore --source=<hash> --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === false` → `git restore --source=HEAD --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === true` → `git clean -fd` only (no prior content to restore)

### C. PRINT CODEX'S REVIEW + BRIDGE

Under `### Codex review (iter <i>)`, paste the wrapper's stdout verbatim. Truncated? `Read` `$RUN_DIR/final-iter<i>.txt`.

Then print this exact bridge line:

> **Now revalidating each Codex finding against the actual code — no plan changes until every verdict is printed below.**

### D. After iter 1 ONLY: CAPTURE THREAD_ID

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json`: set `codex_thread_id` to that UUID. This is the pin every later iter's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), **halt the loop** — resuming an unidentified thread is not safe.

### E. CLAUDE VALIDATES EVERY FINDING (MANDATORY)

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file in THIS iteration before marking any verdict — context memory does NOT count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**. **Print the full `### Claude validation (iter <i>)` BEFORE any edit to `PLAN_PATH`** — the user sees every verdict before the plan changes.

For **every** finding, all four lines required:

```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <path:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```

Dispatch parallel `Agent` calls for multi-file claims; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### F. UPDATE REFUTED-LOG (cumulative)

If any REFUTED findings exist (this iter or prior), `Write` `$RUN_DIR/refuted-log.txt` with the cumulative list so the next iter's wrapper prepends it:

```
PREVIOUSLY REFUTED — do not re-raise without new evidence:
- "<Codex's claim>" → <reason with path:line cite>
...
```

If no refutations exist yet, do **not** write the file — the wrapper treats a missing path as empty.

### G. RECORD ITERATION in state.json

Read `$RUN_DIR/state.json`, set `current_iter = <i>`, append. Note: `plan-review.mjs` does NOT pass `--output-schema`, so Codex's response is plain prose — Claude extracts `claim`, `path`, `quote` manually from Codex's bullet for each finding it marks UNVERIFIABLE (set them to null when Codex's bullet doesn't contain that data).

```json
{
  "iter": <i>,
  "codex_thread_id": "<state.codex_thread_id>",
  "codex_verdict": "SOUND | NEEDS REVISION | FUNDAMENTAL ISSUES",
  "claude_validation": {"confirmed": N, "refuted": N, "unverifiable": N},
  "unverifiable_items": [
    {
      "claim": "<Codex's claim verbatim, one line>",
      "path": "<path:line or null>",
      "quote": "<verbatim quote from Codex's finding, or null>",
      "reason": "<one-line why Claude couldn't verify>",
      "load_bearing": <true | false — would dropping this leave the plan incomplete?>
    }
  ],
  "containment_ok": true,
  "usage": "<from result-iter<i>.json.usage, optional>"
}
```

Write the updated JSON back.

### H. BOTH-MODELS-AGREE CHECK

Exit only when **all** hold:
- Codex's verdict this iter was **SOUND**.
- All CONFIRMED findings are addressed.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might NOT be — if real, it isn't. **Yes** → finalization. **No** → step I, then next iteration.

### I. UPDATE PLAN

Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE → also recorded in `state.json.iterations[i].unverifiable_items[]` (per step G) so finalization can resolve them in one batch. In chat, list them under `### Unverified items flagged to user (iter <i>)` for this iter's awareness.

**Plan body = deliverable, not provenance.** Contains only: *what* the issue is, *where* (`path:line`), *how to fix it*. No process metadata — no iteration markers (`iter N` / `(iter <i>)`), no model attributions (`Codex flagged` / `per Codex` / `from review N`), no validation tags (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]` / `[user-confirmed-despite-unverifiable]` / `[unverified_citation]` / `[line_drift]`), no run/thread IDs, no `$RUN_DIR` paths, no review narratives. All review-process state lives in chat + `$RUN_DIR`. **When editing the plan, strip any pre-existing process residue you encounter** — the plan must read identically whether the user runs this once or three times.

Continue to the next iteration.

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit:

**Unverifiable batch-question (cap-reached path):** Read `state.json.iterations[*].unverifiable_items[]`, dedupe by `claim`, filter to `load_bearing === true`. If non-empty, run the **batch-question procedure** defined in `commands/security-once.md` step 8 now (numbered items, free-text reply `1. skip · 2. include`, severity push-back). Apply decisions to the plan. The user shouldn't be left with unresolved load-bearing items just because we hit the cap.

Then stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

**Self-check:** Did at least one iteration's step A actually run? If you skipped the wrapper in every iter — including because of plan-mode caution about Bash — go back to iter 1's step A now. The wrapper is read-only by construction.

**Unverifiable batch-question (finalization path):** Read `state.json.iterations[*].unverifiable_items[]` and union by `claim` (dedupe items raised in multiple iters). Filter to `load_bearing === true`. Non-empty → halt and run the **batch-question procedure** from `commands/security-once.md` step 8 verbatim against that list. Apply user decisions to the plan: `skip` removes from any in-progress chat list; `include` keeps as a plain finding in the plan body (no tag, no auto-appended note; decision recorded in chat + `$RUN_DIR/state.json`, NOT the plan body). Plan body stays clean. Recompute Net verdict if needed.

Tell the user where artifacts live (`<RUN_DIR>`). Then run a **final Claude validation pass** — heavier than per-iter validation: re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality. Use parallel `Agent` calls for cross-file claims; `WebSearch` / `WebFetch` for external facts. Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode`; print the issue and wait.

Otherwise read `PLAN_PATH` and call `ExitPlanMode` with the full plan content. If the tool schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
