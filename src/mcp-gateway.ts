// Expose Codex's authenticated MCP tools without invoking a Codex model.
import { createHash, randomUUID } from "node:crypto";
import {
  readFile, mkdtemp, writeFile, mkdir, rename, rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AppServerConn, CODEX_BIN } from "./appserver.js";
import { showConnectorPicker } from "./connector-picker.js";

type Schema = ToolDefinition["parameters"];
type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;

interface RemoteTool {
  name?: string;
  title?: string;
  description?: string;
  inputSchema: Schema;
  outputSchema?: Schema;
  annotations?: ToolDefinition["annotations"];
  _meta?: {
    connector_id?: string;
    connector_name?: string;
    connector_description?: string;
  };
}

interface Server {
  name: string;
  tools: Record<string, RemoteTool>;
  toolsError?: string | null;
}

interface RemoteResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Result["structuredContent"];
  isError?: boolean;
}

export const configPath = join(getAgentDir(), "pi-codex-bridge.json");

async function readConfig(path: string) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Codex bridge config must be a JSON object");
  }
  if (config.mcp !== undefined && (!config.mcp ||
      typeof config.mcp !== "object" || Array.isArray(config.mcp))) {
    throw new Error("mcp must be a JSON object");
  }
  return config;
}

export async function readConnectors(path = configPath): Promise<string[]> {
  const config = await readConfig(path);
  const connectors = config.mcp?.connectors ?? [];
  if (!Array.isArray(connectors) || connectors.some(
    value => typeof value !== "string" || !value.trim(),
  )) {
    throw new Error("mcp.connectors must be an array of nonempty strings");
  }
  return connectors;
}

export async function saveConnectors(connectors: string[]) {
  // Preserve unrelated settings; atomically replace the file so a crash
  // cannot leave the next session with partially written JSON.
  const config = await readConfig(configPath);
  config.mcp = { ...config.mcp, connectors };
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Managed apps identify their connector in metadata and share a server.
// Ordinary MCP tools belong to their server, even with dotted tool names.
export function connectorKey(
  server: string, name: string, tool: RemoteTool,
): string {
  const managed = tool._meta?.connector_id !== undefined ||
    tool._meta?.connector_name !== undefined;
  if (!managed) return server;
  const dot = name.indexOf(".");
  return dot < 0 ? tool._meta?.connector_id ?? server : name.slice(0, dot);
}

export function isAllowed(
  allowlist: string[], server: string, name: string, tool: RemoteTool,
): boolean {
  return allowlist.includes(connectorKey(server, name, tool)) ||
    (tool._meta?.connector_id !== undefined &&
      allowlist.includes(tool._meta.connector_id));
}

export function localToolName(server: string, tool: string): string {
  const identity = JSON.stringify([server, tool]);
  const hash = createHash("sha256").update(identity).digest("hex");
  const readable = `${server}__${tool}`.replace(/[^a-zA-Z0-9_]/g, "_");
  // Stable across catalog ordering; keep within common provider name limits.
  return `codex_mcp__${readable.slice(0, 40)}_${hash.slice(0, 12)}`;
}

// Preserve text/images natively. Other MCP content remains available as JSON.
// Large results are saved in a private temporary directory, not silently lost.
export async function toolResult(result: RemoteResult) {
  const raw = JSON.stringify(result);
  const clipped = truncateHead(raw);
  if (clipped.truncated) {
    const directory = await mkdtemp(join(tmpdir(), "pi-codex-mcp-"));
    const path = join(directory, "result.json");
    await writeFile(path, raw, { mode: 0o600 });
    return {
      content: [{
        type: "text" as const,
        text: `${clipped.content}\nFull MCP result saved to ${path}`,
      }],
      details: { path },
      isError: result.isError === true,
    };
  }

  const content = result.content.map(block => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text" as const, text: block.text };
    }
    if (block.type === "image" && typeof block.data === "string" &&
        typeof block.mimeType === "string") {
      return {
        type: "image" as const, data: block.data, mimeType: block.mimeType,
      };
    }
    return { type: "text" as const, text: JSON.stringify(block) };
  });
  return {
    content,
    structuredContent: result.structuredContent,
    details: {},
    isError: result.isError === true,
  };
}

