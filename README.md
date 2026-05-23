# codexgrill

**Adversarial plan review and security audits for Claude Code.** Codex provides the second opinion; Claude validates every finding against the real code before applying it.

Two flows, one safety contract:
- **Plan validation** — grill an implementation plan before you write the code.
- **Security audit** — read-only audit of your codebase with CWE / CVE / GHSA grounding.

📖 **Full docs and details:** [**codexgrill.com**](https://codexgrill.com)

---

## Install

From inside Claude Code:

```text
/plugin marketplace add codeseasy/codexgrill
/plugin install codexgrill@codexgrill
/reload-plugins
```

**Requirements:** [Codex CLI](https://github.com/openai/codex) v0.130+ (`npm install -g @openai/codex`, then `codex login`), Node.js 18+, git 2.23+.

---

## Commands

| Command | Purpose |
|---|---|
| `/codexgrill:once` | **Router** — asks plan-validation vs security-audit, then dispatches to the right single-pass sub-skill. |
| `/codexgrill:loop` | **Router** — same as `:once` but for the iterative loop variants. |
| `/codexgrill:plan-once` | Single-pass plan grilling. Codex reviews once; Claude validates; plan re-presented via `ExitPlanMode`. |
| `/codexgrill:plan-loop` | Loop plan-grilling until both models agree the plan is SOUND. |
| `/codexgrill:security-once` | Single-pass security audit. Claude reviews → Codex validates + extends → Claude finalizes. |
| `/codexgrill:security-loop` | Loop security audit until both models agree the audit is AUDIT CLEAN. |

The two routers are the friendly entry points. Type `/codexgrill:once` and pick "Plan validation" or "Security audit" — codexgrill dispatches the right sub-skill. Or invoke the sub-skill directly if you already know which one you want.

---

## Usage — plan validation

> The plan path is **optional**. With no path, codexgrill grills this session's `ExitPlanMode` plan automatically.

```text
/codexgrill:plan-once                       # grills this session's plan
/codexgrill:plan-once path/to/plan.md       # grills the given file
/codexgrill:plan-once --effort=xhigh        # override reasoning effort
/codexgrill:plan-once --model=gpt-5.4       # override model

/codexgrill:plan-loop                       # grills this session's plan
/codexgrill:plan-loop path/to/plan.md       # grills the given file
/codexgrill:plan-loop --max=10              # bump the iteration cap (default 7)
```

Exits when Codex says **SOUND** and Claude has no remaining findings.

## Usage — security audit

> Audit scope is **optional**. With no path, codexgrill audits the whole repo. Pass one or more paths to scope.

```text
/codexgrill:security-once                       # whole repo
/codexgrill:security-once src/auth              # one path
/codexgrill:security-once src/auth src/billing  # multiple paths
/codexgrill:security-once --effort=high         # override reasoning effort

/codexgrill:security-loop                       # whole repo
/codexgrill:security-loop src/auth --max=10     # path + cap
```

Audit plan written to `.claude/plans/security-audit-<unix>.md`. Fixes only happen after your **explicit go-ahead** — never auto-applied.

---

## What you'll see

- **Plan validation**: Codex's verdict + findings (verbatim) → Claude's per-finding `CONFIRMED` / `REFUTED` / `UNVERIFIABLE` with cited `path:line` → Net verdict → revised plan via `ExitPlanMode`.
- **Security audit**: Claude's initial review → Codex's `AUDIT CLEAN` / `NEEDS REVISION` / `CRITICAL ISSUES` verdict with per-finding validation → Claude's validation → final audit plan → either `ExitPlanMode` (plan mode) or "should I proceed with the fixes?" prompt.

---

## Learn more

- **How it works**, the read-only safety contract (SHA256 working-tree + plan-file hashing on both plan validation and security audits), revert procedure, findings format, artifacts reference, and tuning guidance all live on the docs site:
  - [Plan validation docs](https://codexgrill.com/plan.html)
  - [Security audit docs](https://codexgrill.com/security.html)
- Source: this repository.
- Issues / feedback: [GitHub Issues](https://github.com/codeseasy/codexgrill/issues).

---

## License

[MIT](./LICENSE). Runtime dependency on the [Codex CLI](https://github.com/openai/codex) — not redistributed; see [`NOTICE`](./NOTICE).

> Community plugin. Not affiliated with OpenAI or Anthropic. Needs the [`codex`](https://github.com/openai/codex) CLI installed and authenticated (`codex login`), plus Node.js.
