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

- **v0.2 (in progress, opt-in)** runs codex under its long-lived `app-server` protocol so **pi owns
  the tool loop**. codex's app-server has a *native* client-owned tool loop (`item/tool/call` →
  `DynamicToolCallParams`), so this does NOT need the in-process MCP server / schema-flattening /
  stdin-steer machinery pi-claude-bridge needed — it's a ~400-line newline-JSON-RPC bridge. Enable
  with `PI_CODEX_APPSERVER=1` (default stays v0.1 until the app-server tool-loop is verified
  end-to-end against a logged-in codex). The one empirical unknown — how codex registers
  client-side `DynamicToolSpec`s + disables native tools — is resolved by `npm run probe` on a
  machine with a live `codex login` (see `probe/appserver-probe.mjs`).

## Safety

v0.1 runs codex with `--sandbox workspace-write` in pi's current working directory. Codex can create
and modify files there and run sandboxed commands. Run it where you'd run codex itself.

## License

MIT
