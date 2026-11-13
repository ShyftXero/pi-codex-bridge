// Self-check for the v0.2 pure core — no codex spawn, no pi runtime.
// Mirrors the exported pure fns of src/appserver.ts (kept in sync by eye; trivial)
// and asserts the codex-message -> Pi-action mapping + the tool-loop signals.
//   run: node test/appserver-selfcheck.mjs
import assert from "node:assert";

// --- mirrors of src/appserver.ts pure exports ---
function toDynamicToolSpecs(tools) {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description ?? "",
		inputSchema: t.parameters && typeof t.parameters === "object" && t.parameters.type === "object" ? t.parameters : { type: "object", properties: {} },
	}));
}
function parkedToolResult(context) {
	const last = context.messages[context.messages.length - 1];
	if (!last) return null;
	const blocks = Array.isArray(last.content) ? last.content : [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		if (b?.type === "toolResult" && typeof b.toolCallId === "string") return { callId: b.toolCallId, text: typeof b.content === "string" ? b.content : "" };
	}
	return null;
}
function mapCodexMessage(msg) {
	const method = msg.method;
	if (!method) return null;
	const params = msg.params ?? {};
	switch (method) {
		case "item/agentMessage/delta":
		case "agentMessage/delta":
			return typeof params.delta === "string" ? { kind: "text", delta: params.delta } : null;
		case "item/reasoning/textDelta":
		case "reasoning/textDelta":
			return typeof params.delta === "string" ? { kind: "thinking", delta: params.delta } : null;
		case "item/tool/call":
			return msg.id === undefined ? null : { kind: "toolcall", id: msg.id, callId: String(params.callId ?? ""), tool: String(params.tool ?? ""), namespace: params.namespace ?? null, args: params.arguments ?? {} };
		case "turn/completed":
			return { kind: "turnDone" };
		case "error":
		case "turn/error":
			return { kind: "error", message: String((params.error ?? params).message ?? "codex error") };
		default:
			return null;
	}
}

// --- tests ---
// DynamicToolSpec: Pi's TypeBox JSON Schema passes through verbatim; non-object falls back.
const specs = toDynamicToolSpecs([
	{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "noparams" },
]);
assert.equal(specs[0].type, "function");
assert.deepEqual(specs[0].inputSchema.required, ["path"]); // nested schema NOT lost (claude-bridge's bug)
assert.deepEqual(specs[1].inputSchema, { type: "object", properties: {} });

// Tool-loop continuation is detected by a parked tool result, by callId not order.
assert.equal(parkedToolResult({ messages: [{ role: "user", content: "hi" }] }), null);
assert.deepEqual(
	parkedToolResult({ messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call_1" }] }, { role: "tool", content: [{ type: "toolResult", toolCallId: "call_1", content: "42" }] }] }),
	{ callId: "call_1", text: "42" },
);

// codex message -> Pi action mapping.
assert.deepEqual(mapCodexMessage({ method: "agentMessage/delta", params: { delta: "hello" } }), { kind: "text", delta: "hello" });
assert.deepEqual(mapCodexMessage({ method: "reasoning/textDelta", params: { delta: "hmm" } }), { kind: "thinking", delta: "hmm" });
assert.deepEqual(mapCodexMessage({ method: "turn/completed", params: {} }), { kind: "turnDone" });
assert.equal(mapCodexMessage({ method: "turn/error", params: { error: { message: "boom" } } }).message, "boom");
assert.equal(mapCodexMessage({ id: 1, result: {} }), null); // a reply, not a notification -> ignored here
assert.equal(mapCodexMessage({ method: "thread/unknownThing", params: {} }), null); // ignored v2 noise

const tc = mapCodexMessage({ id: 7, method: "item/tool/call", params: { callId: "c9", tool: "read", namespace: null, arguments: { path: "/x" } } });
assert.deepEqual(tc, { kind: "toolcall", id: 7, callId: "c9", tool: "read", namespace: null, args: { path: "/x" } });
// a tool call with no request id is not actionable (can't be answered)
assert.equal(mapCodexMessage({ method: "item/tool/call", params: { callId: "c9" } }), null);

console.log("appserver self-check: all assertions passed");
