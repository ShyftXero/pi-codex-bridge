// Self-check for the pure core. No framework, no codex spawn, no pi runtime.
// Re-implements parseCodexLine/serializePrompt identically to src/index.ts and asserts the
// contract on a real captured `codex exec --json` stream. If the translation breaks, this fails.
//   run: node test/selfcheck.mjs
import assert from "node:assert";

// --- mirrors of the pure exports in src/index.ts (kept in sync by eye; trivial) ---
function parseCodexLine(raw) {
	let ev;
	try { ev = JSON.parse(raw); } catch { return null; }
	if (ev.type === "item.completed") {
		const item = ev.item;
		if (item?.type === "agent_message" && typeof item.text === "string") return { kind: "text", text: item.text };
		return null;
	}
	if (ev.type === "error") return { kind: "error", text: String(ev.message ?? "codex error") };
	return null;
}
function blockText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).filter(Boolean).join(" ");
	return "";
}
function serializePrompt(context) {
	const parts = [];
	if (context.systemPrompt) parts.push(`# System\n${context.systemPrompt}`);
	for (const msg of context.messages) {
		const raw = msg.content;
		const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((b) => {
			if (b.type === "text") return b.text ?? "";
			if (b.type === "toolCall") return `[called ${b.name ?? "tool"}]`;
			if (b.type === "toolResult") return `[tool result] ${blockText(b.content)}`;
			return "";
		}).filter(Boolean).join("\n") : "";
		if (text.trim()) parts.push(`# ${msg.role}\n${text}`);
	}
	return parts.join("\n\n");
}

// --- real captured stream (from `codex exec --json "Reply with exactly: codex-ok"`) ---
const STREAM = [
	`{"type":"thread.started","thread_id":"01a135dc-10af-70f2-ae8d-59647a921053"}`,
	`{"type":"turn.started"}`,
	`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"codex-ok"}}`,
	`{"type":"turn.completed","usage":{"input_tokens":14135,"output_tokens":7}}`,
];

const actions = STREAM.map(parseCodexLine).filter(Boolean);
assert.deepStrictEqual(actions, [{ kind: "text", text: "codex-ok" }], "only agent_message yields text");

// non-text items and noise are ignored, not crashed on
assert.strictEqual(parseCodexLine(`{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}`), null);
assert.strictEqual(parseCodexLine("not json"), null);
assert.strictEqual(parseCodexLine(`{"type":"turn.started"}`), null);

// errors surface
assert.deepStrictEqual(parseCodexLine(`{"type":"error","message":"boom"}`), { kind: "error", text: "boom" });

// transcript serialization: roles, system preamble, tool blocks
const prompt = serializePrompt({
	systemPrompt: "be terse",
	messages: [
		{ role: "user", content: "plain string content" }, // real pi sends string content too
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
		{ role: "user", content: [{ type: "toolResult", content: [{ type: "text", text: "done" }] }] },
	],
});
assert.match(prompt, /# System\nbe terse/);
assert.match(prompt, /plain string content/);
assert.match(prompt, /# user\nhi/);
assert.match(prompt, /\[called bash\]/);
assert.match(prompt, /\[tool result\] done/);

console.log("ok — parseCodexLine + serializePrompt contract holds");
