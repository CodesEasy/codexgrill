---
description: Security audit (read-only). Claude reviews, Codex validates, Claude finalizes. Single pass.
argument-hint: "[path ...] [--effort=<level>] [--model=<name>]"
---

Single-pass security audit. Claude reads the codebase + dependency manifests and writes a structured plan; Codex validates and extends; Claude re-validates against the code; finalize via `ExitPlanMode` (plan mode) or ask for go-ahead before applying fixes.

Raw arguments: `$ARGUMENTS`

## 1. PARSE ARGS

- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Everything else is a positional path. Collect into `SCOPES`:
  - Zero paths → `SCOPES = ["."]` (whole repo).
  - One or more paths → `SCOPES = [path1, path2, ...]`.

Examples:
- `/codexgrill:security-once` → whole repo
- `/codexgrill:security-once src/auth` → one path
- `/codexgrill:security-once src/auth src/billing` → multiple paths
- `/codexgrill:security-once src/auth --effort=high` → paths + flags

## 2. RESOLVE RUN_DIR + PLAN_PATH

`UNIX_SECS = <current unix timestamp in seconds>`. `SCOPE_TAG`: `"all"` if `SCOPES == ["."]`, else basenames joined by `-`, non-alphanumeric replaced with `-`, lowercased, capped at 40 chars. (e.g. `["src/auth", "src/billing"]` → `auth-billing`.)

`RUN_ID = security-once-$UNIX_SECS-$SCOPE_TAG`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`. `PLAN_PATH = .claude/plans/security-audit-$UNIX_SECS.md` — the user's deliverable, edited in place during validation.

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

Omit any section that has no entries. If the audit produces zero findings overall, **still write the file** with an "## Summary" block stating `Critical: 0 · High: 0 · Medium: 0 · Low: 0 · Info: 0` and a one-line "No issues found" note — this signals the empty-audit branch in step 8.

## 3. WRAPPER (plan mode is fine)

<read_only_contract>
Run the wrapper now — including in plan mode. It's read-only by construction (SHA256 contract on the working tree + PLAN_PATH; exits 2 if either is mutated), so it's safe here; skipping it would present an unvalidated first-pass plan, which isn't this skill's job — Codex's adversarial validation is exactly what this skill exists to provide, and step 8's `ExitPlanMode` / go-ahead prompt only runs *after* it completes. `$RUN_DIR` writes are excluded via `DEFAULT_IGNORED_PATTERNS`. `--ephemeral` skips codex session persistence — once-mode only, since there's no later iteration to resume. `--scope` is repeatable — one instance per path in `SCOPES`.
</read_only_contract>

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/security-audit.mjs" \
  --plan "<PLAN_PATH>" \
  --run-dir "<RUN_DIR>" \
  --scope "<SCOPES[0]>" [--scope "<SCOPES[1]>" ...] \
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

Read `WORKING_TREE_CHANGED:<files>` from stderr + `preIterStash.{hash, isEmpty, noHead}` from `$RUN_DIR/result.json`. Note: `changedFiles` may include `PLAN_PATH` itself — the security wrapper has explicit SHA256 hashing of the plan file (because `.claude/` is gitignored and the git-status snapshot would miss mutations there).

Print under `### Working-tree changed`:

> Hi — I found these files changed during this run:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the run was in progress. Were these changes made by you?

Halt entirely. Do **not** edit the plan further. Do **not** call `ExitPlanMode`. Wait for the user.

- **User says yes (their edit / IDE):** acknowledge ("OK — leaving things as they are"). If the file looks auto-generated and tracked (`.idea/*.iml`, build artifacts, framework caches), offer to add to `.gitignore` — only if truly auto-generated. Stop — user re-invokes when ready.
- **User says no / "must be Codex":** offer Revert (destructive — confirm first, verify with `git status` after) OR Stop. **Note: the security plan file at `PLAN_PATH` is gitignored, so the revert does NOT restore it — re-running the audit produces a fresh plan.** Originally-untracked files re-appear as staged additions (bytes match). Revert dispatch on `preIterStash`:
  - `isEmpty === false` → `git restore --source=<hash> --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === false` → `git restore --source=HEAD --staged --worktree -- :/ && git clean -fd`
  - `isEmpty === true && noHead === true` → `git clean -fd` only (no prior content to restore)

