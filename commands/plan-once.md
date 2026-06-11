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

## 3. WRAPPER (plan mode is fine)

<read_only_contract>
Run the wrapper now — including in plan mode. It's read-only by construction (SHA256 contract on the working tree + PLAN_PATH; exits 2 if either is mutated), so it's safe here; skipping it would present an unvalidated first-pass plan, which isn't this skill's job. `$RUN_DIR` writes are excluded via `DEFAULT_IGNORED_PATTERNS`. `--ephemeral` skips codex session persistence — once-mode only, since there's no later iteration to resume.
</read_only_contract>

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  --ephemeral \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Wait:** launch with `run_in_background: true`. Codex often runs 30+ min — a long silent wait is normal. **The completion notification is the only done signal**: mid-run stderr is Codex's internal noise (`[codex] $ ...` = its activity, not wrapper status); `result.json` / `final.txt` / `codex.jsonl` don't exist until exit; prompt size never proves context exhaustion. Once the launch returns its shell ID, **end your turn and do nothing until the notification** — no `Read`, `Grep`, `Monitor`, `ScheduleWakeup` heartbeat, or `$RUN_DIR` polling, and no "still waiting" narration. The harness re-invokes you on exit; that's what advances to step 4.

## 4. BRANCH ON EXIT CODE

| code | action |
|---|---|
| 0 | continue to step 5 |
| 1 | Quote `errorReason` from `$RUN_DIR/result.json` verbatim — that's the authoritative diagnosis. If it contains `context window`, suggest `--effort=high`. For auth or rate-limit messages, halt verbatim. Otherwise print `errorReason` and ask the user how to proceed. Diagnose from `errorReason` alone and let the user choose the next step — auto-retrying can mask an auth, rate-limit, or context problem that needs a human call. |
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

<chat_deliverables>
The user cannot see wrapper stdout, `$RUN_DIR` files, or tool results — the only way Codex's review and your validation ever reach them is the text you print in chat. `### Codex review` and `### Claude validation` are the product of this command, not status narration, so general guidance to keep between-tool-call text brief or to drop low-impact detail does not apply to them. Print each one as ordinary chat markdown, complete — every finding, every template line — even when it runs to hundreds of lines. A summary, an excerpt, a pointer to a file, or content that exists only in thinking does not count as printing them. In this harness every text block you emit renders in the user's transcript and persists — including text between tool calls — so mid-turn printing is real delivery; any general caution that between-tool-call text may not be shown does not apply here.
</chat_deliverables>

`Read` `$RUN_DIR/final.txt` — the authoritative copy of what the wrapper printed (background-shell stdout can truncate) — and print its complete contents under `### Codex review`: verdict (SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES) and all findings. Printing it is a gate: after that `Read`, emit the full section and the bridge line before any other tool call — no validation `Read`/`Grep`, no plan edit until the review is visible in chat.

Then print this exact bridge line:

> **Revalidating each Codex finding against the actual code now; I'll print every verdict below before changing the plan.**

## 6. CLAUDE VALIDATES EVERY FINDING

<investigate_before_answering>
Codex is not an authority — it can mis-cite a line or misread control flow, so your own fresh read is the safeguard. Stay skeptical by default. Read the cited file with `Read` before you mark any verdict — never rule from context memory alone. If you haven't freshly read the code, the verdict is UNVERIFIABLE. Print the full `### Claude validation` — **a chat deliverable per step 5's contract** — before any edit to `PLAN_PATH`, so the user sees every verdict before the plan changes. This is also a gate: steps 7 and 8 — plan edits and `ExitPlanMode` — wait until the full section is in chat.
</investigate_before_answering>

For every finding, fill all four lines:

<example>
```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <path:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```
</example>

Dispatch parallel `Agent` calls for multi-file claims — have each return a condensed summary (verdict-relevant lines and citations, not full file contents) to keep context lean; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

