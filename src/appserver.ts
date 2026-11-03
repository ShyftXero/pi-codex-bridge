// pi-codex-bridge v0.2 — faithful app-server port: Pi owns the tool loop.
//
// v0.1 (index.ts) runs `codex exec --json` as its own agent (codex drives its own
// tools). v0.2 runs `codex app-server` — codex's long-lived JSON-RPC-over-stdio
// protocol — with codex's NATIVE tools off and Pi's tools registered as
// DynamicToolSpecs. codex then asks US to run a tool (ServerRequest
// `item/tool/call`), which is exactly "Pi owns the tool loop" without the
// in-process MCP server / schema-flattening / stdin-FIFO-steer machinery that
// pi-claude-bridge needed (CC's SDK had no native client tool loop; codex does).
//
// Framing is newline-delimited JSON-RPC 2.0 (verified against codex-cli 0.162.1:
// one object per line, `\n`-terminated; server notifications arrive id-less).
//
// GATED: index.ts only wires this in when PI_CODEX_APPSERVER=1, so v0.1 stays the
// default export until the probe (probe/appserver-probe.mjs) confirms the one
// unverified seam — registerToolsAndStartThread() — on a `codex login`'d hhr node.
// Do NOT flip the default before that run. See plan feat-509-codex-bridge-v0.2.md.

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

// --- pure core (no process, no pi runtime) — exported for the self-check ---------

/** A Pi tool as surfaced by getCurrentTools(): {name, description, parameters}. */
export interface PiTool {
	name: string;
	description?: string;
	parameters?: unknown; // JSON Schema (TypeBox is JSON Schema at runtime)
}

/** codex DynamicToolSpec (function form). Pi's TypeBox params ARE JSON Schema, so
 *  they go on the wire verbatim — no Zod round-trip (claude-bridge's lossy path). */
export function toDynamicToolSpecs(tools: PiTool[]): Array<{
	type: "function";
	name: string;
	description: string;
	inputSchema: unknown;
}> {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description ?? "",
		// MCP/codex require an object schema; fall back to an empty object schema.
		inputSchema: isObjectSchema(t.parameters) ? t.parameters : { type: "object", properties: {} },
	}));
}

function isObjectSchema(s: unknown): boolean {
	return !!s && typeof s === "object" && (s as { type?: unknown }).type === "object";
}

/** codex UserInput[] for turn/start. Pi content is string OR typed blocks. */
export function toTurnInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> {
	return [{ type: "text", text, text_elements: [] }];
}

/** The tail of context.messages is a tool result iff its last message is role
 *  "tool"/"user" carrying a toolResult block. Returns the codex callId (== the Pi
 *  toolCall.id we stamped) + flattened text, or null for a fresh user turn. This
 *  is how a tool-loop continuation is told apart from a new turn — by the parked
 *  callId, never by order. */
export function parkedToolResult(context: Pick<Context, "messages">): { callId: string; text: string } | null {
	const last = context.messages[context.messages.length - 1] as { role?: string; content?: unknown } | undefined;
	if (!last) return null;
	const blocks = Array.isArray(last.content) ? last.content : [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i] as { type?: string; toolCallId?: string; content?: unknown };
		if (b?.type === "toolResult" && typeof b.toolCallId === "string") {
			return { callId: b.toolCallId, text: flattenContent(b.content) };
		}
	}
	return null;
}

/** Full prior history as plain text, used to seed a FRESH codex thread per Pi turn.
 *  ponytail: cross-turn codex-side context is NOT reused — Pi's re-sent history is
 *  the source of truth, re-seeded each turn (matches v0.1's statelessness). Ceiling:
 *  no codex-side prompt cache across Pi turns. Upgrade: persistent thread +
 *  session-sync if caching ever matters. The tool LOOP (v0.2's point) stays within
 *  one codex turn, so it is unaffected. */
