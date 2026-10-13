// pi-codex-bridge — OpenAI Codex as a first-class pi model provider.
//
// Mirrors pi-claude-bridge's provider surface (pi.registerProvider + a streamSimple
// that streams AssistantMessage events) so `codex/*` shows up in the model picker like
// `claude-bridge/*`. v0.1 (this file) drives `codex exec --json`: codex runs as its OWN
// agent (native tools, workspace-write sandbox); pi sees the agent's text output.
//
// ponytail: v0.1 does NOT let pi drive codex's tools — codex owns its loop out-of-band.
// The faithful "pi owns the tool loop via an in-process MCP server" port (the way
// claude-bridge coerces a pure LLM with tools:[]) needs codex's long-lived
// app-server/exec-server protocol and lands in v0.2. See README + issue #105.

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "codex";
const API = "codex-bridge";
/** Override the codex binary (devcell installs it under ~/.local/node/bin, often off PATH). */
const CODEX_BIN = process.env.PI_CODEX_BIN ?? "codex";

// `default` = codex's own account/config default (spawned WITHOUT -m). A ChatGPT-account
// codex rejects every explicit `-m`, so `default` is the only id that works there; the
// explicit ids below require an API-key-authed codex. Cost 0 (subscription auth, no
// per-token billing exposed).
const MODELS = [
	{ id: "default", name: "Codex (account default)", contextWindow: 272_000, maxTokens: 128_000 },
	{ id: "gpt-5-codex", name: "GPT-5 Codex (API key)", contextWindow: 272_000, maxTokens: 128_000 },
	{ id: "gpt-5", name: "GPT-5 (API key)", contextWindow: 272_000, maxTokens: 128_000 },
] as const;

function registeredModels() {
	return MODELS.map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

// Replicated from pi-claude-bridge's local newAssistantOutput — pi expects this exact shape.
function newOutput(
	model: Model<any>,
	text: string,
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

// --- pure, testable core (no process spawning) ---------------------------------

/** Flatten pi's transcript to a plain-text prompt. pi owns history, so each turn
 *  resends the full conversation — this provider is stateless per call. */
export function serializePrompt(context: Pick<Context, "messages" | "systemPrompt">): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`# System\n${context.systemPrompt}`);
	for (const msg of context.messages) {
		const raw = (msg as { content?: unknown }).content;
		// pi messages carry content as a plain string OR an array of typed blocks.
		const text =
			typeof raw === "string"
				? raw
				: Array.isArray(raw)
					? raw
						.map((b) => {
							const block = b as { type?: string; text?: string; name?: string; content?: unknown };
							if (block.type === "text") return block.text ?? "";
							if (block.type === "toolCall") return `[called ${block.name ?? "tool"}]`;
							if (block.type === "toolResult") return `[tool result] ${blockText(block.content)}`;
							return "";
						})
						.filter(Boolean)
						.join("\n")
					: "";
		if (text.trim()) parts.push(`# ${msg.role}\n${text}`);
	}
	return parts.join("\n\n");
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/** Translate one `codex exec --json` JSONL line to a provider action.
 *  codex emits: thread.started / turn.started / item.completed{item:{type,...}} / turn.completed / error. */
export function parseCodexLine(raw: string): { kind: "text"; text: string } | { kind: "error"; text: string } | null {
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (ev.type === "item.completed") {
		const item = ev.item as { type?: string; text?: unknown } | undefined;
		if (item?.type === "agent_message" && typeof item.text === "string") return { kind: "text", text: item.text };
		return null; // reasoning / command_execution etc. — not surfaced in v0.1
	}
	if (ev.type === "error") return { kind: "error", text: String(ev.message ?? "codex error") };
	return null;
}

// --- streaming provider --------------------------------------------------------

function streamCodex(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runCodex(model, context, options, stream);
	return stream;
}

async function runCodex(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const prompt = serializePrompt(context);
	const cwd = process.cwd();
	const args = [
		"exec", "--json", "--skip-git-repo-check",
		"--sandbox", "workspace-write",
		"-C", cwd,
		// 'default' means "codex's own default" — passing -m breaks ChatGPT-account auth.
		...(model.id && model.id !== "default" ? ["-m", model.id] : []),
		prompt,
	];

	const child = spawn(CODEX_BIN, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		child.kill("SIGTERM");
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const out = newOutput(model, "", "stop");
	let text = "";
	let idx = 0;
	let stderr = "";
	child.stderr?.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString()).slice(-2000);
	});

	readline.createInterface({ input: child.stdout! }).on("line", (raw) => {
		const action = parseCodexLine(raw);
		if (!action) return;
		if (action.kind === "text") {
			text += action.text;
			const ci = idx++;
			(out.content as { type: string; text: string }[]).push({ type: "text", text: action.text });
			stream.push({ type: "text_start", contentIndex: ci, partial: out });
			stream.push({ type: "text_delta", contentIndex: ci, delta: action.text, partial: out });
			stream.push({ type: "text_end", contentIndex: ci, content: action.text, partial: out });
		} else {
			stderr = action.text;
		}
	});

	let settled = false;
	const finish = (code: number | null) => {
		if (settled) return; // 'error' + 'close' can both fire
		settled = true;
		if (options?.signal) options.signal.removeEventListener("abort", onAbort);
		if (aborted) {
			stream.push({ type: "error", reason: "aborted", error: newOutput(model, "", "aborted", "Operation aborted") });
		} else if (code !== 0 && code !== null && !text.trim()) {
			stream.push({ type: "error", reason: "error", error: newOutput(model, "", "error", stderr || `codex exited ${code}`) });
		} else {
			stream.push({ type: "done", reason: "stop", message: newOutput(model, text, "stop") });
		}
		stream.end();
	};

	child.on("error", (err) => {
		stderr = `codex spawn failed: ${err.message}`;
		finish(1);
	});
	child.on("close", finish);
}

export default function activate(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: API,
		apiKey: "not-used", // codex authenticates itself (ChatGPT OAuth in ~/.codex/auth.json)
		api: API,
		models: registeredModels(),
		streamSimple: streamCodex as unknown,
	} as Parameters<ExtensionAPI["registerProvider"]>[1]);
}