export function registerMcpGateway(pi: ExtensionAPI): void {
  let conn: AppServerConn | undefined;
  let threadId = "";
  let available = new Map<string, { label: string; ids: Set<string> }>();
  let registered = new Map<string, ToolDefinition>();
  let discovery: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let allowlist: string[] = [];
  let discovering = false;
  let discoveryError: string | undefined;
  const listeners = new Set<() => void>();
  let catalog = new Map<string, {
    definition: ToolDefinition;
    server: string;
    name: string;
    tool: RemoteTool;
  }>();

  function publish() {
    for (const listener of listeners) listener();
  }

  // Applying the allowlist is local: toggles never rediscover or reconnect.
  function applyCatalog() {
    withdraw();
    for (const [name, entry] of catalog) {
      if (!isAllowed(allowlist, entry.server, entry.name, entry.tool)) {
        continue;
      }
      registered.set(name, entry.definition);
      pi.registerTool(entry.definition);
    }
    const active = pi.getActiveTools();
    if (registered.size &&
        pi.getAllTools().some(tool => tool.name === "tool_search")) {
      pi.setActiveTools([...new Set([...active, "tool_search"])]);
    }
    publish();
  }

  async function toggleConnector(id: string, enabled: boolean) {
    const current = await readConnectors();
    const aliases = [id, ...(available.get(id)?.ids ?? [])];
    const next = current.filter(alias => !aliases.includes(alias));
    if (enabled) next.push(id);
    await saveConnectors(next);
    if (stopped) return;
    allowlist = next;
    applyCatalog();
  }

  function close() {
    const old = conn;
    conn = undefined;
    threadId = "";
    old?.kill();
  }

  function withdraw() {
    for (const definition of registered.values()) {
      pi.registerTool({ ...definition, exposure: "hidden" });
    }
    registered.clear();
  }

  // Cancellation disposes the shared transport, never retries a tool call.
  // Concurrent calls fail too; refresh explicitly before using it again.
  async function rpc(
    connection: AppServerConn, method: string, params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const abort = () => connection.kill();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await connection.request(method, params);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async function refresh(
    cwd: string, cancellation: AbortSignal,
  ) {
    withdraw();
    close();
    catalog.clear();
    const configured = await readConnectors();
    // Shutdown can happen while the config file is still being read.
    cancellation.throwIfAborted();
    allowlist = configured;

    const connection = new AppServerConn(CODEX_BIN);
    conn = connection;
    connection.onMessage = message => {
      // Authentication and MCP elicitation need an interactive implementation;
      // report unsupported requests instead of leaving a call hanging.
      if (message.id !== undefined) {
        connection.kill(new Error(
          `Unsupported Codex MCP server request: ${message.method}`,
        ));
      }
    };

    try {
      const signal = AbortSignal.any([
        cancellation, AbortSignal.timeout(60_000),
      ]);
      await rpc(connection, "initialize", {
        clientInfo: { name: "pi-codex-mcp", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, signal);
      connection.notify("initialized", {});
      const started = await rpc(connection, "thread/start", {
        cwd, ephemeral: true,
      }, signal) as { thread: { id: string } };
      threadId = started.thread.id;

      const servers: Server[] = [];
      let cursor: string | null = null;
      do {
        const page = await rpc(connection, "mcpServerStatus/list", {
          threadId, cursor,
        }, signal) as { data: Server[]; nextCursor?: string | null };
        servers.push(...page.data);
        cursor = page.nextCursor ?? null;
      } while (cursor);

      const next: typeof catalog = new Map();
      const connectors = new Map<
        string, { label: string; ids: Set<string> }
      >();
      for (const server of servers) {
        if (server.toolsError) {
          throw new Error(`${server.name}: ${server.toolsError}`);
        }
        for (const [name, tool] of Object.entries(server.tools)) {
          const key = connectorKey(server.name, name, tool);
          const connector = connectors.get(key) ?? {
            label: tool._meta?.connector_name ?? key,
            ids: new Set<string>(),
          };
          if (tool._meta?.connector_id) {
            connector.ids.add(tool._meta.connector_id);
          }
          connectors.set(key, connector);
          const localName = localToolName(server.name, name);
          const definition: ToolDefinition = {
            name: localName,
            label: tool.title ?? name,
            description: (tool.description ?? name) +
              "\nLarge results are truncated at 50 KB or 2000 lines; " +
              "the complete result is saved to a temporary file.",
            parameters: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            exposure: "deferred",
            namespace: {
              name: `codex_mcp__${key.replace(/[^a-zA-Z0-9_]/g, "_")}`,
              description: tool._meta?.connector_description ?? key,
            },
            async execute(_id, args, signal) {
              // A stale saved call must not survive a refresh/removal.
              if (conn !== connection || !registered.has(localName)) {
                throw new Error("Codex MCP tool unavailable; refresh first");
              }
              const result = await rpc(connection, "mcpServer/tool/call", {
                threadId, server: server.name, tool: name, arguments: args,
              }, signal) as RemoteResult;
              return toolResult(result);
            },
          };
          next.set(localName, {
            definition, server: server.name, name, tool,
          });
        }
      }

      // Shutdown may have occurred while discovery was awaiting RPCs.
      signal.throwIfAborted();
      if (conn !== connection) return;
      available = new Map([...connectors].sort(([a], [b]) =>
        a.localeCompare(b)));
      catalog = next;
      applyCatalog();
    } catch (error) {
      if (conn === connection) close();
      throw error;
    }
  }

  function startDiscovery(ctx: ExtensionContext) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    discovering = true;
    discoveryError = undefined;
    ctx.ui.setStatus("codex-mcp", "Codex MCP: connecting…");
    publish();
    discovery = refresh(ctx.cwd, current.signal).catch(error => {
      if (controller === current && !stopped) {
        discoveryError = String(error);
      }
      throw error;
    }).finally(() => {
      // An older discovery must not clear a newer run's status.
      if (controller === current && !stopped) {
        discovering = false;
        ctx.ui.setStatus("codex-mcp", undefined);
        publish();
      }
    });
    return discovery;
  }

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    // Deliberately do not return the promise: Pi startup must not wait
    // for the Codex process or any connector's network requests.
    const task = startDiscovery(ctx);
    const current = controller;
    void task.catch(error => {
      if (!stopped && !current?.signal.aborted) {
        ctx.ui.notify(`Codex MCP: ${String(error)}`, "error");
      }
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    listeners.clear();
    controller?.abort();
    withdraw();
    close();
    await discovery?.catch(() => {});
    ctx.ui.setStatus("codex-mcp", undefined);
  });
  pi.registerCommand("codex-mcp", {
    description: "Manage Codex connectors in an interactive picker",
    async handler(args, ctx) {
      await ctx.waitForIdle();
      // Retain the existing refresh argument for scripts/non-UI clients.
      if (args.trim() === "refresh" || !ctx.hasUI) {
        await startDiscovery(ctx);
        ctx.ui.notify(`Codex MCP: ${registered.size} tools registered`,
          "info");
        return;
      }

      if (ctx.mode === "tui") {
        await showConnectorPicker(ctx, {
          snapshot: () => ({
            connectors: [...available].map(([id, connector]) => ({
              id,
              label: connector.label === id ? id :
                `${connector.label} (${id})`,
              enabled: [id, ...connector.ids].some(alias =>
                allowlist.includes(alias)),
            })),
            discovering,
            error: discoveryError,
          }),
          subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          },
          refresh: () => startDiscovery(ctx),
          toggle: toggleConnector,
        });
        return;
      }

      // RPC clients cannot render custom TUI components. Keep the standard
      // select dialog as a fallback for those clients only.
      // Reuse startup discovery rather than reconnecting on every open.
      // Explicit refresh below also provides recovery after failures.
      await discovery?.catch(() => {});
      while (true) {
        const allowlist = await readConnectors();
        const rows = [...available].map(([key, connector]) => {
          const aliases = [key, ...connector.ids];
          const enabled = aliases.some(id => allowlist.includes(id));
          const label = connector.label === key ? key :
            `${connector.label} (${key})`;
          return {
            key, enabled,
            text: `[${enabled ? "on" : "off"}] ${label}`,
          };
        });
        const refreshLabel = "Refresh available connectors";
        const choice = await ctx.ui.select(
          "Codex connectors — select to toggle; Esc to close",
          [...rows.map(row => row.text), refreshLabel],
        );
        if (choice === undefined) break;
        if (choice === refreshLabel) {
          await startDiscovery(ctx);
        } else {
          const row = rows.find(row => row.text === choice);
          if (row) await toggleConnector(row.key, !row.enabled);
        }
      }
    },
  });
}