export function serializeHistory(context: Pick<Context, "messages" | "systemPrompt">): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`# System\n${context.systemPrompt}`);
	for (const msg of context.messages) {
		const raw = (msg as { content?: unknown; role?: string }).content;
		const text =
			typeof raw === "string"
				? raw
				: Array.isArray(raw)
					? raw
							.map((b) => {
								const block = b as { type?: string; text?: string; name?: string; content?: unknown };
								if (block.type === "text") return block.text ?? "";
								if (block.type === "toolCall") return `[called ${block.name ?? "tool"}]`;
								if (block.type === "toolResult") return `[tool result] ${flattenContent(block.content)}`;
								return "";
							})
							.filter(Boolean)
							.join("\n")
					: "";
		if (text.trim()) parts.push(`# ${(msg as { role?: string }).role}\n${text}`);
	}
	return parts.join("\n\n");
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/** Decide what a single codex app-server message means to Pi. Pure: no stream, no
 *  process — the coroutine below turns these into stream events + request replies.
 *  Returns null for the ~400 v2 message types the bridge ignores. */
export function mapCodexMessage(
	msg: Record<string, unknown>,
): // id-less notifications + the one ServerRequest we handle
	| { kind: "text"; delta: string }
	| { kind: "thinking"; delta: string }
	| { kind: "toolcall"; id: RequestId; callId: string; tool: string; namespace: string | null; args: unknown }
	| { kind: "usage"; last: number; total: number; contextWindow: number | null }
	| { kind: "turnDone" }
	| { kind: "error"; message: string }
	| null {
	// JSON-RPC response to one of our requests (has `id` + `result`/`error`) is
	// handled by the request registry, not here.
	const method = msg.method as string | undefined;
	if (!method) return null;
	const params = (msg.params ?? {}) as Record<string, unknown>;
	switch (method) {
		case "item/agentMessage/delta": // AgentMessageDeltaNotification
		case "agentMessage/delta":
			return typeof params.delta === "string" ? { kind: "text", delta: params.delta } : null;
		case "item/reasoning/textDelta": // Reasoning{Text,Summary}DeltaNotification
		case "item/reasoning/summaryDelta":
		case "reasoning/textDelta":
		case "reasoning/summaryDelta":
			return typeof params.delta === "string" ? { kind: "thinking", delta: params.delta } : null;
		case "item/tool/call": {
			// ServerRequest (has id): codex is asking US to run a Pi tool.
			const id = msg.id as RequestId;
			if (id === undefined) return null;
			return {
				kind: "toolcall",
				id,
				callId: String(params.callId ?? ""),
				tool: String(params.tool ?? ""),
				namespace: (params.namespace as string | null) ?? null,
				args: params.arguments ?? {},
			};
		}
		case "thread/tokenUsage/updated": {
			const u = (params.tokenUsage ?? {}) as { last?: unknown; total?: unknown; modelContextWindow?: unknown };
			const num = (v: unknown) => (typeof v === "number" ? v : tokenTotal(v));
			return {
				kind: "usage",
				last: num(u.last),
				total: num(u.total),
				contextWindow: typeof u.modelContextWindow === "number" ? u.modelContextWindow : null,
			};
		}
		case "turn/completed":
			return { kind: "turnDone" };
		case "error":
		case "turn/error": {
			const err = (params.error ?? params) as { message?: unknown };
			return { kind: "error", message: String(err.message ?? "codex error") };
		}
		default:
			return null;
	}
}

function tokenTotal(breakdown: unknown): number {
	if (!breakdown || typeof breakdown !== "object") return 0;
	const b = breakdown as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite", "cached", "total"]
		.map((k) => (typeof b[k] === "number" ? (b[k] as number) : 0))
		.reduce((a, c) => a + c, 0);
}

type RequestId = number | string;

// --- JSON-RPC-over-stdio transport (newline-delimited, verified framing) ---------

class AppServerConn {
	private proc: ChildProcess;
	private nextId = 1;
	private pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	/** notifications + ServerRequests (id-less OR server-initiated with an id). */
	onMessage: (msg: Record<string, unknown>) => void = () => {};
	onStderr: (s: string) => void = () => {};

