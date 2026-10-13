# pi-codex-bridge

Use **OpenAI Codex** as a first-class model provider in
[pi-coding-agent](https://pi.dev) — `codex/*` shows up in the model picker and is selectable
per-persona, exactly the way [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)
exposes Claude Code.

This is a **model provider**, not a skill or a "delegate a task to codex" tool.

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["npm:pi-codex-bridge"] }
```

Codex must be installed and authenticated (`codex login` — ChatGPT subscription or an API key;
auth lives in `~/.codex/auth.json`). If the `codex` binary isn't on `PATH`, point to it:

```bash
export PI_CODEX_BIN=/home/you/.local/node/bin/codex
```

Then pick a model: `codex/gpt-5-codex`, `codex/gpt-5`, `codex/o3`.

## How it works — and the v0.1 ceiling

`pi-claude-bridge` runs the model as a **pure LLM** (`tools: []`) and exposes *pi's* tools to it via
an in-process MCP server, so **pi owns the tool loop**. That depends on Claude Code's SDK having one
long-lived, resumable streaming session into which the MCP handler can block.

`codex exec --json` is **oneshot per turn** (a fresh process each turn), so there's nowhere for an
MCP handler to block mid-turn. Hence two phases:

- **v0.1 (this release)** drives `codex exec --json`. Codex runs as its **own agent** — its native
  tools (bash, apply-patch) in a `workspace-write` sandbox — and pi receives the agent's text output.
  pi's transcript is serialized to a prompt each turn (pi owns history; the provider is stateless per
  call). **Ceiling: pi does not drive codex's tools.** Codex edits files and runs commands out-of-band
  in the working directory; pi sees the resulting text, not individual tool calls.

- **v0.2 (planned)** runs codex under its long-lived `app-server`/`exec-server` protocol with an
  in-process MCP server exposing pi's tools and codex's native tools disabled — reproducing the
  claude-bridge coroutine so **pi owns the tool loop**.

## Safety

v0.1 runs codex with `--sandbox workspace-write` in pi's current working directory. Codex can create
and modify files there and run sandboxed commands. Run it where you'd run codex itself.

## License

MIT
