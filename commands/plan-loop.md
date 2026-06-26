---
description: Loop Codex review + Claude validation until convergence, then present.
argument-hint: "[path/to/plan.md] [--max=N] [--effort=<level>] [--model=<name>]"
---

Grill the plan iteratively with Codex (read-only) + Claude (validates + edits). Iter 1 captures Codex's thread_id; later iters resume that thread with the diff. Loop until both models agree the plan is SOUND.

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

### A. WRAPPER (plan mode is fine)

<read_only_contract>
Run the wrapper now — including in plan mode, every iteration. It's read-only by construction (SHA256 contract on the working tree + PLAN_PATH; exits 2 if either is mutated), so it's safe here; skipping it would present an unvalidated first-pass plan, which isn't this skill's job. `$RUN_DIR` writes are excluded via `DEFAULT_IGNORED_PATTERNS`.
</read_only_contract>

**Iteration 1** (fresh thread — must not use `--ephemeral`; persistence is required for iter 2's resume):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --mode fresh \
  --iter 1 \
  [--effort <EFFORT>] [--model <MODEL>]
```

**Iteration 2+** (resume the pinned thread):
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

**Wait:** launch with `run_in_background: true`. Codex often runs 30+ min — a long silent wait is normal. **The completion notification is the only done signal**: mid-run stderr is Codex's internal noise (`[codex] $ ...` = its activity, not wrapper status); `result-iter<i>.json` / `final-iter<i>.txt` / `codex-iter<i>.jsonl` don't exist until exit; prompt size never proves context exhaustion. Once the launch returns its shell ID, **end your turn and do nothing until the notification** — no `Read`, `Grep`, `Monitor`, `ScheduleWakeup` heartbeat, or `$RUN_DIR` polling, and no "still waiting" narration. The harness re-invokes you on exit; that's what advances to step B.

### B. BRANCH ON EXIT CODE

| code | action |
|---|---|
| 0 | continue to step B.0 |
| 1 | Quote `errorReason` from `$RUN_DIR/result-iter<i>.json` verbatim — that's the authoritative diagnosis. If it contains `context window`, suggest `--effort=high`. For auth or rate-limit messages, halt verbatim. Otherwise halt with the exact `errorReason`. Diagnose from `errorReason` alone — don't silently fall back to `--mode fresh`, and don't auto-retry, which can mask an auth, rate-limit, or context problem that needs a human call. |
| 2 | Working-tree changed → step B.1 |
| 3 | codex CLI missing → tell user: `npm install -g @openai/codex && codex login`. Stop. |
| 4 | Not a git repo → tell user to `git init` or `cd` here. Stop. No `ExitPlanMode`. |
| 64 | Wrapper rejected. Print stderr verbatim. Fix arg or it's a plugin wiring bug. |

### B.0. ASSERT THE ITER ARTIFACT LANDED (exit 0)

Confirm this iter wrote `$RUN_DIR/result-iter<i>.json` — use the file-tool **`Read`**, **not** shell `test -f`. This is load-bearing: `Read` resolves the relative path against the project root, the same base that writes `state.json`, so both always key off one base; `test -f` would resolve against the live (possibly drifted) cwd and check the wrong directory. If the `Read` fails, **halt** — do not continue:

> iter `<i>` produced no artifact in `$RUN_DIR` — the run is split or the wrapper was bypassed; do not continue.

### B.1. EXIT 2 — WORKING-TREE CHANGED

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result-iter<i>.json`. Stop this iteration here. Print under `### Working-tree changed (iter <i>)`:

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

<chat_deliverables>
The user cannot see wrapper stdout, `$RUN_DIR` files, or tool results — the only way Codex's review and your validation ever reach them is the text you print in chat. `### Codex review (iter <i>)`, `### Claude validation (iter <i>)`, and finalization's `### Final Claude validation` are the product of this command, not status narration, so general guidance to keep between-tool-call text brief or to drop low-impact detail does not apply to them. Print each one as ordinary chat markdown, complete — every finding, every template line — even when it runs to hundreds of lines. A summary, an excerpt, a pointer to a file, or content that exists only in thinking does not count as printing them. In this harness every text block you emit renders in the user's transcript and persists — including text between tool calls — so mid-turn printing is real delivery; any general caution that between-tool-call text may not be shown does not apply here.
</chat_deliverables>

`Read` `$RUN_DIR/final-iter<i>.txt` — the authoritative copy of what the wrapper printed (background-shell stdout can truncate) — and print its complete contents under `### Codex review (iter <i>)`: verdict (SOUND / NEEDS REVISION / FUNDAMENTAL ISSUES) and all findings. Printing it is a gate: after that `Read`, emit the full section and the bridge line before any other tool call — no state.json edit, no validation `Read`/`Grep`, no plan edit until the review is visible in chat.

Then print this exact bridge line:

> **Revalidating each Codex finding against the actual code now; I'll print every verdict below before changing the plan.**

### D. After iter 1 ONLY: CAPTURE THREAD_ID

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json`: set `codex_thread_id` to that UUID. This is the pin every later iter's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), **halt the loop** — resuming an unidentified thread is not safe.

### E. CLAUDE VALIDATES EVERY FINDING

<investigate_before_answering>
Codex is not an authority — it can mis-cite a line or misread control flow, so your own fresh read is the safeguard. Stay skeptical by default. Read the cited file with `Read` in this iteration before you mark any verdict — never rule from context memory alone. If you haven't freshly read the code, the verdict is UNVERIFIABLE. Print the full `### Claude validation (iter <i>)` — **a chat deliverable per step C's contract** — before any edit to `PLAN_PATH`, so the user sees every verdict before the plan changes. It gates order, not the turn: once the section is in chat, carry straight on through the rest of the iteration — printing a deliverable never ends a turn; only step A's wait for Codex does.
</investigate_before_answering>

For every finding, fill all four lines:

<example>
```
- [severity] <summary>
  - Claim: <what Codex asserts>
  - Checked: <path:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <Codex's fix | different fix: ... | drop | flag to user>
```
</example>

Dispatch parallel `Agent` calls for multi-file claims — have each return a condensed summary (verdict-relevant lines and citations, not full file contents) to keep context lean; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### E.7. Architecture Checkpoint (iter <i>)

Before step F writes the refuted-log and step I updates the plan, gate findings that would silently reshape the project's architecture. Runs against every CONFIRMED finding from step E + every "What Codex missed" entry THIS ITER. The gate keys on architectural impact, not severity — a Critical fix that uses existing patterns is auto-applied, while a Medium hardening that forces every user to re-enroll is gated.

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

Print pipeline result before asking: `### Architecture checkpoint — pipeline result for "<short title>" (iter <i>)` listing files read (`path:line`), docs fetched, self-check verdict.

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
- **Skip this finding** (`Skip`) — drop; append to refuted-log (below) so Codex won't re-raise.
- **Discuss more** (`Discuss`) — follow-up `AskUserQuestion` rounds (up to 3); resolution applies, skips, or halts.

Ask one question at a time, waiting for each answer before the next. After each answer, re-run the pipeline for the remaining architectural findings (the answer may move them to APPLY-NO-ASK or DROP).

**Halt-for-offline** (only when user asks):
> ### Stopping for offline discussion
> Halting loop on `<short title>` at iter <i>. Plan at `<PLAN_PATH>` keeps prior iters' changes and this iter's APPLY-NO-ASK + APPLY-REC decisions; the architectural item is NOT applied. Re-invoke `/codexgrill:plan-loop` to resume.

Do NOT call `ExitPlanMode`. Do NOT continue to step F, G, H, I, or the next iteration.

**Record decisions** in chat under `### Architecture checkpoint — user decisions (iter <i>)`: `<title> → <pick>` per finding. Append to `state.json.iterations[i].user_decisions[]` (see step G's schema).

**Skip persistence.** Append to `$RUN_DIR/refuted-log.txt` (the wrapper plumbs `--refuted-log` to Codex's next-iter prompt — no script changes needed; runs BEFORE step F so Skip decisions land in the same refuted-log write that captures REFUTED findings):
```
- "<Codex's claim verbatim>" → user-declined architectural change at iter <i>: <one-line reason>
```

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
  "usage": "<from result-iter<i>.json.usage, optional>",
  "user_decisions": [{ "title": "<short>", "decision": "apply_rec | apply_alt_1 | apply_alt_2 | skip | halt" }]
}
```

Write the updated JSON back.

### H. BOTH-MODELS-AGREE CHECK

<chat_deliverables_check>
**Self-check:** before evaluating the exit conditions below, confirm your visible output this iteration contains `### Codex review (iter <i>)` in full and `### Claude validation (iter <i>)` with every finding and all its lines. If either is missing, summarized, or only in a file, print it now, in full, then continue.
</chat_deliverables_check>

Exit only when **all** hold:
- Codex's verdict this iter was **SOUND**.
- All CONFIRMED findings are addressed.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might not be — if real, it isn't. **Yes** → finalization. **No** → step I, then next iteration.

### I. UPDATE PLAN

Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's fix); apply anything from "What Codex missed". Skip REFUTED. UNVERIFIABLE → also recorded in `state.json.iterations[i].unverifiable_items[]` (per step G) so finalization can resolve them in one batch. In chat, list them under `### Unverified items flagged to user (iter <i>)` for this iter's awareness.

<clean_plan_body>
The plan body stays clean — it's the deliverable, so it holds only what's needed to execute the plan and must read identically across re-runs. Everything that belongs to this codexgrill plugin — the word `Codex` itself, iteration markers (`iter N`), verdict labels (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]`), model attributions like `Codex flagged` / `per Codex`, run/thread IDs, `$RUN_DIR` paths, review narratives — lives in chat + `$RUN_DIR`, not in the plan. Strip any such residue when editing.
</clean_plan_body>

Continue to the next iteration. As you end that turn — after the next iteration's step A launch returns its shell ID — close with a short recap as your final text (the final message is the durable one; it orients the user through the next long wait):

> Iteration <i>: Codex <verdict> · validation: <N> confirmed / <M> refuted / <K> unverifiable · plan updated · iteration <i+1> running.

This one closing recap is the single exception to step A's end-turn-and-do-nothing rule; it supplements the full sections printed above and never replaces them. If either section is somehow missing from this turn's visible output, print it here in full before the recap — that is gate-failure recovery, not an alternative placement.

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit:

**Unverifiable batch-question (cap-reached path):** Read `state.json.iterations[*].unverifiable_items[]`, dedupe by `claim`, filter to `load_bearing === true`. If non-empty, apply the **Batch-question procedure** defined under § Finalization below. The user shouldn't be left with unresolved load-bearing items just because we hit the cap.

Then stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

<read_only_contract>
**Self-check:** Did at least one iteration's step A actually run? If you skipped the wrapper in every iter — including because of plan-mode caution about Bash — go back to iter 1's step A now. The wrapper is read-only by construction.
</read_only_contract>

**Architecture checkpoint summary:** Read `state.json.iterations[*].user_decisions[]`, dedupe by title, print `### Architecture checkpoint — final summary` listing `<title> → <decision>`. Sanity-halt if any `decision == "halt"` reached finalization.

### Batch-question procedure

When invoked (either by cap-reached path above or finalization path below), ask in one batched free-text message (not `AskUserQuestion` — the 4-question / 4-option cap can't handle 5+ items with free-form notes):

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

Wait for the response. Parse per item. **Severity push-back rule:** if the user requests a severity downgrade for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back before applying: "Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend." After parsing: `skip` removes the entry; `include` keeps as a plain finding (no tag, no auto-appended note; decision recorded in chat + `$RUN_DIR/state.json`, not the plan body). Plan body stays clean. Recompute Net verdict if needed.

**Unverifiable batch-question (finalization path):** Read `state.json.iterations[*].unverifiable_items[]` and union by `claim` (dedupe items raised in multiple iters). Filter to `load_bearing === true`. Non-empty → halt and apply the **Batch-question procedure** above against that list.

Tell the user where artifacts live (`<RUN_DIR>`). Then run a **final Claude validation pass** — heavier than per-iter validation: re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality. Use parallel `Agent` calls for cross-file claims, each returning a condensed summary; `WebSearch` / `WebFetch` for external facts. Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode`; print the issue and wait.

**Detect plan-mode** via a system-reminder in the current turn (text like *"Plan mode is active"*). No programmatic predicate.

- **Plan-mode active** → read `PLAN_PATH` and call `ExitPlanMode` with the full plan content. If the tool schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
- **Plan-mode NOT active** → print `> Plan converged. Plan file: \`<PLAN_PATH>\`` and stop.
