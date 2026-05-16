---
description: Grill a plan with Codex (read-only). Single pass, then validate.
argument-hint: "[path/to/plan.md] [--effort=<level>] [--model=<name>]"
---

Send the plan to Codex for a strict read-only review, validate every finding against the real code, update the plan if needed, then re-present it via `ExitPlanMode`.

Raw arguments: `$ARGUMENTS`

## Steps

### 1. Parse `$ARGUMENTS`

- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Anything else → the plan path (or empty).

### 2. Resolve `PLAN_PATH` and compute `RUN_DIR`

1. `UNIX_SECS = <current unix timestamp in seconds>`.
2. Set `PLAN_SOURCE` and `PLAN_BASENAME`:
   - **plan-path arg given** → `PLAN_SOURCE = arg`, `PLAN_BASENAME = <basename with .md stripped, non-alphanumeric → `-`>`.
   - **no plan-path arg** → `PLAN_SOURCE = inline`, `PLAN_BASENAME = inline`.
3. `RUN_ID = once-$UNIX_SECS-$PLAN_BASENAME`, `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`.
4. Resolve `PLAN_PATH`:
   - `PLAN_SOURCE = arg` → `PLAN_PATH = <the arg>`.
   - `PLAN_SOURCE = inline` → the session's `ExitPlanMode` plan is auto-saved to `~/.claude/plans/<auto-name>.md`. Copy it:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/copy-plan.mjs" "<source-path>" "$RUN_DIR/plan.md"
     ```
     On exit 0 → `PLAN_PATH = $RUN_DIR/plan.md`. On non-zero / uncertain path → `Write` the most recent `ExitPlanMode` plan from this conversation **verbatim** to `$RUN_DIR/plan.md`, then `PLAN_PATH = $RUN_DIR/plan.md`. No plan in either source → stop and tell the user.

### 3. Run the wrapper

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  --ephemeral \
  [--effort <EFFORT>] [--model <MODEL>]
```

`--ephemeral` skips codex session persistence (once-mode only).

### 4. Handle the exit code

- **0** — continue to step 5.
- **2** — working-tree changed during the run. See "Exit 2 — working-tree changed" below.
- **3** — codex CLI not installed. Tell the user: `npm install -g @openai/codex`, then `codex login`. Stop.
- **4** — not a git working tree. Tell the user to `git init` here or `cd` into the repo. Stop. Do **not** call `ExitPlanMode`.
- **1** — codex exec failed. Read stderr + `$RUN_DIR/result.json`. Common: `error.message` contains "context window" → suggest `--effort=medium` (often triggered by `model_reasoning_effort = "xhigh"` in `~/.codex/config.toml`); auth / rate-limit → print verbatim and halt; otherwise print raw error and ask the user how to proceed. Never auto-retry.
- **64** — wrapper rejected the call. Print stderr verbatim. Fix the arg if user-supplied, else it's a plugin wiring bug.

#### Exit 2 — working-tree changed

Read the stderr marker `WORKING_TREE_CHANGED:<comma-separated-files>` and `$RUN_DIR/result.json` for `preIterStash.hash` / `preIterStash.isEmpty`. Print under `### Working-tree changed`:

> Hi — I found these files changed during this run:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the run was in progress. Were these changes made by you?

Halt. Do **not** edit the plan. Do **not** call `ExitPlanMode`. Wait for the user.

- **User says yes (they edited):** acknowledge ("OK — leaving things as they are") and stop. The user can re-invoke when ready.
- **User says no / "it must be Codex":** say:
  > Then this looks like Codex breaking the read-only contract. What would you like me to do?
  > - **Revert** the working tree to the state right before this run started (we saved a `git stash` snapshot). I'll run `git stash apply <hash>`.
  > - **Stop** the run and leave the changes in place so you can inspect.

  If the user accepts revert and `preIterStash.isEmpty === false`: run `git stash apply <preIterStash.hash>`. If `git stash apply` reports conflicts, surface the conflict list and stop — don't force.

  If `preIterStash.isEmpty === true` (clean tree before the run): there's no stash to apply. The revert is `git reset --hard HEAD` (undo tracked changes) + `git clean -df` (remove new untracked files). **Both destructive — ask the user to confirm before running.**

### 5. Print Codex's review

Under `### Codex review`, paste the wrapper's stdout verbatim — verdict (SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES) and findings. If chat output was truncated, `Read` `$RUN_DIR/final.txt`.

### 6. Validate every finding

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file before marking any verdict — context memory does not count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**.

Under `### Claude validation`, for **every** finding, use this exact entry shape (all four lines required):

```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <specific path:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```

For claims spanning many files, dispatch parallel `Agent` calls. For external claims (CVE/GHSA, versions, vendor behavior), use `WebSearch` / `WebFetch` against primary sources.

Then under `#### What Codex missed`, do an independent fresh-eyes pass. End with **Net verdict**: SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES — based on your validation, not Codex's verdict line.

### 7. Update the plan (only if Net verdict is NEEDS REVISION or FUNDAMENTAL ISSUES)

- Apply each CONFIRMED finding (your **Action** may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE items → list under `### Unverified items flagged to user`, not in the plan.
- `PLAN_SOURCE = arg` → Edit `PLAN_PATH` in place; list edits under `### Plan updated`.
- `PLAN_SOURCE = inline` → output the revised plan in full under `### Revised plan` (do not edit `$RUN_DIR/plan.md` — it's the audit copy of what Codex saw).

### 8. Re-present via ExitPlanMode

Call `ExitPlanMode` with the (possibly updated) plan content — read from `PLAN_PATH` if `PLAN_SOURCE = arg`, else the revised plan from step 7 (or the original conversation plan if Net verdict was SOUND). If the tool schema isn't loaded, fetch it via `ToolSearch` with `select:ExitPlanMode`.
