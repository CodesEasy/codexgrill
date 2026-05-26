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

**Write `PLAN_PATH`** using this exact structure. **Plan body = deliverable, not provenance.** Contains only: *what* the issue is, *where* (`path:line`), *how to fix it*. No process metadata — no iteration markers (`iter N` / `(iter <i>)`), no model attributions (`Codex flagged` / `per Codex` / `from review N`), no validation tags (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]` / `[user-confirmed-despite-unverifiable]` / `[unverified_citation]` / `[line_drift]`), no run/thread IDs, no `$RUN_DIR` paths, no review narratives. All review-process state lives in chat + `$RUN_DIR`. **When editing the plan, strip any pre-existing process residue you encounter** — the plan must read identically whether the user runs this once or three times.

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

Omit any section that has no entries. If the audit produces zero findings overall, **still write the file** with an "## Summary" block stating `Critical: 0 · High: 0 · Medium: 0 · Low: 0 · Info: 0` and a one-line "No issues found" note — this signals the empty-audit branch in step 8.

## 3. WRAPPER (REQUIRED — plan mode is fine)

**You MUST run the wrapper.** Skipping it leaves you with Claude's first-pass plan only, defeating the whole skill — Codex's adversarial validation is exactly what this skill exists to provide. Step 8's `ExitPlanMode` / go-ahead prompt only runs *after* this validation completes.

**Run the Bash below — even in plan mode.** Read-only by SHA256 contract on (working tree, PLAN_PATH); exits 2 if either mutated. `$RUN_DIR` writes excluded via `DEFAULT_IGNORED_PATTERNS`. `--ephemeral` skips codex session persistence (once-mode only). `--scope` is repeatable — one instance per path in `SCOPES`.

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

Under `### Codex review`, paste the wrapper's stdout verbatim — verdict (`AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES`), validation of each Claude finding (CONFIRMED / REFUTED / EXTENDED), and any new findings Codex added. Truncated? `Read` `$RUN_DIR/review.md` (rendered markdown with quote-validation tags). Fall back to `$RUN_DIR/final.txt` only if `review.md` is absent (schema parse failed; final.txt then contains plain markdown).

Then print this exact bridge line:

> **Now revalidating each Codex finding against the actual code — no plan changes until every verdict is printed below.**

## 6. CLAUDE VALIDATES EVERY FINDING (MANDATORY)

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file BEFORE marking any verdict — context memory does NOT count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**. **Print the full `### Claude validation` BEFORE any edit to `PLAN_PATH`** — the user sees every verdict before the plan changes.

For **every** Codex finding (validation of existing + NEW), all five lines required:

```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```

Dispatch parallel `Agent` calls for multi-file claims; use `WebSearch`/`WebFetch` for external facts (CVE/GHSA, versions). Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### 6a. PHASE 3.5 — Priority handling for [unverified_citation] / [line_drift] tags

The wrapper has quote-validated each Codex finding against the cited file (whitespace-tolerant) and tagged any mismatches `[unverified_citation]` or `[line_drift]` in the Codex review you just pasted. **Before any other validation in step 6:**

1. List every bullet carrying `[unverified_citation]` or `[line_drift]`.
2. For each: fresh `Read` the cited file; `Grep` for the quoted token across the whole file; check ±50 lines around the cited line range.
3. Decide:
   - **CONFIRMED at corrected location** — quote found at different lines. Revise the citation in the plan; do NOT silently keep the wrong line range.
   - **CONFIRMED with new evidence** — quote not literal but vulnerability shape verifiable elsewhere in the file.
   - **REFUTED** — quote absent and no other evidence stands.
   - **UNVERIFIABLE** — cannot read the file, cannot decide, or evidence is genuinely indeterminate. Carry to step 8 batch-question.

`[line_drift]` alone (without `[unverified_citation]`) = citation correction, not refutation.

## 7. UPDATE PLAN_PATH

Apply each CONFIRMED finding (your **Action** may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE items → list in the plan's `## Unverified items flagged to user` section.

Recompute the `## Summary` counts.

**Plan body = deliverable, not provenance.** Contains only: *what* the issue is, *where* (`path:line`), *how to fix it*. No process metadata — no iteration markers (`iter N` / `(iter <i>)`), no model attributions (`Codex flagged` / `per Codex` / `from review N`), no validation tags (`[CONFIRMED]` / `[REFUTED]` / `[UNVERIFIABLE]` / `[user-confirmed-despite-unverifiable]` / `[unverified_citation]` / `[line_drift]`), no run/thread IDs, no `$RUN_DIR` paths, no review narratives. Only the structured sections from Phase 1 belong in the plan. **When editing the plan, strip any pre-existing process residue you encounter** — the plan must read identically whether the user runs this once or three times.

## 8. PRESENT

**Self-check:** Did step 3 run this turn? If not — for any reason, including plan-mode caution about Bash — **stop and go back to step 3 now**. Presenting Claude's first-pass plan without Codex validation is not the contract of this skill. The wrapper is read-only by construction.

### Pre-present batch-question (CANONICAL procedure — referenced by all other codexgrill files)

If `PLAN_PATH`'s `## Unverified items flagged to user` section is non-empty, halt here and ask the user in one batched message. Use a free-text prompt (**NOT `AskUserQuestion`** — the 4-question / 4-option cap can't handle 5+ items with free-form notes):

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

Wait for the response. Parse per item. **Severity push-back rule:** if the user requests a severity downgrade or "include but mark low" for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back in your reply BEFORE applying:

> Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend.

After applying user decisions, update `PLAN_PATH`'s `## Unverified items flagged to user` section:
- `skip` items: remove the entry entirely.
- `include` items: keep as a plain finding — no plugin tag, no auto-appended note. Decision recorded in chat + `$RUN_DIR/state.json`, **not** the plan body.
- Plan body stays clean (Caveat 7 rule applies).

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
