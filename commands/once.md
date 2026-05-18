---
description: Entry point for single-pass operations. Asks plan-validation vs security-audit, then dispatches to plan-once or security-once.
argument-hint: "[args forwarded to the chosen sub-skill]"
---

Router skill. Asks the user which flow they want — plan validation or security audit — then dispatches to the corresponding single-pass sub-skill with all arguments forwarded.

Raw arguments: `$ARGUMENTS`

## Steps

### 1. Ask the user which flow to run

If the `AskUserQuestion` tool schema isn't loaded, fetch it via `ToolSearch` with `select:AskUserQuestion` first.

Call `AskUserQuestion` with one question, two options:

- **Question**: "Which codexgrill flow do you want to run?"
- **Header**: "Flow"
- **Options**:
  - **"Plan validation"** — "Grill a plan with Codex (read-only). Single pass, then validate every finding against the real code and re-present via ExitPlanMode. You need either a plan-path argument or an active plan-mode plan."
  - **"Security audit"** — "Codex + Claude audit the codebase for vulnerabilities (read-only). Claude does the initial review, Codex validates and extends, produces a security plan file you can act on. Default scope is the whole repo; pass paths to scope."

### 2. Dispatch to the chosen sub-skill

Use the `Skill` tool. If its schema isn't loaded, fetch it via `ToolSearch` with `select:Skill` first.

- **User picked "Plan validation"** → call `Skill` with `skill = "codexgrill:plan-once"` and `args = "$ARGUMENTS"` (the original raw arguments, forwarded verbatim).
- **User picked "Security audit"** → call `Skill` with `skill = "codexgrill:security-once"` and `args = "$ARGUMENTS"`.

That's it — the dispatched sub-skill handles everything from here (argument parsing, plan/audit execution, validation, ExitPlanMode or go-ahead prompt). Do not duplicate any of that logic in this router.