## 5. PRINT CODEX'S REVIEW + BRIDGE

<chat_deliverables>
The user cannot see wrapper stdout, `$RUN_DIR` files, or tool results — the only way Codex's review and your validation ever reach them is the text you print in chat. `### Codex review` and `### Claude validation` are the product of this command, not status narration, so general guidance to keep between-tool-call text brief or to drop low-impact detail does not apply to them. Print each one as ordinary chat markdown, complete — every finding, every template line — even when it runs to hundreds of lines. A summary, an excerpt, a pointer to a file, or content that exists only in thinking does not count as printing them.
</chat_deliverables>

`Read` `$RUN_DIR/review.md` (rendered markdown with quote-validation tags); fall back to `$RUN_DIR/final.txt` only if `review.md` is absent (schema parse failed). Print its complete contents under `### Codex review`: verdict (`AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES`), validation of each Claude finding (CONFIRMED / REFUTED / EXTENDED), and any new findings. The artifact file is the source, not the background shell's stdout.

Then print this exact bridge line:

> **Revalidating each Codex finding against the actual code now; I'll print every verdict below before changing the plan.**

## 6. CLAUDE VALIDATES EVERY FINDING

<investigate_before_answering>
Codex is not an authority — it can mis-cite a line or misread control flow, so your own fresh read is the safeguard. Stay skeptical by default. Read the cited file with `Read` before you mark any verdict — never rule from context memory alone. If you haven't freshly read the code, the verdict is UNVERIFIABLE. Print the full `### Claude validation` — **a chat deliverable per step 5's contract** — before any edit to `PLAN_PATH`, so the user sees every verdict before the plan changes.
</investigate_before_answering>

For every Codex finding (validation of existing + NEW), fill all five lines:

<example>
```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```
</example>

Dispatch parallel `Agent` calls for multi-file claims — have each return a condensed summary (verdict-relevant lines and citations, not full file contents) to keep context lean; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### 6a. PHASE 3.5 — Priority handling for [unverified_citation] / [line_drift] tags

The wrapper has quote-validated each Codex finding against the cited file (whitespace-tolerant) and tagged any mismatches `[unverified_citation]` or `[line_drift]` in the Codex review you just printed. **Before any other validation in step 6:**

1. List every bullet carrying `[unverified_citation]` or `[line_drift]`.
2. For each: fresh `Read` the cited file; `Grep` for the quoted token across the whole file; check ±50 lines around the cited line range.
3. Decide:
   - **CONFIRMED at corrected location** — quote found at different lines. Revise the citation in the plan rather than silently keeping the wrong line range.
   - **CONFIRMED with new evidence** — quote not literal but vulnerability shape verifiable elsewhere in the file.
   - **REFUTED** — quote absent and no other evidence stands.
   - **UNVERIFIABLE** — cannot read the file, cannot decide, or evidence is genuinely indeterminate. Carry to step 8 batch-question.

`[line_drift]` alone (without `[unverified_citation]`) = citation correction, not refutation.

### 6b. Architecture Checkpoint

Before step 7 applies findings to `PLAN_PATH`, gate findings that would silently reshape the project's architecture. Runs against every CONFIRMED finding from step 6 / 6a and every entry under "What Codex missed". The gate keys on architectural impact, not severity — a Critical fix that uses existing patterns is auto-applied, while a Medium hardening that forces every user to re-enroll is gated.

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
- **Discuss more** (`Discuss`) — follow-up `AskUserQuestion` rounds (up to 3) to clarify concerns / scope / direction; resolution applies, skips, or halts. Halt only if user says they need offline time.

Ask one question at a time, waiting for each answer before the next. After each answer, re-run the pipeline for the remaining architectural findings (the answer may move them to APPLY-NO-ASK or DROP).

**Halt-for-offline** (only when user asks):
> ### Stopping for offline discussion
> Halting workflow on `<short title>`. Plan at `<PLAN_PATH>` keeps applied changes from this turn; the architectural item is NOT applied. Re-invoke `/codexgrill:security-once` to resume.

Do NOT call `ExitPlanMode`.

**Record decisions** in chat under `### Architecture checkpoint — user decisions`: `<title> → <pick>` per finding.

## 7. UPDATE PLAN_PATH

