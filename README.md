# codexgrill

**Adversarial plan review for Claude Code.** Codex provides the second opinion; Claude validates every finding against the real code before applying it.

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

## Usage

> The plan path is **optional** in both commands. With no path, codexgrill grills this session's `ExitPlanMode` plan automatically.

### Single pass — `/codexgrill:once`
```text
/codexgrill:once                            # grills this session's plan
/codexgrill:once path/to/plan.md            # grills the given file
/codexgrill:once --effort=xhigh             # override reasoning effort
/codexgrill:once --model=gpt-5.1-codex      # override model
```

### Loop until clean — `/codexgrill:loop`
```text
/codexgrill:loop                            # grills this session's plan
/codexgrill:loop path/to/plan.md            # grills the given file
/codexgrill:loop --max=10                   # bump the iteration cap (default 7)
/codexgrill:loop --effort=xhigh             # override reasoning effort
/codexgrill:loop --model=gpt-5.1-codex      # override model
```

Exits when Codex says **SOUND** and Claude has no remaining findings.

### What you'll see
- Codex's verdict + findings (verbatim).
- Claude's per-finding validation, each citing the `path:line` just read.
- A "What Codex missed" pass.
- Net verdict and (if needed) the revised plan re-presented via `ExitPlanMode`.

---

## Learn more

- **How it works**, the read-only safety contract, revert procedure, artifacts reference, and tuning guidance all live on the docs site: [**codexgrill.com**](https://codexgrill.com).
- Source: this repository.
- Issues / feedback: [GitHub Issues](https://github.com/codeseasy/codexgrill/issues).

---

## License

[MIT](./LICENSE). Runtime dependency on the [Codex CLI](https://github.com/openai/codex) — not redistributed; see [`NOTICE`](./NOTICE).

> Community plugin. Not affiliated with OpenAI or Anthropic. Needs the [`codex`](https://github.com/openai/codex) CLI installed and authenticated (`codex login`), plus Node.js.
