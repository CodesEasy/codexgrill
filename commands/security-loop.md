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

Read the codebase within `SCOPES` and write a structured findings file at `PLAN_PATH`.

**Read scope:**
- For each scope path, walk it and `Read` the source files.
- Large scopes → dispatch parallel `Agent` (Explore) calls per top-level directory to surface candidates.
- Identify language/ecosystem and read dependency manifests: `package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, etc.

**External research:**
For each declared dependency at its declared version, query authoritative advisory sources via `WebSearch`/`WebFetch`:
- GitHub Security Advisories (`github.com/advisories`)
- National Vulnerability Database (NVD)
- Vendor security advisories
- Package registry security tabs (npm, PyPI, crates.io, etc.)

**Cite primary sources only** — link directly to GHSA-XXXX / CVE-YYYY-ZZZZ pages, not aggregators.

**Categories to scan for** (anchored to OWASP Top 10 + CWE):

- Injection (SQL, command, LDAP, NoSQL, template) — CWE-89/77/78/94
- Auth/session flaws — CWE-287/384
- Broken access control / IDOR — CWE-285/639
- Cryptographic failures (weak algos, ECB, hardcoded keys, weak RNG) — CWE-327/328/330/331
- Hardcoded secrets / credentials in source — CWE-798/259
- SSRF — CWE-918
- Path traversal — CWE-22
- Insecure deserialization — CWE-502
- XSS (stored/reflected/DOM) — CWE-79
- CSRF — CWE-352
- Open redirects — CWE-601
- Race conditions / TOCTOU — CWE-362/367
- Sensitive data exposure in logs — CWE-532
- Missing/insecure security headers (web apps) — CWE-693
- Vulnerable & outdated dependencies — CWE-1104
- CORS misconfig — CWE-942
- Insecure defaults / misconfig — CWE-1188

**Write `PLAN_PATH`** using this exact structure.

<clean_plan_body>
The plan body stays clean — it's the deliverable, so it holds only the structured findings sections and must read identically across re-runs. Everything that belongs to this codexgrill plugin — the word `Codex` itself, iteration markers (`iter N`), verdict labels (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]`), model attributions like `Codex flagged` / `per Codex`, run/thread IDs, `$RUN_DIR` paths, review narratives — lives in chat + `$RUN_DIR`, not in the plan. Strip any such residue when editing.
</clean_plan_body>

<example>
```markdown
# Security audit — <repo name> — <ISO date>

**Scope**: <comma-joined paths, or "whole repo" when SCOPES == ["."]>

## Summary
- Critical: N · High: N · Medium: N · Low: N · Info: N

## Findings

### [CRITICAL] <short title>
- **CWE**: CWE-XXXX ([link to MITRE entry])
- **CVE / GHSA**: <id + link, if applicable>
- **Location**: `path/to/file.ext:LINE-LINE`
- **Evidence**:
  ```<lang>
  <code snippet showing the issue>
  ```
- **Why it's vulnerable**: <one paragraph, threat-model framing>
- **Recommended fix** (industry standard):
  ```<lang>
  <concrete code or config change — copy-pasteable>
  ```
- **References**:
  - <vendor doc URL>
  - <OWASP cheatsheet URL>

### [HIGH] <next title>
...

## Dependency findings

### [HIGH] <package>@<version> — <CVE-XXXX-YYYY>
- **Severity**: <upstream severity, e.g. "GHSA: High, CVSS 8.1">
- **Advisory**: <GHSA/NVD link>
- **Fixed in**: <version>
- **Recommended action**: bump to `<safe version>` and run <package-manager> audit.

## Unverified items flagged to user
- <thing Claude couldn't conclusively verify, with why>
```
</example>

Omit any section that has no entries. If the audit produces zero findings overall, **still write the file** with an "## Summary" block stating `Critical: 0 · High: 0 · Medium: 0 · Low: 0 · Info: 0` and a one-line "No issues found" note — signals the empty-audit branch at finalization.

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

### A. WRAPPER (plan mode is fine)

<read_only_contract>
Run the wrapper now — including in plan mode, every iteration. It's read-only by construction (SHA256 contract on the working tree + PLAN_PATH; exits 2 if either is mutated), so it's safe here; skipping it would present an unvalidated first-pass plan, which isn't this skill's job. `$RUN_DIR` writes are excluded via `DEFAULT_IGNORED_PATTERNS`.
</read_only_contract>

