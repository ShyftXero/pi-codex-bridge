// Codex app-server bridge. Pi executes forwarded tools and owns their results.
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	getCurrentSystemPrompt,
	normalizeContext,
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

/** Pi returns tool results as top-level messages, including errors and images. */
export interface ParkedResult {
	callId: string;
	contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
	success: boolean;
}

export function parkedToolResult(context: Pick<Context, "messages">): ParkedResult | null {
	const last = context.messages.at(-1);
	if (last?.role !== "toolResult") return null;
	return {
		callId: last.toolCallId,
		success: !last.isError,
		contentItems: last.content.map((block) => block.type === "image"
			? { type: "inputImage" as const, imageUrl: `data:${block.mimeType};base64,${block.data}` }
			: { type: "inputText" as const, text: block.text }),
	};
}

/** Pi history seeds each fresh Codex turn. Tool continuations reuse the held turn. */
export function serializeHistory(context: Pick<Context, "messages" | "systemPrompt">): string {
	const parts: string[] = [];
	const systemPrompt = getCurrentSystemPrompt(normalizeContext(context).messages);
	if (systemPrompt) parts.push(`# System\n${systemPrompt}`);
	for (const msg of context.messages) {
		if (msg.role === "system") continue;
		if (msg.role === "toolResult") {
			parts.push(`# tool result ${msg.toolName} (${msg.isError ? "error" : "success"})\n${flattenContent(msg.content)}`);
			continue;
		}
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
		case "turn/completed": {
			const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
			if (turn?.status && turn.status !== "completed") {
				return { kind: "error", message: turn.error?.message ?? `Codex turn ${turn.status}` };
			}
			return { kind: "turnDone" };
		}
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
	if (typeof b.totalTokens === "number") return b.totalTokens;
	return ["inputTokens", "outputTokens"]
		.map((k) => (typeof b[k] === "number" ? (b[k] as number) : 0))
		.reduce((a, c) => a + c, 0);
}

type RequestId = number | string;

/** Child exit, spawn failure and broken stdin reject all outstanding RPCs. */
class AppServerConn {
	private proc: ChildProcess;
	private nextId = 1;
	private failure: Error | null = null;
	private pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	onMessage: (msg: Record<string, unknown>) => void = () => {};
	onFailure: (err: Error) => void = () => {};

	constructor(bin: string) {
		this.proc = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
		readline.createInterface({ input: this.proc.stdout! }).on("line", (line) => {
			let msg: Record<string, unknown>;
			try { msg = JSON.parse(line); } catch { return; }
			if (msg.id !== undefined && msg.method === undefined) {
				const waiter = this.pending.get(msg.id as RequestId);
				if (waiter) {
					this.pending.delete(msg.id as RequestId);
					clearTimeout(waiter.timer);
					if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
					else waiter.resolve(msg.result);
				}
				return;
			}
			this.onMessage(msg);
		});
		let stderr = "";
		this.proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
		this.proc.on("error", (err) => this.fail(err));
		this.proc.stdin?.on("error", (err) => this.fail(err));
		this.proc.on("close", (code, signal) => this.fail(new Error(`Codex app-server closed (${signal ?? code}): ${stderr}`)));
	}

	private fail(err: Error): void {
		if (this.failure) return;
		this.failure = err;
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(err);
		}
		this.pending.clear();
		this.onFailure(err);
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex RPC timed out: ${method}`));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			try { this.write({ id, method, params }); }
			catch (err) { this.fail(err instanceof Error ? err : new Error(String(err))); }
		});
	}

	respond(id: RequestId, result: unknown): void { this.write({ id, result }); }
	notify(method: string, params: unknown): void { this.write({ method, params }); }

	private write(obj: unknown): void {
		if (this.failure) throw this.failure;
		this.proc.stdin!.write(JSON.stringify(obj) + "\n");
	}

	kill(): void {
		this.fail(new Error("Codex app-server disposed"));
		this.proc.kill("SIGTERM");
	}
}

interface Session {
	conn: AppServerConn;
	stream: AssistantMessageEventStream;
	out: AssistantMessage;
	threadId: string;
	held: { callId: string; requestId: RequestId } | null;
	inbox: Record<string, unknown>[];
	settled: boolean;
	disposed: boolean;
	clearAbort: () => void;
	tools: Set<string>;
}

const sessionsByCall = new Map<string, Session>();
const CODEX_BIN = process.env.PI_CODEX_BIN ??
	[join(homedir(), ".local/node/bin/codex"), join(homedir(), ".local/bin/codex")].find(existsSync) ?? "codex";

function newOut(model: Model<any>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
	};
}

/** Namespacing avoids collisions with native tools and keeps HUD names intact in Pi. */
export function threadStartParams(cwd: string, model: Model<any>, tools: PiTool[]) {
	return {
		cwd,
		...(model.id && model.id !== "default" ? { model: model.id } : {}),
		approvalPolicy: "never",
		sandbox: "read-only",
		ephemeral: true,
		dynamicTools: [{ type: "namespace", name: "pi", description: "Tools provided by the Pi harness", tools: toDynamicToolSpecs(tools) }],
		developerInstructions: "Use the pi namespace for all tool operations. Pi executes these tools with the calling session's permissions.",
		// Native command execution must not bypass Pi's tool filters or approvals.
		config: { "features.shell_tool": false, "features.multi_agent": false, web_search: "disabled" },
	};
}

function settle(session: Session, event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
	if (session.settled) return;
	session.settled = true;
	session.stream.push(event);
	session.stream.end();
}

function dispose(session: Session): void {
	if (session.disposed) return;
	session.disposed = true;
	session.clearAbort();
	if (session.held) sessionsByCall.delete(session.held.callId);
	session.inbox.length = 0;
	session.conn.kill();
}

function fail(session: Session, model: Model<any>, err: unknown, aborted = false): void {
	settle(session, { type: "error", reason: aborted ? "aborted" : "error", error: newOut(model, aborted ? "aborted" : "error", err instanceof Error ? err.message : String(err)) });
	dispose(session);
}

function bindAbort(session: Session, model: Model<any>, signal?: AbortSignal): void {
	session.clearAbort();
	const abort = () => fail(session, model, new Error("Operation aborted"), true);
	session.clearAbort = () => signal?.removeEventListener("abort", abort);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
}

/** Buffer messages while Pi executes a tool. Parallel calls must not be dropped. */
function pump(session: Session, model: Model<any>): void {
	while (!session.settled && !session.disposed && session.inbox.length) {
		const action = mapCodexMessage(session.inbox.shift()!);
		if (!action) continue;
		const ci = session.out.content.length;
		switch (action.kind) {
			case "text":
				session.out.content.push({ type: "text", text: action.delta });
				session.stream.push({ type: "text_start", contentIndex: ci, partial: session.out });
				session.stream.push({ type: "text_delta", contentIndex: ci, delta: action.delta, partial: session.out });
				session.stream.push({ type: "text_end", contentIndex: ci, content: action.delta, partial: session.out });
				break;
			case "thinking":
				session.out.content.push({ type: "thinking", thinking: action.delta });
				session.stream.push({ type: "thinking_start", contentIndex: ci, partial: session.out });
				session.stream.push({ type: "thinking_delta", contentIndex: ci, delta: action.delta, partial: session.out });
				session.stream.push({ type: "thinking_end", contentIndex: ci, content: action.delta, partial: session.out });
				break;
			case "usage":
				session.out.usage.totalTokens = action.last;
				break;
			case "toolcall": {
				if (action.namespace !== "pi" || !session.tools.has(action.tool) || !action.callId) {
					session.conn.respond(action.id, { success: false, contentItems: [{ type: "inputText", text: "Tool is not available in the calling Pi session" }] });
					break;
				}
				const piCallId = `${session.threadId}:${action.callId}`;
				const toolCall = { type: "toolCall" as const, id: piCallId, name: action.tool, arguments: action.args as Record<string, unknown> };
				session.out.content.push(toolCall);
				session.stream.push({ type: "toolcall_start", contentIndex: ci, partial: session.out });
				session.stream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(action.args), partial: session.out });
				session.stream.push({ type: "toolcall_end", contentIndex: ci, toolCall, partial: session.out });
				session.held = { callId: piCallId, requestId: action.id };
				sessionsByCall.set(piCallId, session);
				session.out.stopReason = "toolUse";
				settle(session, { type: "done", reason: "toolUse", message: session.out });
				break;
			}
			case "turnDone":
				session.out.stopReason = "stop";
				settle(session, { type: "done", reason: "stop", message: session.out });
				dispose(session);
				break;
			case "error": fail(session, model, action.message); break;
		}
	}
}

export function streamCodexAppServer(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void run(model, context, options, stream);
	return stream;
}

async function run(model: Model<any>, context: Context, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
	let session: Session | undefined;
	try {
		const parked = parkedToolResult(context);
		if (parked) {
			session = sessionsByCall.get(parked.callId);
			if (!session || session.disposed) throw new Error("Codex tool continuation is unavailable. Start a new user turn.");
			const held = session.held!;
			sessionsByCall.delete(parked.callId);
			session.held = null;
			session.stream = stream;
			session.out = newOut(model, "stop");
			session.settled = false;
			session.tools = new Set(currentTools(context).map((t) => t.name));
			bindAbort(session, model, options?.signal);
			if (session.disposed) return;
			session.conn.respond(held.requestId, { contentItems: parked.contentItems, success: parked.success });
			pump(session, model);
			return;
		}
		if (options?.signal?.aborted) throw new Error("Operation aborted");
		const tools = currentTools(context);
		const conn = new AppServerConn(CODEX_BIN);
		session = { conn, stream, out: newOut(model, "stop"), threadId: "", held: null, inbox: [], settled: false, disposed: false, clearAbort: () => {}, tools: new Set(tools.map((t) => t.name)) };
		const active = session;
		conn.onFailure = (err) => fail(active, model, err);
		conn.onMessage = (msg) => {
			if (active.disposed) return;
			// Reject unsupported server requests so a native approval cannot hang the stream.
			if (msg.id !== undefined && msg.method && msg.method !== "item/tool/call") {
				fail(active, model, `Unsupported Codex server request: ${msg.method}`);
				return;
			}
			active.inbox.push(msg);
			try { pump(active, model); } catch (err) { fail(active, model, err); }
		};
		bindAbort(active, model, options?.signal);
		if (active.disposed) return;
		await conn.request("initialize", { clientInfo: { name: "pi-codex-bridge", title: "Pi Codex bridge", version: "0.2.0" }, capabilities: { experimentalApi: true } });
		conn.notify("initialized", {});
		const started = await conn.request("thread/start", threadStartParams(process.cwd(), model, tools)) as { thread?: { id?: string } };
		if (!started.thread?.id) throw new Error("thread/start returned no thread id");
		active.threadId = started.thread.id;
		await conn.request("turn/start", { threadId: active.threadId, input: toTurnInput(serializeHistory(context)) });
	} catch (err) {
		if (session) fail(session, model, err, options?.signal?.aborted);
		else {
			const aborted = options?.signal?.aborted;
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: newOut(model, aborted ? "aborted" : "error", err instanceof Error ? err.message : String(err)) });
			stream.end();
		}
	}
}

/** Normalize Context.tools before applying transcript tool additions/removals. */
export function currentTools(context: Context): PiTool[] {
	return getCurrentTools(normalizeContext(context).messages);
}
