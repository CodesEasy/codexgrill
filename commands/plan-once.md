---
description: Grill a plan with Codex (read-only). Single pass, then validate.
argument-hint: "[path/to/plan.md] [--effort=<level>] [--model=<name>]"
---

Send the plan to Codex for a strict read-only review, validate every finding against the real code, update the plan if needed, then re-present it via `ExitPlanMode`.

Raw arguments: `$ARGUMENTS`

## 1. PARSE ARGS

- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Anything else → the plan path (or empty).

## 2. RESOLVE PLAN_PATH + RUN_DIR

1. `UNIX_SECS = <current unix timestamp in seconds>`.
2. Set `PLAN_BASENAME`:
   - **plan-path arg given** → `PLAN_BASENAME = <basename of arg with .md stripped, non-alphanumeric → `-`>`.
   - **no arg** → `PLAN_BASENAME = inline`.
3. `RUN_ID = once-$UNIX_SECS-$PLAN_BASENAME`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`.
4. Resolve `PLAN_PATH`:
   - **plan-path arg given** → `PLAN_PATH = <the arg>`.
   - **no arg** → the session's `ExitPlanMode` plan is auto-saved to `~/.claude/plans/<auto-name>.md`. Copy it:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/copy-plan.mjs" "<source-path>" "$RUN_DIR/plan.md"
     ```
     Exit 0 → `PLAN_PATH = $RUN_DIR/plan.md`. Non-zero / uncertain → `Write` the most recent `ExitPlanMode` plan from this conversation **verbatim** to `$RUN_DIR/plan.md`, then `PLAN_PATH = $RUN_DIR/plan.md`. Neither source has a plan → ask:
     > I can't find a plan file. Is this the one [`<best-guess>`], or do you want to share something else?

## 3. WRAPPER (REQUIRED — plan mode is fine)

**Run the Bash below — even in plan mode.** Read-only by SHA256 contract on (working tree, PLAN_PATH); exits 2 if either mutated. `$RUN_DIR` writes excluded via `DEFAULT_IGNORED_PATTERNS`. `--ephemeral` skips codex session persistence (once-mode only).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  --ephemeral \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Wait:** `run_in_background: true`. Codex can take 30+ min. **Completion notification = ONLY done signal** — mid-run stderr is Codex's internal noise (`[codex] $ ...` lines describe Codex's activity, not wrapper status), `result.json` / `final.txt` / `codex.jsonl` don't exist until exit, prompt size never proves context exhaustion. Verification starts after the notification.

## 4. BRANCH ON EXIT CODE

| code | action |
|---|---|
| 0 | continue to step 5 |
| 1 | Quote `errorReason` from `$RUN_DIR/result.json` verbatim — that's the authoritative diagnosis. If it contains `context window`, suggest `--effort=high`. For auth or rate-limit messages, halt verbatim. Otherwise print `errorReason` and **ask the user how to proceed**. Never auto-retry; never infer from stderr or prompt size. |
| 2 | Working-tree changed → step 4a |
| 3 | codex CLI missing → tell user: `npm install -g @openai/codex && codex login`. Stop. |
| 4 | Not a git repo → tell user to `git init` or `cd` here. Stop. No `ExitPlanMode`. |
| 64 | Wrapper rejected. Print stderr verbatim. Fix arg or it's a plugin wiring bug. |

### 4a. EXIT 2 — WORKING-TREE CHANGED

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result.json`. Print under `### Working-tree changed`:

> Hi — I found these files changed during this run:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the run was in progress. Were these changes made by you?

Halt entirely. Do **not** edit the plan. Do **not** call `ExitPlanMode`. Wait for the user.

- **User says yes (their edit / IDE):** acknowledge ("OK — leaving things as they are"). If the file looks auto-generated and tracked (`.idea/*.iml`, build artifacts, framework caches), offer to add it to `.gitignore` — only if truly auto-generated. Stop — user re-invokes when ready.
- **User says no / "must be Codex":** offer Revert (destructive — confirm first, verify with `git status` after) OR Stop. Note originally-untracked files re-appear as staged additions (bytes match). Revert dispatch on `preIterStash`:
  - `isEmpty === false` → `git restore --source=<hash> --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === false` → `git restore --source=HEAD --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === true` → `git clean -fd` only (no prior content to restore)

## 5. PRINT CODEX'S REVIEW + BRIDGE

Under `### Codex review`, paste the wrapper's stdout verbatim — verdict (SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES) and findings. Truncated? `Read` `$RUN_DIR/final.txt`.

Then print this exact bridge line:

> **Now revalidating each Codex finding against the actual code — no plan changes until every verdict is printed below.**

## 6. CLAUDE VALIDATES EVERY FINDING (MANDATORY)

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file BEFORE marking any verdict — context memory does NOT count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**. **Print the full `### Claude validation` BEFORE any edit to `PLAN_PATH`** — the user sees every verdict before the plan changes.

For **every** finding, all four lines required:

```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <path:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```

Dispatch parallel `Agent` calls for multi-file claims; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

End with **Net verdict** based on YOUR validation (not Codex's verdict line): SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES.

## 7. UPDATE PLAN (only if Net verdict is NEEDS REVISION or FUNDAMENTAL ISSUES)

Apply each CONFIRMED finding (your **Action** may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE items → list under `### Unverified items flagged to user` in chat (no plan-body annotation).

Plan-file edits:
- plan-path arg given → `Edit` `PLAN_PATH` in place.
- inline (no arg) → output the revised plan in full under `### Revised plan` in chat. Do NOT edit `$RUN_DIR/plan.md` — it's the audit copy of what Codex saw.

**Plan body = deliverable, not provenance.** Contains only: *what* the issue is, *where* (`path:line`), *how to fix it*. No process metadata — no iteration markers (`iter N` / `(iter <i>)`), no model attributions (`Codex flagged` / `per Codex` / `from review N`), no validation tags (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]` / `[user-confirmed-despite-unverifiable]` / `[unverified_citation]` / `[line_drift]`), no run/thread IDs, no `$RUN_DIR` paths, no review narratives. All review-process state lives in chat + `$RUN_DIR`. **When editing the plan, strip any pre-existing process residue you encounter** — the plan must read identically whether the user runs this once or three times.

## 8. PRESENT

**Self-check:** Did step 3 run this turn? If not — including because of plan-mode caution about Bash — go back to step 3 now. The wrapper is read-only by construction.

**Pre-present batch-question (UNVERIFIABLE load-bearing items):** Chat-within-turn memory is sufficient for plan-once — the batch-question fires in the same turn as the per-finding validation that produced the UNVERIFIABLE verdicts. If any UNVERIFIABLE verdicts from step 6 are still load-bearing (dropping them would leave the plan incomplete or risky), halt before `ExitPlanMode` and run the **batch-question procedure** defined in `commands/security-once.md` step 8 (numbered items, free-text reply `1. skip · 2. include`, severity push-back rule). After parsing user decisions: `skip` removes from chat list; `include` keeps as a plain finding in the plan (no tag, no auto-appended note; decision recorded in chat + `$RUN_DIR`, NOT the plan body). Plan body stays clean. Recompute Net verdict if needed.

**Call `ExitPlanMode`** with the (possibly updated) plan content — read from `PLAN_PATH` if plan-path arg was given, else the revised plan from step 7 (or the original conversation plan if Net verdict was SOUND). If the tool schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
