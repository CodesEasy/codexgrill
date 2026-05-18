---
description: Entry point for single-pass operations. Asks plan-validation vs security-audit, then dispatches to plan-once or security-once.
argument-hint: "[args forwarded to the chosen sub-skill]"
---

Router. Ask the user which flow, then dispatch with `$ARGUMENTS` forwarded verbatim.

## Skill names (use the exact string from the right column)

| User picks       | Dispatch target            |
|------------------|----------------------------|
| Plan validation  | `codexgrill:plan-once`     |
| Security audit   | `codexgrill:security-once` |

Treat each name as one opaque string. Don't reformat the hyphen.

## Steps

1. Call `AskUserQuestion` (fetch its schema via `ToolSearch select:AskUserQuestion` if not loaded). One question — `"Which codexgrill flow do you want to run?"` (header `"Flow"`) with two options:
   - **"Plan validation"** — Grill an implementation plan with Codex (read-only).
   - **"Security audit"** — Audit the codebase for vulnerabilities (read-only).
2. Look up the user's pick in the table above. Copy the right-column string character-for-character.
3. Call `Skill` (fetch via `ToolSearch select:Skill` if not loaded) with `skill` = that string and `args` = `$ARGUMENTS`.
4. If `Skill` returns `Error: Unknown skill: ...`, copy the name from the error's `Did you mean ...?` suggestion and retry once. If it fails again, stop and tell the user the plugin install is broken.

The dispatched sub-skill handles everything else.
