---
description: Loop Codex review + Claude validation until convergence, then present.
argument-hint: "[path/to/plan.md] [--max=N] [--effort=<level>] [--model=<name>]"
---

Iteratively review and refine a plan with Codex (read-only) and Claude (validates + edits). The loop pins Codex to one thread: iter 1 captures the `thread_id` from Codex's JSONL stream; every later iter passes that UUID to `codex exec resume <id>` so prompt caching covers the bulk of the resumed prompt.

Raw arguments: `$ARGUMENTS`

## Setup

### 1. Parse `$ARGUMENTS`

- `--max=N` → `MAX_ITERS`. Default: `7`.
- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Anything else → the plan path (or empty).

### 2. Resolve `PLAN_PATH` and compute `RUN_DIR`

Set `UNIX_SECS = <current unix timestamp in seconds>`. Resolve `PLAN_PATH` (must be a file path — the loop edits it in place):

- plan-path arg given and the file exists → `PLAN_PATH = <that path>`.
- Else, if this session's `.claude/plans/*.md` path is known → `PLAN_PATH = <that path>`.
- Else, if there's an `ExitPlanMode` plan in this conversation → copy `~/.claude/plans/<auto-name>.md`:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/copy-plan.mjs" "<source-path>" ".claude/plans/codexgrill-<UNIX_SECS>.md"
  ```
  On exit 0 → use the destination. On non-zero / uncertain path → `Write` the most recent `ExitPlanMode` plan **verbatim** to `.claude/plans/codexgrill-<UNIX_SECS>.md` and use that path.
- Else stop — tell the user to run plan mode first or pass a path.

`PLAN_BASENAME = <basename of PLAN_PATH with .md stripped, non-alphanumeric → `-`>`. `RUN_ID = loop-$UNIX_SECS-$PLAN_BASENAME`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`. `$RUN_DIR` holds run-state only (per-iter prompts, finals, JSONL streams, refuted-log, `state.json`). **`PLAN_PATH` is not inside `$RUN_DIR`** — it's edited in place.

### 3. Initialize `state.json`

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

Print a heading `## Iteration <i>` and run these steps:

### A. Invoke the wrapper

**Iteration 1** (fresh thread — must NOT use `--ephemeral`; persistence is required for iter 2's resume):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Iteration 2+** (resume the pinned thread; the wrapper sends a short delta prompt + cumulative refuted-log — Codex already has the full plan in its thread from iter 1):
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

### B. Branch on the exit code

- **0** — continue to step C.
- **2** — working-tree changed. See "Exit 2 — working-tree changed" below.
- **3** — codex CLI not installed. Tell the user: `npm install -g @openai/codex`, then `codex login`. Stop.
- **4** — not a git working tree. Tell the user to `git init` or `cd` into the repo. Stop. Do not call `ExitPlanMode`.
- **1** — codex exec failed. Read stderr + `$RUN_DIR/result-iter<i>.json`. Common: "context window" → suggest `--effort=medium` (often triggered by `model_reasoning_effort = "xhigh"` in `~/.codex/config.toml`); auth / rate-limit → halt with verbatim message; otherwise halt with exact error. Never auto-retry and never silently fall back to `--mode fresh`.
- **64** — wrapper rejected the call. Print stderr verbatim. Fix the arg if user-supplied, else it's a plugin wiring bug.

#### Exit 2 — working-tree changed

Read the stderr marker `WORKING_TREE_CHANGED:<comma-separated-files>` and `$RUN_DIR/result-iter<i>.json` for `preIterStash.hash` / `preIterStash.isEmpty`. **STOP THE LOOP** at this iteration. Print under `### Working-tree changed (iter <i>)`:

> Hi — I found these files changed during the codexgrill loop:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the loop was running. Were these changes made by you?

Wait for the user's answer. Do not call `ExitPlanMode`.

- **User says yes (they edited) — continue the loop:** acknowledge ("OK, continuing the loop") and resume at iter `<i+1>`. **No special handling needed** — the next iteration's wrapper run takes a fresh `snapshotBefore` that already includes the user's edits as the new baseline, so they won't re-trip. Do not "reset" anything.
- **User says no / "it must be Codex":** say:
  > Then this looks like Codex breaking the read-only contract. What would you like me to do?
  > - **Revert** the working tree to the state right before iter `<i>` started (we saved a `git stash` snapshot). I'll run `git stash apply <preIterStash.hash>`.
  > - **Stop** the loop and leave the changes in place so you can inspect.

  If the user accepts revert and `preIterStash.isEmpty === false`: run `git stash apply <preIterStash.hash>`. If `git stash apply` reports conflicts, surface the conflict list and stop — don't force.

  If `preIterStash.isEmpty === true` (clean tree before this iter): there's no stash to apply. The revert is `git reset --hard HEAD` + `git clean -df`. **Both destructive — ask the user to confirm before running.**

### C. Print Codex's review

Under `### Codex review (iter <i>)`, paste the wrapper's stdout verbatim. If chat output was truncated, `Read` `$RUN_DIR/final-iter<i>.txt`.

### D. After iter 1 ONLY: capture the thread_id

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json`: set `codex_thread_id` to that UUID. This is the pin every later iteration's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), halt the loop — resuming an unidentified thread is not safe.

### E. Validate every Codex finding

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file in THIS iteration before marking any verdict — context memory does not count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**.

Under `### Claude validation (iter <i>)`, for **every** finding, use this exact entry shape (all four lines required):

```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <specific path:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```

For claims spanning many files, dispatch parallel `Agent` calls. For external claims, use `WebSearch` / `WebFetch` against primary sources. Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### F. Update the refuted-log (cumulative)

If any REFUTED findings exist (this iter or prior), `Write` `$RUN_DIR/refuted-log.txt` with the cumulative list so the next iter's wrapper call prepends it. If no refutations exist yet, do **not** write the file — the wrapper treats a missing path as empty.

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
  "codex_verdict": "SOUND | NEEDS REVISION | FUNDAMENTAL ISSUES",
  "claude_validation": {"confirmed": N, "refuted": N, "unverifiable": N},
  "containment_ok": true,
  "usage": "<from result-iter<i>.json.usage, optional>"
}
```

Write the updated JSON back.

### H. Decide if the plan is clean — both models must agree

Exit only when **all** hold:
- Codex's verdict this iter was **SOUND**.
- All CONFIRMED findings are addressed.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might NOT be — if real, it isn't. **Yes** → finalization. **No** → step I.

### I. Update the plan

- Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE → list under `### Unverified items flagged to user (iter <i>)`, not in the plan.
- Under `### Plan updated (iter <i>)`, list each edit as `- <section> — <change> — <finding>`. Continue to next iteration.

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit: stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

Tell the user where artifacts live (`<RUN_DIR>`). Then run a final Claude validation pass — re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality (heavier than per-iter validation; use parallel `Agent` calls for cross-file claims and `WebSearch` / `WebFetch` for external facts). Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode`; print the issue and wait.

Otherwise read `PLAN_PATH` and call `ExitPlanMode` with the full plan content. If the tool schema isn't loaded, fetch it via `ToolSearch` with `select:ExitPlanMode`.
