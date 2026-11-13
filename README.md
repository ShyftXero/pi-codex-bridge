# pi-codex-bridge

Codex model provider for Pi. Codex must be installed and authenticated with `codex login`.
Set `PI_CODEX_BIN` if Codex is outside PATH.

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
