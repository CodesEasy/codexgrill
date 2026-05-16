# codexgrill

**Adversarial plan review for Claude Code.** Codex provides the second opinion; Claude validates every finding against the real code before applying it.

> Community plugin. Not affiliated with OpenAI or Anthropic. Needs the [`codex`](https://github.com/openai/codex) CLI installed and authenticated (`codex login`), plus Node.js.

v1 grills **plans**. Code review, PR review, and design-doc commands are next.

---

## How it works

1. **Codex reads your plan** via `codex exec` and returns findings — wrong assumptions, missing files, ordering risks, security/perf concerns, stale facts.
2. **Claude validates each finding** by `Read`-ing the cited file. Every claim is marked CONFIRMED, REFUTED, or UNVERIFIABLE — never accepted from memory.
3. **The plan is edited** to apply CONFIRMED findings; REFUTED ones are dropped.
4. **(`:loop` only)** Repeat until both models agree the plan is clean, or `--max` rounds run out. The loop pins Codex to a single thread by passing the `thread_id` from iter 1 back to `codex exec resume <id>` on every later iteration — prompt caching covers the bulk of the resumed prompt, so long loops stay cheap.
5. The revised plan is re-presented via `ExitPlanMode`.

**Read-only enforcement.** Codex runs with `--yolo` (full sandbox + approval bypass) because the codex sandbox's `read-only` mode blocks command execution and breaks any serious review (you can't run `git log`, `grep`, etc.). Containment is enforced two ways instead:

1. The review prompt's `<action_safety>` block tells Codex modifications cause the run to be **REJECTED**.
2. The wrapper SHA256-hashes every dirty + untracked path in the git working tree before and after every Codex call. Any change → exit `2` (`WORKING_TREE_CHANGED`), loop halts, user decides.

**Revert safety net.** Before each iteration the wrapper saves a `git stash create -u` snapshot of the working tree under a permanent ref like `refs/codexgrill/<run-id>/iter-<N>-pre` (no side effects on the working tree or stash list). The stash hash is recorded in `result-iter<N>.json` as `preIterStash.hash`. If working-tree changes are detected and you attribute them to Codex, the command offers a one-command revert via `git stash apply <hash>`. List existing refs with `git for-each-ref refs/codexgrill/`; remove one with `git update-ref -d <ref>`.

---

## Install

```text
/plugin marketplace add codeseasy/codexgrill
/plugin install codexgrill@codexgrill
/reload-plugins
```

**Requirements**
- [Codex CLI](https://github.com/openai/codex) v0.130+ — `npm install -g @openai/codex`, then `codex login`.
- Node.js 18+
- git (must run inside a working tree).

---

## Usage

> **The plan path is optional in both commands.** With no path, codexgrill grills this session's `ExitPlanMode` plan automatically.

### Single pass
```text
/codexgrill:once                            # grills this session's plan
/codexgrill:once path/to/plan.md            # grills the given file
/codexgrill:once --effort=medium            # override reasoning effort
/codexgrill:once --model=gpt-5.1-codex      # override model
```

### Loop until clean
```text
/codexgrill:loop                            # grills this session's plan
/codexgrill:loop path/to/plan.md            # grills the given file
/codexgrill:loop --max=10                   # bump the iteration cap (default 7)
/codexgrill:loop --effort=medium            # override reasoning effort
```

Exits when Codex says **SOUND** and Claude has no remaining findings.

### What you'll see
- Codex's verdict + findings (verbatim).
- Claude's per-finding validation, each citing the `path:line` just read.
- A "What Codex missed" pass.
- Net verdict and (if needed) the revised plan.

---

## Tuning for large plans

`codex exec` has no auto-compaction — a single review turn that overruns the per-turn context window aborts with an error instead of retrying. If you see "Codex ran out of room in the model's context window":

- The most common cause is `model_reasoning_effort = "xhigh"` in `~/.codex/config.toml`. Reasoning tokens count toward the per-turn budget, and `xhigh` plus a big plan plus dozens of tool calls is what blows it.
- Pass `--effort=medium` to override the config for this run only. Valid levels: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Or trim the plan body and re-run.

The plugin never auto-retries on context exhaustion or rate-limit errors — it surfaces the diagnostic and waits for your call.

---

## Artifacts

Every run drops its artifacts under `.claude/temp/codexgrill/<run-id>/` (gitignored). For `:once` runs:

- `prompt.txt` — exact prompt sent to Codex.
- `final.txt` — Codex's final review message.
- `codex.jsonl` — full JSONL event stream from `codex exec`.
- `result.json` — wrapper summary (thread_id, exit_code, usage, paths).

For `:loop` runs, each artifact gets an `-iter<N>` suffix, plus:

- `state.json` — run state including the pinned `codex_thread_id`.
- `refuted-log.txt` — cumulative refutations prepended to each iteration's prompt.

---

## License

[MIT](./LICENSE). Runtime dependency on the [Codex CLI](https://github.com/openai/codex) — not redistributed; see [`NOTICE`](./NOTICE).