Apply each CONFIRMED finding (your **Action** may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE items → list in the plan's `## Unverified items flagged to user` section.

Recompute the `## Summary` counts.

<clean_plan_body>
The plan body stays clean — it's the deliverable, so it holds only the structured findings sections and must read identically across re-runs. Everything that belongs to this codexgrill plugin — the word `Codex` itself, iteration markers (`iter N`), verdict labels (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]`), model attributions like `Codex flagged` / `per Codex`, run/thread IDs, `$RUN_DIR` paths, review narratives — lives in chat + `$RUN_DIR`, not in the plan. Strip any such residue when editing.
</clean_plan_body>

## 8. PRESENT

<read_only_contract>
**Self-check:** Did step 3 run this turn? If not — for any reason, including plan-mode caution about Bash — stop and go back to step 3 now. Presenting Claude's first-pass plan without Codex validation is not the contract of this skill. The wrapper is read-only by construction.
</read_only_contract>

<chat_deliverables_check>
**Self-check:** before `ExitPlanMode` (or the closing message when plan mode is off), confirm your visible output this turn contains `### Codex review` in full and `### Claude validation` with every finding and all its lines. If either is missing, summarized, or only in a file, print it now, in full, then continue.
</chat_deliverables_check>

### Pre-present batch-question

If `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty, halt here and ask the user in one batched message. Use a free-text prompt (not `AskUserQuestion` — the 4-question / 4-option cap can't handle 5+ items with free-form notes):

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

Wait for the response. Parse per item. **Severity push-back rule:** if the user requests a severity downgrade or "include but mark low" for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back in your reply before applying:

> Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend.

After applying user decisions, update `PLAN_PATH`'s `## Unverified items flagged to user` section:
- `skip` items: remove the entry entirely.
- `include` items: keep as a plain finding — no plugin tag, no auto-appended note. Decision recorded in chat + `$RUN_DIR/state.json`, **not** the plan body.
- Plan body stays clean (per step 7's clean-plan-body rule).

Recompute severity counts in the `## Summary` block (skipped items reduce counts). Then proceed to the empty-audit branch and plan-mode detection below — both will now see the post-resolution state.

### Empty-audit branch (handle first after batch-question)

If `PLAN_PATH` has zero findings (Critical + High + Medium + Low + Info all zero) after step 7, skip the "should I proceed with fixes" prompt. Print:

> ### No security issues found
> Audited `<scope summary>`. Plan at `<PLAN_PATH>` for the record. Nothing to fix.

Then either call `ExitPlanMode` with the plan content (if plan mode active per the detection rule below) or stop here.

### Plan-mode detection

Claude Code surfaces an active plan-mode via a system-reminder in the current turn (text like *"Plan mode is active"*). No programmatic predicate — check whether such a reminder is present in this turn's context.

- **Plan mode active:** call `ExitPlanMode` with the final `PLAN_PATH` contents. Stop here. Fixes are the user's call (they approve through the plan-mode UX). If the schema isn't loaded, fetch via `ToolSearch select:ExitPlanMode`.
- **Plan mode NOT active:** print a short summary in chat with the path to `PLAN_PATH` and ask:
  > Audit complete. Plan: `<PLAN_PATH>`. Review it and let me know — should I proceed with the fixes, or do you want to make changes first?

  Wait for the user. **Only on explicit go-ahead** (e.g., "yes proceed", "go ahead", or equivalent — not just acknowledgment) do you continue to step 9. If the user wants to make changes first or has questions, address those instead.

## 9. APPLY FIXES (only after explicit go-ahead in step 8, non-plan-mode branch)

1. Create a `TodoWrite` list with one item per CONFIRMED finding, ordered by severity (Critical first). If the schema isn't loaded, fetch via `ToolSearch select:TodoWrite`.
2. For each finding, working through the todo list in order:
   - Mark the todo `in_progress`.
   - Fresh `Read` the cited file (context memory doesn't count).
   - Apply the recommended fix using `Edit` (or `Write` for new files like config additions).
   - Run any relevant verification command if the fix has one (e.g., `npm audit fix` for dependency bumps, type-check / lint for code edits).
   - Mark the todo `completed`.
3. After all fixes: short summary, list any items that needed user judgment (e.g., dependency bumps that may break callers), tell the user to review and commit.
