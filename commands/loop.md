---
description: Entry point for loop operations. Asks plan-validation vs security-audit, then dispatches to plan-loop or security-loop.
argument-hint: "[args forwarded to the chosen sub-skill]"
---

Router. Ask the user which flow, then dispatch with `$ARGUMENTS` forwarded verbatim.

## Skill names (use the exact string from the right column)

| User picks       | Dispatch target            |
|------------------|----------------------------|
| Plan validation  | `codexgrill:plan-loop`     |
| Security audit   | `codexgrill:security-loop` |

Treat each name as one opaque string — copy it character-for-character, hyphen included.

## Steps

1. Call `AskUserQuestion` (fetch its schema via `ToolSearch select:AskUserQuestion` if not loaded). One question — `"Which codexgrill loop do you want to run?"` (header `"Flow"`) with two options:
   - **"Plan validation"** — Loop Codex review + Claude validation on a plan until convergence.
   - **"Security audit"** — Loop Codex + Claude on a security audit until convergence.
2. Look up the user's pick in the table above. Copy the right-column string character-for-character.
3. Call `Skill` (fetch via `ToolSearch select:Skill` if not loaded) with `skill` = that string and `args` = `$ARGUMENTS`.
4. If `Skill` returns `Error: Unknown skill: ...`, copy the name from the error's `Did you mean ...?` suggestion and retry once. If it fails again, stop and tell the user the plugin install is broken.

The dispatched sub-skill handles everything else.