**Iteration 1** (fresh thread — must not use `--ephemeral`; persistence is required for iter 2's resume):
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

**Wait:** launch with `run_in_background: true`. Codex often runs 30+ min — a long silent wait is normal. **The completion notification is the only done signal**: mid-run stderr is Codex's internal noise (`[codex] $ ...` = its activity, not wrapper status); `result-iter<i>.json` / `final-iter<i>.txt` / `codex-iter<i>.jsonl` don't exist until exit; prompt size never proves context exhaustion. Once the launch returns its shell ID, **end your turn and do nothing until the notification** — no `Read`, `Grep`, `Monitor`, `ScheduleWakeup` heartbeat, or `$RUN_DIR` polling, and no "still waiting" narration. The harness re-invokes you on exit; that's what advances to step B.

### B. BRANCH ON EXIT CODE

| code | action |
|---|---|
| 0 | continue to step C |
| 1 | Quote `errorReason` from `$RUN_DIR/result-iter<i>.json` verbatim — that's the authoritative diagnosis. If it contains `context window`, suggest `--effort=high`. For auth or rate-limit messages, halt verbatim. Otherwise halt with the exact `errorReason`. Diagnose from `errorReason` alone — don't silently fall back to `--mode fresh`, and don't auto-retry, which can mask an auth, rate-limit, or context problem that needs a human call. |
| 2 | Working-tree changed → step B.1 |
| 3 | codex CLI missing → tell user: `npm install -g @openai/codex && codex login`. Stop. |
| 4 | Not a git repo → tell user to `git init` or `cd` here. Stop. No `ExitPlanMode`. |
| 64 | Wrapper rejected. Print stderr verbatim. Fix arg or it's a plugin wiring bug. |

### B.1. EXIT 2 — WORKING-TREE CHANGED

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result-iter<i>.json`. Note: `changedFiles` may include `PLAN_PATH` itself (gitignored-plan-file SHA256 check). Stop this iteration here. Print under `### Working-tree changed (iter <i>)`:

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

> **Revalidating each Codex finding against the actual code now; I'll print every verdict below before changing the plan.**

### D. After iter 1 ONLY: CAPTURE THREAD_ID

`Read` `$RUN_DIR/result-iter1.json`. Extract `threadId`. Update `$RUN_DIR/state.json`: set `codex_thread_id` to that UUID. This is the pin every later iter's `--resume-thread-id` reads. If `threadId` is `null` (Codex never emitted `thread.started`), **halt the loop** — resuming an unidentified thread is not safe.

### E. CLAUDE VALIDATES EVERY FINDING

<investigate_before_answering>
Codex is not an authority — it can mis-cite a line or misread control flow, so your own fresh read is the safeguard. Stay skeptical by default. Read the cited file with `Read` in this iteration before you mark any verdict — never rule from context memory alone. If you haven't freshly read the code, the verdict is UNVERIFIABLE. Print the full `### Claude validation (iter <i>)` before any edit to `PLAN_PATH`, so the user sees every verdict before the plan changes.
</investigate_before_answering>

For every Codex finding (validation of existing + NEW), fill all five lines:

<example>
```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ this iteration>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```
</example>

Dispatch parallel `Agent` calls for multi-file claims — have each return a condensed summary (verdict-relevant lines and citations, not full file contents) to keep context lean; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### E.5. PHASE 3.5 — Priority handling for [unverified_citation] / [line_drift] tags (iter <i>)

The wrapper has quote-validated each Codex finding against the cited file (whitespace-tolerant) and tagged any mismatches `[unverified_citation]` or `[line_drift]` in the Codex review you just pasted. **Before any other validation in step E:**

1. List every bullet carrying `[unverified_citation]` or `[line_drift]`.
2. For each: fresh `Read` the cited file; `Grep` for the quoted token across the whole file; check ±50 lines around the cited line range.
3. Decide:
   - **CONFIRMED at corrected location** — quote found at different lines. Revise the citation in the plan rather than silently keeping the wrong line range.
   - **CONFIRMED with new evidence** — quote not literal but vulnerability shape verifiable elsewhere in the file.
   - **REFUTED** — quote absent and no other evidence stands.
   - **UNVERIFIABLE** — cannot read the file, cannot decide, or evidence is genuinely indeterminate. Carry to finalization batch-question.

`[line_drift]` alone (without `[unverified_citation]`) = citation correction, not refutation. **UNVERIFIABLE items accumulate in `PLAN_PATH`'s `## Unverified items flagged to user` section across iterations** — resolved in ONE batch at finalization, never per iter.

### E.7. Architecture Checkpoint (iter <i>)

Before step F writes the refuted-log and step I updates the plan, gate findings that would silently reshape the project's architecture. Runs against every CONFIRMED finding from step E + every "What Codex missed" entry THIS ITER. Security findings are often genuinely architectural (replace custom auth with OAuth, PBKDF2 → Argon2id with re-enrollment, repo-wide CSP nonce middleware), so the gate keys on architectural impact, not severity — a Critical SQL-injection fix that uses existing parameterization patterns is auto-applied, while a Medium hardening that forces every user to re-enroll is gated.

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
> Halting loop on `<short title>` at iter <i>. Plan at `<PLAN_PATH>` keeps prior iters' changes and this iter's APPLY-NO-ASK + APPLY-REC decisions; the architectural item is NOT applied. Re-invoke `/codexgrill:security-loop` to resume.

Do NOT call `ExitPlanMode`. Do NOT continue to step F, G, H, I, or the next iteration.

**Record decisions** in chat under `### Architecture checkpoint — user decisions (iter <i>)`: `<title> → <pick>` per finding. Append to `state.json.iterations[i].user_decisions[]` (see step G's schema).

**Skip persistence.** Append to `$RUN_DIR/refuted-log.txt` (the wrapper plumbs `--refuted-log` to Codex's next-iter prompt — no script changes needed):
```
- "<Codex's claim verbatim>" → user-declined architectural change at iter <i>: <one-line reason>
```

### F. UPDATE REFUTED-LOG (cumulative)

If any REFUTED findings exist (this iter or prior), `Write` `$RUN_DIR/refuted-log.txt` with the cumulative list. The next iter's wrapper prepends it to the prompt:

```
PREVIOUSLY REFUTED — do not re-raise without new evidence:
- "<Codex's claim>" → <reason with path:line cite>
...
```

If no refutations exist yet, do **not** write the file.

### G. RECORD ITERATION in state.json

Read `$RUN_DIR/state.json`, set `current_iter = <i>`, append. Note: this schema deliberately omits `unverifiable_items[]` — UNVERIFIABLE items for security accumulate in `PLAN_PATH`'s `## Unverified items flagged to user` section instead, and are resolved in one batch at finalization (per E.5 above).

```json
{
  "iter": <i>,
  "codex_thread_id": "<state.codex_thread_id>",
  "codex_verdict": "AUDIT CLEAN | NEEDS REVISION | CRITICAL ISSUES",
  "claude_validation": {"confirmed": N, "refuted": N, "unverifiable": N},
  "containment_ok": true,
  "usage": "<from result-iter<i>.json.usage, optional>",
  "user_decisions": [{ "title": "<short>", "decision": "apply_rec | apply_alt_1 | apply_alt_2 | skip | halt" }]
}
```

Write the updated JSON back.

### H. BOTH-MODELS-AGREE CHECK

Exit only when **all** hold:
- Codex's verdict this iter was **AUDIT CLEAN**.
- All CONFIRMED findings (Claude's verdicts on Codex's claims) are addressed in `PLAN_PATH`.
- Your "What Codex missed" pass is empty.
- No UNVERIFIABLE finding is load-bearing.

Before deciding "clean", state the strongest reason it might not be — if real, it isn't. **Yes** → finalization. **No** → step I, then next iteration.

### I. UPDATE PLAN_PATH

Re-read `PLAN_PATH`. Apply each CONFIRMED finding using your **Action** (may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE → list under the plan's `## Unverified items flagged to user` section (accumulates across iters; resolved in one batch at finalization).

Recompute the `## Summary` counts.

<clean_plan_body>
The plan body stays clean — it's the deliverable, so it holds only the structured findings sections and must read identically across re-runs. Everything that belongs to this codexgrill plugin — the word `Codex` itself, iteration markers (`iter N`), verdict labels (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]`), model attributions like `Codex flagged` / `per Codex`, run/thread IDs, `$RUN_DIR` paths, review narratives — lives in chat + `$RUN_DIR`, not in the plan. Strip any such residue when editing.
</clean_plan_body>

### Cap reached without converging

If `i == MAX_ITERS` and step H didn't exit:

**Unverifiable batch-question (cap-reached path):** Even though we're stopping without convergence, if `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty, apply the **Batch-question procedure** defined under § Finalization below — the user shouldn't be left with unresolved unverified items just because the loop hit the cap. Apply decisions to the plan, then print the ⏸ message and stop as written.

Stop the loop. Print `### ⏸ Did not converge in <MAX_ITERS> rounds`. Show Codex's last review and your last validation as a summary. Tell the user: "Cap reached. Latest plan is at `<PLAN_PATH>`. Run artifacts in `<RUN_DIR>`. Waiting for your instruction — bump `--max`, edit manually, or accept as-is." Do not call `ExitPlanMode`.

## Finalization

<read_only_contract>
**Self-check:** Did at least one iteration's step A actually run? If you skipped the wrapper in every iter — including because of plan-mode caution about Bash — go back to iter 1's step A now. Presenting Claude's first-pass plan without any Codex validation is not the contract of this skill. The wrapper is read-only by construction.
</read_only_contract>

**Architecture checkpoint summary:** Read `state.json.iterations[*].user_decisions[]`, dedupe by title, print `### Architecture checkpoint — final summary` listing `<title> → <decision>`. Sanity-halt if any `decision == "halt"` reached finalization.

Tell the user where artifacts live (`<RUN_DIR>`). Then run a **final Claude validation pass** — heavier than per-iter validation: re-verify every claim, code citation, version, file path, and external fact in `PLAN_PATH` against reality. Use parallel `Agent` calls for cross-file claims, each returning a condensed summary; `WebSearch` / `WebFetch` for external facts. Under `### Final Claude validation`, list what you checked. If anything is wrong, ambiguous, or missing — even something Codex blessed — do **not** call `ExitPlanMode` or `AskUserQuestion`; print the issue and wait.

### Batch-question procedure

When invoked (either by cap-reached path above or finalization path below), ask in one batched free-text message (not `AskUserQuestion` — the 4-question / 4-option cap can't handle 5+ items with free-form notes):

> ### Unverified items — your input needed
> Codex flagged the following findings that I could not independently verify. For each, reply with the item number and one of:
> - `skip` — drop from the plan
> - `include` — keep the entry as a plain finding (no tag, no annotation)
>
> 1. **[severity] <short title>** — `<path:line>` — <one-line reason it's unverifiable>
>    Codex's claim: <one-line claim verbatim>
>    Quote: `<quote or "(none)">`
> 2. ...
>
> Reply in one message, e.g. `1. skip · 2. include · 3. skip`

Wait for the response. Parse per item. **Severity push-back rule:** if the user requests a severity downgrade for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back before applying: "Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend."

After applying user decisions, update `PLAN_PATH`'s `## Unverified items flagged to user` section: `skip` items removed; `include` items kept as plain findings (no tag, no auto-appended note; decision recorded in chat + `$RUN_DIR/state.json`, not the plan body). Plan body stays clean. Recompute severity counts in the `## Summary` block.

**Unverifiable batch-question (finalization path):** If `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty after convergence, halt and apply the **Batch-question procedure** above. Resolve all unverifiable items in one user round-trip. Then continue to the presentation rules below.

### Presentation

- **Empty-audit branch (handle first after batch-question):** If `PLAN_PATH` has zero findings (Critical + High + Medium + Low + Info all zero) after step I, skip the "should I proceed with fixes" prompt. Print:

  > ### No security issues found
  > Audited `<scope summary>`. Plan at `<PLAN_PATH>` for the record. Nothing to fix.

  Then either call `ExitPlanMode` with the plan content (if plan mode active per detection below) or stop here.

- **Plan-mode detection:** Claude Code surfaces an active plan-mode via a system-reminder in the current turn (text like *"Plan mode is active"*). No programmatic predicate — check whether such a reminder is present in this turn's context.
  - **Plan mode active:** call `ExitPlanMode` with the final `PLAN_PATH` contents. Stop here. Fixes are the user's call (they approve through the plan-mode UX). If the schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
  - **Plan mode NOT active:** print a short summary in chat with the path to `PLAN_PATH` and ask:
    > Audit complete. Plan: `<PLAN_PATH>`. Review it and let me know — should I proceed with the fixes, or do you want to make changes first?

    Wait for the user. **Only on explicit go-ahead** (e.g., "yes proceed", "go ahead", or equivalent — not just acknowledgment) do you continue to Apply fixes below.

## Apply fixes (only after explicit go-ahead, non-plan-mode branch)

1. Create a `TodoWrite` list with one item per CONFIRMED finding, ordered by severity (Critical first). If the schema isn't loaded, fetch via `ToolSearch select:TodoWrite`.
2. For each finding, working through the todo list in order:
   - Mark the todo `in_progress`.
   - Fresh `Read` the cited file (context memory doesn't count).
   - Apply the recommended fix using `Edit` (or `Write` for new files like config additions).
   - Run any relevant verification command if the fix has one (e.g., `npm audit fix` for dependency bumps, type-check / lint for code edits).
   - Mark the todo `completed`.
3. After all fixes: short summary, list any items that needed user judgment (e.g., dependency bumps that may break callers), tell the user to review and commit.