End with **Net verdict** based on YOUR validation (not Codex's verdict line): SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES.

### 6b. Architecture Checkpoint

Skip when Net verdict is **SOUND** (step 7 won't run). Otherwise, gate findings that would silently reshape the project's architecture before step 7 applies them. Runs against every CONFIRMED finding from step 6 + every "What Codex missed" entry. The gate keys on architectural impact, not severity — a Critical fix that uses existing patterns is auto-applied, while a Medium hardening that forces every user to re-enroll is gated.

**When to gate:** gate a finding when applying it would change the project's *shape* — its framework/runtime, data store, auth model, public API surface, deployment model, or an established repo-wide pattern — beyond what the plan already authorized.

<example>
Findings that gate:
- Swapping session auth for JWT (auth-model change).
- Migrating the API from REST to GraphQL (public-API-surface change).
- Replacing the ORM that 5+ modules import (established repo-wide pattern).
- Moving custom auth to OAuth that forces every user to re-enroll (auth-model change).
- Going from single- to multi-region deployment (deployment-model change).
</example>

**When to auto-apply:** apply silently anything locally scoped or matching an existing pattern — for example bug fixes, typos, CVE-patch dep bumps within the same major, new tests, or config knobs with safe defaults.

**Pipeline per architectural finding — terminal states APPLY-NO-ASK / DROP / ASK-USER:**
1. **Original-plan check** — plan body already authorizes this change? → APPLY-NO-ASK.
2. **Existing-pattern check** — `Grep` a representative token; pattern already used elsewhere? → APPLY-NO-ASK.
3. **Fresh `Read`** every cited file (context memory doesn't count). Confirm quote, fitness for THIS code, no smaller local fix exists.
4. **`WebSearch` + `WebFetch` authoritative current docs** — always, unless the recommendation is a language fundamental that doesn't change (SQL parameterization, file-handle close). Cite primary sources (vendor docs, RFCs, OWASP, registry pages); skip aggregators. When in doubt, lookup.
5. **Generate 1–2 simpler alternatives** — each: 1-sentence mechanism, 1-sentence trade-off, citation (`path:line` for existing-pattern or doc URL).
6. **Self-check:** one obvious right answer an experienced engineer would pick without hesitation → **APPLY-NO-ASK**; recommendation unsound for THIS code (cited evidence weak, deprecated pattern, alternatives clearly better) → **DROP** (refute, don't ask); real trade-off / scope change → **ASK-USER**.

Print pipeline result before asking: `### Architecture checkpoint — pipeline result for "<short title>"` listing files read (`path:line`), docs fetched, self-check verdict.

**When ASK-USER, print this briefing then call `AskUserQuestion`** (fetch via `ToolSearch select:AskUserQuestion` if not loaded):

> ### Architecture checkpoint — your input needed
> **Change:** <1–2 sentences.>
> **Why flagged:** <trigger>. Codex's claim: <verbatim>. Code: `<path:line>`. Plan scope: <yes / no / partial>.
> **Recommendation:** <approach>. <1-paragraph rationale grounded in freshly read code + latest docs.> Doc: <URL>.
> **Alternative 1:** <name>. <1-sentence mechanism + trade-off.> <URL or `path:line`>.
> **Alternative 2 (optional):** <same format>.
> **Impact:** files touched; new deps; migration cost (one-shot / data migration / rolling); reversibility (easy / moderate / one-way).

Question: `"Architectural change: <short title>. How do you want to proceed?"`. Four options:
- **Apply recommended** (`Apply rec`) — apply to plan.
- **Apply alternative** (`Apply alt`) — follow-up `AskUserQuestion` to pick which alt if 2 exist.
- **Skip this finding** (`Skip`) — drop from the plan.
- **Discuss more** (`Discuss`) — follow-up `AskUserQuestion` rounds (up to 3) to clarify concerns / scope / direction; resolution applies, skips, or halts.

Ask one question at a time, waiting for each answer before the next. After each answer, re-run the pipeline for the remaining architectural findings (the answer may move them to APPLY-NO-ASK or DROP).

**Halt-for-offline** (only when user asks):
> ### Stopping for offline discussion
> Halting workflow on `<short title>`. Plan at `<PLAN_PATH>` keeps applied changes from this turn; the architectural item is NOT applied. Re-invoke `/codexgrill:plan-once` to resume.

Do NOT call `ExitPlanMode`.

**Record decisions** in chat under `### Architecture checkpoint — user decisions`: `<title> → <pick>` per finding.

## 7. UPDATE PLAN (only if Net verdict is NEEDS REVISION or FUNDAMENTAL ISSUES)

Apply each CONFIRMED finding (your **Action** may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE items → list under `### Unverified items flagged to user` in chat (no plan-body annotation).

Plan-file edits:
- plan-path arg given → `Edit` `PLAN_PATH` in place.
- inline (no arg) → output the revised plan in full under `### Revised plan` in chat. Leave `$RUN_DIR/plan.md` untouched — it's the audit copy of what Codex saw.

<clean_plan_body>
The plan body stays clean — it's the deliverable, so it holds only what's needed to execute the plan and must read identically across re-runs. Everything that belongs to this codexgrill plugin — the word `Codex` itself, iteration markers (`iter N`), verdict labels (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]`), model attributions like `Codex flagged` / `per Codex`, run/thread IDs, `$RUN_DIR` paths, review narratives — lives in chat + `$RUN_DIR`, not in the plan. Strip any such residue when editing.
</clean_plan_body>

## 8. PRESENT

<read_only_contract>
**Self-check:** Did step 3 run this turn? If not — including because of plan-mode caution about Bash — go back to step 3 now. The wrapper is read-only by construction.
</read_only_contract>

<chat_deliverables_check>
**Self-check:** before `ExitPlanMode` (or the closing message when plan mode is off), confirm your visible output this turn contains `### Codex review` in full and `### Claude validation` with every finding and all its lines. If either is missing, summarized, or only in a file, print it now, in full, then continue.
</chat_deliverables_check>

**Pre-present batch-question (UNVERIFIABLE load-bearing items):** Chat-within-turn memory is sufficient for plan-once — the batch-question fires in the same turn as the per-finding validation that produced the UNVERIFIABLE verdicts. If any UNVERIFIABLE verdicts from step 6 are still load-bearing (dropping them would leave the plan incomplete or risky), halt before `ExitPlanMode` and ask in one batched free-text message (not `AskUserQuestion` — the 4-question / 4-option cap can't handle 5+ items with free-form notes):

> ### Unverified items — your input needed
> For each, reply with the item number and one of:
> - `skip` — drop from the plan
> - `include` — keep the entry as a plain finding (no tag, no annotation)
>
> 1. **[severity] <short title>** — `<path:line>` — <one-line reason it's unverifiable>
>    Codex's claim: <one-line claim verbatim>
>    Quote: `<quote or "(none)">`
> 2. ...
>
> Reply in one message, e.g. `1. skip · 2. include · 3. skip`

Wait for the response. Parse per item. **Severity push-back rule:** if the user requests a severity downgrade for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back before applying: "Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend." After parsing: `skip` removes from chat list; `include` keeps as a plain finding in the plan (no tag, no auto-appended note; decision recorded in chat + `$RUN_DIR`, not the plan body). Plan body stays clean. Recompute Net verdict if needed.

**Detect plan-mode** via a system-reminder in the current turn (text like *"Plan mode is active"*). No programmatic predicate.

- **Plan-mode active** → call `ExitPlanMode` with the (possibly updated) plan content — read from `PLAN_PATH` if plan-path arg was given, else the revised plan from step 7 (or the original conversation plan if Net verdict was SOUND). If the tool schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
- **Plan-mode NOT active:**
  - plan-path arg given → print `> Plan updated. Plan file: \`<PLAN_PATH>\`` and stop.
  - inline (no arg) → print `> Plan reviewed. Revised plan is in chat above under \`### Revised plan\`.` and stop.
