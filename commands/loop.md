---
description: Entry point for loop operations. Asks plan-validation vs security-audit, then dispatches to plan-loop or security-loop.
argument-hint: "[args forwarded to the chosen sub-skill]"
---

Router skill. Asks the user which flow they want — plan validation or security audit — then dispatches to the corresponding iterative-loop sub-skill with all arguments forwarded.

Raw arguments: `$ARGUMENTS`

## Steps

### 1. Ask the user which flow to run

If the `AskUserQuestion` tool schema isn't loaded, fetch it via `ToolSearch` with `select:AskUserQuestion` first.

Call `AskUserQuestion` with one question, two options:

- **Question**: "Which codexgrill loop do you want to run?"
- **Header**: "Flow"
- **Options**:
  - **"Plan validation"** — "Loop Codex review + Claude validation on a plan until convergence (Codex says SOUND and Claude finds nothing missed), then present via ExitPlanMode. You need either a plan-path argument or an active plan-mode plan."
  - **"Security audit"** — "Loop Codex + Claude on a security audit until convergence (Codex says AUDIT CLEAN and Claude finds nothing missed). Default scope is the whole repo; pass paths to scope. Produces a security plan file you can act on."

### 2. Dispatch to the chosen sub-skill

Use the `Skill` tool. If its schema isn't loaded, fetch it via `ToolSearch` with `select:Skill` first.

- **User picked "Plan validation"** → call `Skill` with `skill = "codexgrill:plan-loop"` and `args = "$ARGUMENTS"` (the original raw arguments, forwarded verbatim).
- **User picked "Security audit"** → call `Skill` with `skill = "codexgrill:security-loop"` and `args = "$ARGUMENTS"`.

That's it — the dispatched sub-skill handles everything from here (argument parsing, iteration loop, validation, refuted-log, ExitPlanMode or go-ahead prompt). Do not duplicate any of that logic in this router.
