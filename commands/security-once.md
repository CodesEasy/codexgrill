---
description: Security audit (read-only). Claude reviews, Codex validates, Claude finalizes. Single pass.
argument-hint: "[path ...] [--effort=<level>] [--model=<name>]"
---

Run a single-pass security audit. Claude does the initial review by reading the codebase and dependency manifests, writes a structured security plan file, then sends it to Codex for read-only validation and extension. Claude validates Codex's response against the code, finalizes the plan, and either calls `ExitPlanMode` (plan mode) or asks the user for go-ahead before applying fixes.

Raw arguments: `$ARGUMENTS`

## Steps

### 1. Parse `$ARGUMENTS`

- `--effort=<level>` → `EFFORT` (one of `none|minimal|low|medium|high|xhigh`). Default: omit.
- `--model=<name>` → `MODEL`. Default: omit.
- Everything else is a positional path. Collect them into `SCOPES`:
  - Zero paths → `SCOPES = ["."]` (whole repo).
  - One or more paths → `SCOPES = [path1, path2, ...]`.

Examples:
- `/codexgrill:security-once` → whole repo
- `/codexgrill:security-once src/auth` → one path
- `/codexgrill:security-once src/auth src/billing` → multiple paths
- `/codexgrill:security-once src/auth --effort=high` → paths + flags

### 2. Resolve `RUN_DIR` and `PLAN_PATH`

1. `UNIX_SECS = <current unix timestamp in seconds>`.
2. `SCOPE_TAG`:
   - If `SCOPES == ["."]` → `SCOPE_TAG = "all"`.
   - Else → join the path basenames with `-`, replace non-alphanumeric with `-`, lowercase, cap at 40 chars. (e.g. `["src/auth", "src/billing"]` → `auth-billing`.)