	constructor(bin: string, args: string[]) {
		this.proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
		readline.createInterface({ input: this.proc.stdout! }).on("line", (line) => {
			if (!line.trim()) return;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line);
			} catch {
				return; // malformed line — ignore (matches v0.1 tolerance)
			}
			// A reply to one of OUR requests resolves its promise. A server-initiated
			// request (e.g. item/tool/call) also has an id but carries `method`.
			if (msg.id !== undefined && msg.method === undefined) {
				const waiter = this.pending.get(msg.id as RequestId);
				if (waiter) {
					this.pending.delete(msg.id as RequestId);
					if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
					else waiter.resolve(msg.result);
					return;
				}
			}
			this.onMessage(msg);
		});
		this.proc.stderr?.on("data", (d: Buffer) => this.onStderr(d.toString()));
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		this.write({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	/** Reply to a server-initiated ServerRequest (e.g. item/tool/call). */
	respond(id: RequestId, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(obj: unknown): void {
		this.proc.stdin?.write(JSON.stringify(obj) + "\n");
	}

	kill(): void {
		this.pending.forEach((w) => w.reject(new Error("app-server closed")));
		this.pending.clear();
		this.proc.kill("SIGTERM");
	}
}

// --- session: one codex thread per Pi turn-chain --------------------------------

interface Session {
	conn: AppServerConn;
	threadId: string;
	turnId: string | null;
	/** codex ServerRequest id for a tool call we told Pi about but have not answered. */
	heldToolCall: { callId: string; requestId: RequestId } | null;
	stream: AssistantMessageEventStream; // the CURRENT Pi stream to push into
	out: AssistantMessage;
	contentIndex: number;
	settled: boolean;
}

// Continuation lookup: a streamSimple call whose tail is a tool result for this
// callId resolves into the owning session. Keyed by the codex callId we stamped
// onto the Pi toolCall.id.
const sessionsByCall = new Map<string, Session>();

const CODEX_BIN = process.env.PI_CODEX_BIN ?? "codex";

function newOut(model: Model<any>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * THE ONE UNVERIFIED SEAM. `DynamicToolSpec` is exported by the protocol but not
 * wired into any typed request param; the registration path (+ the native-tools-off
 * switch) is one of: thread/start `config` passthrough, experimentalFeature flag,
 * or a `-c` config override at spawn. codex is a Rust binary (can't grep), so the
 * probe resolves this on a live hhr node and this function is finalized from its
 * output. Current best guess: config passthrough on thread/start.
 */
async function registerToolsAndStartThread(conn: AppServerConn, cwd: string, model: Model<any>, tools: PiTool[]): Promise<string> {
	await conn.request("initialize", { clientInfo: { name: "pi-codex-bridge", title: "pi-codex-bridge", version: "0.2.0" }, capabilities: null });
	// TODO(hhr-probe): confirm the dynamicTools + native-tools-off keys. The probe
	// tries each candidate and prints the one that makes codex emit item/tool/call.
	const res = (await conn.request("thread/start", {
		cwd,
		...(model.id && model.id !== "default" ? { model: model.id } : {}),
		approvalPolicy: "never",
		sandbox: "workspace-write",
		config: {
			dynamic_tools: toDynamicToolSpecs(tools), // candidate (a)
			tools: { shell: false, apply_patch: false }, // native tools off (candidate shape)
		},
	})) as { thread?: { id?: string }; threadId?: string };
	const threadId = res?.thread?.id ?? res?.threadId;
	if (!threadId) throw new Error("thread/start returned no thread id");
	return threadId;
}

function drive(session: Session, model: Model<any>, options?: SimpleStreamOptions): void {
	session.conn.onMessage = (msg) => {
		if (session.settled) return;
		const action = mapCodexMessage(msg);
		if (!action) return;
		switch (action.kind) {
			case "text": {
				const ci = session.contentIndex++;
				(session.out.content as Array<{ type: string; text: string }>).push({ type: "text", text: action.delta });
				session.stream.push({ type: "text_start", contentIndex: ci, partial: session.out });
				session.stream.push({ type: "text_delta", contentIndex: ci, delta: action.delta, partial: session.out });
				session.stream.push({ type: "text_end", contentIndex: ci, content: action.delta, partial: session.out });
				break;
			}
			case "thinking": {
				const ci = session.contentIndex++;
				session.stream.push({ type: "thinking_start", contentIndex: ci, partial: session.out } as never);
				session.stream.push({ type: "thinking_delta", contentIndex: ci, delta: action.delta, partial: session.out } as never);
				session.stream.push({ type: "thinking_end", contentIndex: ci, content: action.delta, partial: session.out } as never);
				break;
			}
			case "usage":
				session.out.usage = {
					...session.out.usage,
					output: action.last,
					totalTokens: action.total,
				} as AssistantMessage["usage"];
				break;
			case "toolcall": {
				// Pi owns the loop: tell Pi to run the tool, park codex's request.
				const ci = session.contentIndex++;
				const toolCall = { type: "toolCall", id: action.callId, name: action.tool, arguments: action.args, ...(action.namespace ? { namespace: action.namespace } : {}) };
				(session.out.content as unknown[]).push(toolCall);
				session.stream.push({ type: "toolcall_start", contentIndex: ci, id: action.callId, toolName: action.tool } as never);
				session.stream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(action.args ?? {}) } as never);
				session.stream.push({ type: "toolcall_end", contentIndex: ci, toolCall } as never);
				session.heldToolCall = { callId: action.callId, requestId: action.id };
				sessionsByCall.set(action.callId, session);
				settle(session, { type: "done", reason: "toolUse", message: { ...session.out, stopReason: "toolUse" } });
				break;
			}
			case "turnDone":
				settle(session, { type: "done", reason: "stop", message: { ...session.out, stopReason: "stop" } });
				disposeSession(session);
				break;
			case "error":
				settle(session, { type: "error", reason: "error", error: newOut(model, "error", action.message) });
				disposeSession(session);
				break;
		}
	};
	session.conn.onStderr = () => {};
	if (options?.signal) {
		const onAbort = () => {
			if (session.turnId) session.conn.notify("turn/interrupt", { threadId: session.threadId, turnId: session.turnId });
			settle(session, { type: "error", reason: "aborted", error: newOut(model, "aborted", "Operation aborted") });
			disposeSession(session);
		};
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
}

function settle(session: Session, event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
	if (session.settled) return;
	session.settled = true;
	session.stream.push(event);
	session.stream.end();
}

function disposeSession(session: Session): void {
	if (session.heldToolCall) sessionsByCall.delete(session.heldToolCall.callId);
	session.conn.kill();
}

export function streamCodexAppServer(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void run(model, context, options, stream);
	return stream;
}

async function run(model: Model<any>, context: Context, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
	try {
		const parked = parkedToolResult(context);
		if (parked && sessionsByCall.has(parked.callId)) {
			// --- tool-loop continuation: resolve codex's held request, same turn ---
			const session = sessionsByCall.get(parked.callId)!;
			sessionsByCall.delete(parked.callId);
			const held = session.heldToolCall!;
			session.heldToolCall = null;
			session.stream = stream;
			session.out = newOut(model, "stop");
			session.contentIndex = 0;
			session.settled = false;
			session.conn.respond(held.requestId, { contentItems: [{ type: "inputText", text: parked.text }], success: true });
			return;
		}
		// --- fresh Pi turn: new codex thread seeded with full history ---
		const tools = currentTools(context);
		const conn = new AppServerConn(CODEX_BIN, ["app-server"]);
		const cwd = process.cwd();
		const threadId = await registerToolsAndStartThread(conn, cwd, model, tools);
		const session: Session = { conn, threadId, turnId: null, heldToolCall: null, stream, out: newOut(model, "stop"), contentIndex: 0, settled: false };
		drive(session, model, options);
		const turn = (await conn.request("turn/start", { threadId, input: toTurnInput(serializeHistory(context)) })) as { turn?: { id?: string } };
		session.turnId = turn?.turn?.id ?? null;
	} catch (err) {
		stream.push({ type: "error", reason: "error", error: newOut(model, "error", err instanceof Error ? err.message : String(err)) });
		stream.end();
	}
}

/** Pi exposes tools in the transcript system messages; getCurrentTools reads them. */
function currentTools(context: Context): PiTool[] {
	try {
		return (getCurrentTools(context.messages) as unknown as PiTool[]) ?? [];
	} catch {
		return [];
	}
}
