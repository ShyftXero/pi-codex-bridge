# pi-codex-bridge

Codex model provider for Pi. Codex must be installed and authenticated with `codex login`.
Set `PI_CODEX_BIN` if Codex is outside PATH.

## Codex MCP gateway

The extension exposes Codex-connected MCP tools through Pi's tool system.
Codex supplies the connection and authentication; Pi handles tool discovery,
validation, permission hooks, and execution. Tool calls go directly through
`codex app-server` without starting a model turn.

Requires a recent Codex supporting `mcpServer/tool/call` and Pi's deferred
tool APIs (tested with Codex 0.167.2 and Pi 1.5.2).

Create `~/.pi/agent/pi-codex-bridge.json` to configure the connector allowlist
(or use the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "mcp": {
    "connectors": []
  }
}
```

The allowlist defaults to empty: no connector is enabled automatically.
Background discovery still populates the connector list so users can enable
the connectors available through their own Codex account.
Invalid configuration reports an error and exposes no gateway tools. This
is a user-level file; project files are not read.

Run `/codex-mcp` to open a persistent native SettingsList. Each connector
shows its enabled state, display name, and configuration key. Enter or Space
toggles the selected connector without closing the screen. Changes are
saved and applied from the cached tool catalog, without rediscovery or
reconnecting. Press Escape to close, or select **Refresh available
connectors** to explicitly reload the catalog.

Connector names come from discovery, not a built-in list of services. Use
the keys displayed in the picker when editing the allowlist; connector IDs
from Codex metadata are also accepted. Managed apps use their tool namespace
as the key. Ordinary MCP servers use their server name, even when their
tools have dotted names.

The existing `/codex-mcp refresh` argument remains available for scripts.
Without an interactive UI, `/codex-mcp` refreshes and reports a tool count.
The picker is separate from Pi's built-in `/mcp` server panel because Codex
can expose multiple connectors behind one shared MCP server.

**The allowlist is the only gateway access policy.** Every discovered tool
for an allowed connector is exposed, including write/destructive tools and
tools without annotations. Schemas, descriptions, and annotations are
preserved; existing Codex authorization and Pi permission hooks still apply.
Enabling an entire shared server does not implicitly enable all its apps.

Tools have stable `codex_mcp__` names and deferred exposure. Pi's built-in
`tool_search` discovers them without loading every schema into each prompt.
Discovery runs in the background at session startup on a dedicated
app-server connection and ephemeral thread. Startup and `/reload` do not
wait for discovery. A
`Codex MCP: connecting…` status appears while it runs, then clears as the
tools become available. The picker opens immediately and renders a snapshot
of gateway state, subscribing to catalog/status updates while open. It does
not start or own discovery; only startup and explicit refresh do that. If
discovery is pending, its progress is shown in-place. Shutdown cancels
discovery and prevents late tool registration.

Requests have the transport's 30-second deadline. Cancellation closes the
shared gateway connection, so concurrent gateway calls can fail as well.
Calls are never automatically retried: a failed or cancelled write might
already have taken effect. Refresh explicitly before further use. Server
requests requiring interactive authentication or MCP elicitation are not
yet supported; use Codex to establish the connection first.

Text and images are returned natively, other MCP content as JSON, and
structured content/error flags are preserved. Results exceeding 50 KB or
2000 lines are truncated with the complete result in a private temporary
file. Those files can contain sensitive connector data; remove them when
no longer needed.

Gateway tests and a discovery probe using your existing Codex connection:

```bash
npm run test:mcp
npm run probe:mcp
```

The probe lists enabled tools without executing them. The tests use only
synthetic connectors and a local fake app-server, with no credentials or
network requests required.

To explicitly exercise a known tool, provide its original server name,
tool name, and JSON arguments:

```bash
npm run probe:mcp -- --call SERVER TOOL '{"query":"example"}'
```

Replace the placeholders and arguments with values appropriate for your
connector. The tool must already be allowlisted. This executes the tool,
including any side effects: choose a safe operation and arguments. The
probe prints only success/content types, not retrieved content.

## Tool forwarding

The default provider uses `codex app-server` and forwards the calling Pi session's active tools.
Tools appear under the `pi` namespace. Pi receives each tool call and executes it through its normal
validation, callbacks and approval handling. Tool results resume the same Codex turn.

The bridge enables the experimental protocol capability, sends the `initialized` notification, and
registers `dynamicTools` on `thread/start`. These fields are documented at
https://developers.openai.com/codex/app-server and match the installed CLI's experimental JSON schema.
This requires a Codex version supporting namespaced dynamic tools.

The bridge preserves error results and images. It buffers concurrent tool requests while Pi executes
each call. Process failures and unsupported server requests end the stream with an error.
A cancelled or lost tool continuation returns an error. Start a new user turn to recover.

Each fresh Pi turn seeds a new Codex thread with Pi's history. Codex threads are ephemeral.
Native command execution is disabled. The Codex sandbox is read-only. Forwarded tools still execute
in Pi and retain the calling session's permissions.

`PI_CODEX_APPSERVER=0` enables legacy `codex exec --json` only when Pi supplies no tools.
A session with active Pi tools always uses app-server. There is no silent fallback that drops tools.

## Verification

Run tests on a development or test node. Do not run them on the live HUD host.
Install the package's Pi peer dependencies first. Use Node 22.23.3 or later.

```sh
node --experimental-strip-types --test test/tool-forwarding.test.mjs
```

The tests import the real bridge and launch a fake app-server. They use no inference or credentials.
They cover the handshake, tool registration, results, errors, images, concurrent calls, independent
sessions, cancellation, process exit and missing continuations.

After the tests pass, verify an authenticated Codex session can call `pi.dispatch` and `pi.long_task`
and receive their results. Verify the HUD attributes each call to the calling session.

## License

MIT