3. `RUN_ID = security-once-$UNIX_SECS-$SCOPE_TAG`. `RUN_DIR = .claude/temp/codexgrill/$RUN_ID`.
4. `PLAN_PATH = .claude/plans/security-audit-$UNIX_SECS.md` (the user's deliverable, edited in place during validation).

### 3. Phase 1 — Claude's initial security review (no Codex yet)

Read the codebase within `SCOPES` and write a structured findings file at `PLAN_PATH`.

**Read scope:**
- For each scope path, walk it and `Read` the source files.
- For large scopes, dispatch parallel `Agent` (Explore) calls per top-level directory to surface candidate files in parallel.
- Identify language/ecosystem and read dependency manifests: `package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, etc.

**External research:**
- For each declared dependency at its declared version, query authoritative advisory sources via `WebSearch`/`WebFetch`:
  - GitHub Security Advisories (`github.com/advisories`)
  - National Vulnerability Database (NVD)
  - Vendor security advisories
  - Package registry security tabs (npm, PyPI, crates.io, etc.)
- **Cite primary sources only** — link directly to GHSA-XXXX / CVE-YYYY-ZZZZ pages, not aggregators.

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

**Write `PLAN_PATH`** using this exact structure (plan file = user's deliverable; keep it clean of plugin metadata):

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

Omit any section that has no entries. If the audit produces zero findings overall, still write the file with an "## Summary" block stating 0 / 0 / 0 / 0 / 0 and a one-line "No issues found" note — this signals the empty-audit branch in Phase 4.

### 4. Phase 2 — Codex validation (REQUIRED, do not skip)

**You MUST invoke the wrapper. Skipping this step defeats the entire skill — without Codex's adversarial validation, you have only Claude's first pass, which is exactly what this skill exists to second-opinion.** Phase 4's `ExitPlanMode` / go-ahead prompt only runs *after* this validation completes.

**Plan mode is fine.** The wrapper is read-only by construction: it computes a SHA256 hash of the working tree and of `PLAN_PATH` before and after Codex runs, and exits with code 2 (rejecting the run) if anything changed. The Bash invocation below is safe to execute in plan mode — equivalent to running a read-only script.

Invoke the wrapper. `--scope` is repeatable — one instance per path in `SCOPES`:

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

`--ephemeral` skips codex session persistence (once-mode only).

**How to wait for completion.** Launch the wrapper with `run_in_background: true`. The system will notify you when the background command exits — that notification is the **only** authoritative "done" signal.

**Codex can take 30+ minutes — wait for it to finish.** Run the wrapper in the background and do nothing else until the completion notification arrives. Verification of the findings begins after the report is ready, not before.

Do **not**:
- start a Monitor on the wrapper's stderr to check whether it's "done" — the wrapper streams progress lines (e.g. `[codex] $ <command>`, `[codex] ✗ tool returned code N`, `[codex] » <message>`) that describe Codex's internal activity, not wrapper status;
- read `result.json` / `final.txt` / `codex.jsonl` before the completion notification — they are written incrementally or only-on-exit; the `result.json` file does not exist until the wrapper finishes, and absence of `turn.completed` mid-stream is not failure;
- infer context-window exhaustion (or any other cause) from stderr volume, JSONL length, or prompt size while the wrapper is still running.

When the notification arrives, branch on the background command's exit code per the table below. For diagnosis details, read `$RUN_DIR/result.json` — its `errorReason` field is the authoritative Codex error, parsed from the JSONL `turn.failed` / `error` events.

### 5. Handle the exit code

- **0** — continue to step 6.
- **2** — working-tree changed during the run. See "Exit 2 — working-tree changed" below.
- **3** — codex CLI not installed. Tell the user: `npm install -g @openai/codex`, then `codex login`. Stop.
- **4** — not a git working tree. Tell the user to `git init` here or `cd` into the repo. Stop. Do **not** call `ExitPlanMode`.
- **1** — codex exec failed. Read `$RUN_DIR/result.json` and quote its `errorReason` field verbatim — that is Codex's own error message (parsed from the JSONL `turn.failed` / `error` events) and the authoritative diagnosis. Do not infer the cause from stderr text, stream length, or prompt size. If `errorReason` literally contains `context window`, then (and only then) suggest `--effort=high` (often triggered by `model_reasoning_effort = "xhigh"` in `~/.codex/config.toml`). For auth or rate-limit messages, print verbatim and halt. Otherwise print the raw `errorReason` and ask the user how to proceed. Never auto-retry.
- **64** — wrapper rejected the call. Print stderr verbatim. Fix the arg if user-supplied, else it's a plugin wiring bug.

#### Exit 2 — working-tree changed

Read the stderr marker `WORKING_TREE_CHANGED:<comma-separated-files>` and `$RUN_DIR/result.json` for `preIterStash.hash` / `preIterStash.isEmpty` / `preIterStash.noHead`. Note that `changedFiles` may include `PLAN_PATH` itself — the security wrapper has explicit SHA256 hashing of the plan file (because `.claude/` is gitignored and the git-status snapshot would miss mutations there).

Print under `### Working-tree changed`:

> Hi — I found these files changed during this run:
> - `<file1>`
> - `<file2>`
>
> It could be an edit made by Codex (which is supposed to be read-only) **or** something you changed while the run was in progress. Were these changes made by you?

Halt. Do **not** edit the plan further. Do **not** call `ExitPlanMode`. Wait for the user.

- **User says yes (they edited / it was their IDE):** acknowledge ("OK — leaving things as they are"). Then, **if the changed file looks like auto-generated noise that's currently tracked** (e.g., `.idea/*.iml`, build artifacts, framework caches), ask: "Want me to add `<file>` to `.gitignore` so this check doesn't trip on it again? Only say yes if it's truly auto-generated — committing it might be intentional." If yes, append the path (or a sensible pattern) to the project's root `.gitignore`. Then stop — user can re-invoke when ready.
- **User says no / "it must be Codex":** say:
  > Then this looks like Codex breaking the read-only contract. What would you like me to do?
  > - **Revert** the working tree to the content state from before this run. Originally-untracked files re-appear as staged additions (bytes match, `git status` will look different). Note: the security plan file at `PLAN_PATH` is gitignored, so the revert does NOT restore it — re-running the audit produces a fresh plan.
  > - **Stop** the run and leave the changes in place so you can inspect.

  If the user accepts revert, dispatch on `preIterStash` (all branches are destructive — confirm with the user before running, then verify with `git status` after):

  - `preIterStash.isEmpty === false` (snapshot exists, with or without HEAD):
    ```bash
    git restore --source=<preIterStash.hash> --staged --worktree -- :/
    git clean -fd
    ```

  - `preIterStash.isEmpty === true && noHead === false` (clean pre-run tree, HEAD exists): restore from HEAD.
    ```bash
    git restore --source=HEAD --staged --worktree -- :/
    git clean -fd
    ```

  - `preIterStash.isEmpty === true && noHead === true` (fresh repo, empty pre-run tree): `git clean -fd` only — no prior content to restore.

### 6. Print Codex's review

Under `### Codex review`, paste the wrapper's stdout verbatim — the verdict (`AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES`), validation of each Claude finding (CONFIRMED / REFUTED / EXTENDED), and any new findings Codex added. If chat output was truncated, `Read` `$RUN_DIR/review.md` (the rendered markdown with quote-validation tags). Fall back to `$RUN_DIR/final.txt` only if `review.md` is absent (means schema parse failed; final.txt then contains plain markdown).

Then print this exact bridge line in chat so the user sees the handoff to validation:

> **Now revalidating each Codex finding against the actual code — no plan changes until every verdict is printed below.**

### 7. Phase 3 — Claude validates Codex's response

Codex is not an authority. Default posture: skeptical. **MANDATORY: invoke `Read` on the cited file before marking any verdict — context memory does not count.** If you haven't freshly read the code, the verdict is **UNVERIFIABLE**. **Print the full `### Claude validation` section in chat BEFORE any edit to `PLAN_PATH`** — the user sees every verdict (CONFIRMED, REFUTED, UNVERIFIABLE) before the plan changes.

Under `### Claude validation`, for **every** Codex finding (validation of existing + NEW), use this exact entry shape (all four lines required):

```
- [severity] <summary>
  - Codex's view: <CONFIRMED / REFUTED / EXTENDED / NEW>
  - Checked: <file:line ranges + URLs you READ for this verdict>
  - Verdict: CONFIRMED | REFUTED | UNVERIFIABLE — <one-line reason grounded in what you just read>
  - Action: <keep | revise: ... | drop | flag to user>
```

For claims spanning many files, dispatch parallel `Agent` calls. For external claims (CVE/GHSA, versions, vendor behavior), use `WebSearch` / `WebFetch` against primary sources.

Then under `#### What Codex missed`, do an independent fresh-eyes pass.

### 7.5. Phase 3.5 — Priority verification of `[unverified_citation]` tags

The wrapper has quote-validated each Codex finding against the cited file (whitespace-tolerant) and tagged any mismatches `[unverified_citation]` or `[line_drift]` in the Codex review you just pasted. Before any other validation in step 7:

1. List every bullet carrying `[unverified_citation]` or `[line_drift]`.
2. For each: fresh `Read` the cited file; `Grep` for the quoted token across the whole file; check ±50 lines around the cited line range.
3. Decide one of:
   - **CONFIRMED at corrected location** — quote found at different lines. Revise the citation in the plan; do NOT silently keep the wrong line range.
   - **CONFIRMED with new evidence** — quote not literal but vulnerability shape verifiable elsewhere in the file.
   - **REFUTED** — quote absent and no other evidence stands.
   - **UNVERIFIABLE** — cannot read the file, cannot decide, or evidence is genuinely indeterminate. Carry to step 9 batch-question.

`[line_drift]` alone (without `[unverified_citation]`) means the quote was found in the file but at different lines — still treat as a citation correction, not a refutation.

### 8. Update `PLAN_PATH`

- Apply each CONFIRMED finding (your **Action** may differ from Codex's recommended fix); apply anything from "What Codex missed". Drop REFUTED. UNVERIFIABLE items → list in the plan's "## Unverified items flagged to user" section.
- Recompute the "## Summary" counts.
- Plan file stays clean of plugin metadata (run IDs, validation state) — those live in `$RUN_DIR` and chat.

### 9. Phase 4 — Present

**Self-check before presenting:** Confirm that Phase 2 (step 4) actually ran the wrapper and Phase 3 (step 7) validated Codex's response. If you skipped Phase 2 — for any reason, including plan-mode caution about Bash — **stop and go back to step 4 now**. Presenting Claude's first-pass plan without Codex validation is not the contract of this skill, and the user will get the wrong deliverable. The wrapper is read-only and safe to invoke in any mode.

**Unverifiable batch-question (handle BEFORE empty-audit branch):** If `PLAN_PATH`'s "## Unverified items flagged to user" section is non-empty, halt here and ask the user in one batched message. Use a free-text prompt (NOT `AskUserQuestion` — the 4-question / 4-option cap can't handle 5+ items with free-form notes). Print:

> ### Unverified items — your input needed
> Codex flagged the following findings that I could not independently verify. For each, reply with the item number and one of:
> - `skip` — drop from the plan
> - `include` — keep as-is, tagged `[user-confirmed-despite-unverifiable]`
> - `include with note: <text>` — keep with a short user note (one line, attached to the finding)
>
> 1. **[severity] <short title>** — `<path:line>` — <one-line reason it's unverifiable>
>    Codex's claim: <one-line claim verbatim>
>    Quote: `<quote or "(none)">`
> 2. ...
>
> Reply in one message, e.g. `1. skip · 2. include with note: corroborated by partner pentest · 3. include`

Wait for the response. Parse per item. If the user requests a severity downgrade or "include but mark low" for a clearly critical issue (unauthenticated RCE, hardcoded secret in committed code, etc.), push back in your reply BEFORE applying:

> Industry-standard practice is to keep item N at <severity> because <one-line technical reason>. I'll apply your call if you confirm — reply `confirm N as <severity>` to override, or amend.

After applying user decisions, update `PLAN_PATH`'s "## Unverified items flagged to user" section:
- "skip" items: remove the entry entirely.
- "include" items: keep the entry, add a `[user-confirmed-despite-unverifiable]` tag and (if a note was given) one short line "User note: <text>".
- Plan file stays clean — no run IDs, no verbose narratives, no embedded chat history.

Recompute severity counts in the "## Summary" block (skipped items reduce counts). Then proceed to the empty-audit branch and plan-mode detection as written below — both will now see the post-resolution state.

**Empty-audit branch (handle first):** If `PLAN_PATH` has zero findings (Critical + High + Medium + Low + Info all zero) after Phase 3, skip the "should I proceed with fixes" prompt entirely. Print:

> ### No security issues found
> Audited `<scope summary>`. Plan at `<PLAN_PATH>` for the record. Nothing to fix.

Then either call `ExitPlanMode` with the plan content (if plan mode active per the detection rule below) or stop here.

**Plan-mode detection rule:** Claude Code surfaces an active plan-mode via a system-reminder in the current turn (text like *"Plan mode is active"*). There is no programmatic predicate — check whether such a reminder is present in this turn's context.

- **Plan mode active:** call `ExitPlanMode` with the final `PLAN_PATH` contents. Stop here. Fixes are the user's call (they approve through the plan-mode UX). If the `ExitPlanMode` tool schema isn't loaded, fetch it via `ToolSearch` with `select:ExitPlanMode`.
- **Plan mode NOT active:** print a short summary in chat with the path to `PLAN_PATH` and ask:
  > Audit complete. Plan: `<PLAN_PATH>`. Review it and let me know — should I proceed with the fixes, or do you want to make changes first?

  Wait for the user. **Only on explicit go-ahead** (e.g., "yes proceed", "go ahead", or equivalent — not just acknowledgment) do you continue to step 10. If the user wants to make changes first or has questions, address those instead.

### 10. Apply fixes (only after explicit go-ahead in step 9, non-plan-mode branch)

1. Create a `TodoWrite` list with one item per CONFIRMED finding, ordered by severity (Critical first). If the `TodoWrite` tool schema isn't loaded, fetch it via `ToolSearch` with `select:TodoWrite`.
2. For each finding, working through the todo list in order:
   - Mark the todo `in_progress`.
   - Read the cited file (fresh `Read` — context memory doesn't count).
   - Apply the recommended fix using `Edit` (or `Write` for new files like config additions).
   - Run any relevant verification command if the fix has one (e.g., `npm audit fix` for dependency bumps, type-check / lint for code edits).
   - Mark the todo `completed`.
3. After all fixes: report what was done in a short summary, list any items that needed user judgment (e.g., dependency bumps that may break callers), and tell the user to review and commit.
