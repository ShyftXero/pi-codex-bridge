#!/usr/bin/env node
// v0.2 app-server probe — RUN ON AN hhr NODE WITH A LIVE `codex login`, never the
// live HUD box (its token is expired + it's memory-fragile). Resolves the one
// unverified seam in src/appserver.ts: how a client registers DynamicToolSpecs so
// codex calls the CLIENT's tool (item/tool/call), with codex's native tools off.
//
//   PI_CODEX_BIN=~/.local/node/bin/codex node probe/appserver-probe.mjs
//
// It tries each candidate registration shape until codex emits `item/tool/call`
// for our `echo` tool, answers it, and confirms the turn completes carrying the
// tool's result. Prints the WINNING shape — paste it into
// registerToolsAndStartThread() and drop the TODO(hhr-probe).

import { spawn } from "node:child_process";
import * as readline from "node:readline";

const BIN = process.env.PI_CODEX_BIN ?? "codex";
const CWD = process.cwd();

// Candidate registration shapes for thread/start. Each says "here are the client's
// tools; turn your native tools off". We do not know which codex 0.162.1 accepts.
const CANDIDATES = [
	{
		label: "A: config.dynamic_tools + config.tools={shell:false,apply_patch:false}",
		threadStart: (tools) => ({ cwd: CWD, approvalPolicy: "never", sandbox: "workspace-write", config: { dynamic_tools: tools, tools: { shell: false, apply_patch: false } } }),
	},
	{
		label: "B: config.dynamicTools (camel) + config.include_apply_patch_tool=false",
		threadStart: (tools) => ({ cwd: CWD, approvalPolicy: "never", sandbox: "workspace-write", config: { dynamicTools: tools, include_apply_patch_tool: false, include_plan_tool: false } }),
	},
	{
		label: "C: top-level dynamicTools on thread/start",
		threadStart: (tools) => ({ cwd: CWD, approvalPolicy: "never", sandbox: "workspace-write", dynamicTools: tools, config: { tools: { shell: false, apply_patch: false } } }),
	},
	{
		label: "D: experimentalFeature enablement then config.dynamic_tools",
		pre: ["experimentalFeature/enablement/set", { name: "dynamic_tools", enabled: true }],
		threadStart: (tools) => ({ cwd: CWD, approvalPolicy: "never", sandbox: "workspace-write", config: { dynamic_tools: tools } }),
	},
];

const ECHO_TOOL = {
	type: "function",
	name: "echo",
	description: "Echo back the given text. Call this, do not answer directly.",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const PROMPT = "Use the `echo` tool with text exactly 'probe-ok'. Then reply with what the tool returned.";

function conn() {
	const proc = spawn(BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
	const pending = new Map();
	let nextId = 1;
	const handlers = { msg: () => {} };
	readline.createInterface({ input: proc.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		let m;
		try { m = JSON.parse(line); } catch { return; }
		if (m.id !== undefined && m.method === undefined) {
			const w = pending.get(m.id);
			if (w) { pending.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); return; }
		}
		handlers.msg(m);
	});
	proc.stderr.on("data", (d) => process.env.PROBE_VERBOSE && process.stderr.write("[codex] " + d));
	return {
		request: (method, params) => { const id = nextId++; proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); },
		respond: (id, result) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"),
		onMsg: (fn) => { handlers.msg = fn; },
		kill: () => proc.kill("SIGTERM"),
	};
}

async function tryCandidate(c) {
	const cx = conn();
	const result = { label: c.label, toolCalled: false, turnDone: false, sawResult: false, error: null };
	let agentText = "";
	cx.onMsg((m) => {
		if (m.method === "item/tool/call") {
			result.toolCalled = true;
			console.log(`  ✓ codex called item/tool/call:`, JSON.stringify(m.params));
			cx.respond(m.id, { contentItems: [{ type: "inputText", text: "probe-ok" }], success: true });
		}
		if (m.method && /agentMessage\/delta|agentMessage.delta/.test(m.method) && typeof m.params?.delta === "string") agentText += m.params.delta;
		if (m.method === "turn/completed") result.turnDone = true;
		if (m.method === "error" || m.method === "turn/error") result.error = JSON.stringify(m.params);
	});
	try {
		await cx.request("initialize", { clientInfo: { name: "probe", title: "probe", version: "0.0.0" }, capabilities: null });
		if (c.pre) await cx.request(c.pre[0], c.pre[1]).catch((e) => console.log(`  (pre ${c.pre[0]} failed: ${e.message})`));
		const ts = await cx.request("thread/start", c.threadStart([ECHO_TOOL]));
		const threadId = ts?.thread?.id ?? ts?.threadId;
		if (!threadId) throw new Error("no thread id: " + JSON.stringify(ts));
		await cx.request("turn/start", { threadId, input: [{ type: "text", text: PROMPT, text_elements: [] }] });
		// wait up to 60s for the turn to complete
		const start = Date.now();
		while (!result.turnDone && !result.error && Date.now() - start < 60000) await new Promise((r) => setTimeout(r, 250));
		result.sawResult = /probe-ok/.test(agentText);
	} catch (e) {
		result.error = e.message;
	} finally {
		cx.kill();
	}
	return result;
}

(async () => {
	console.log(`probe: ${BIN} app-server, cwd=${CWD}\n`);
	for (const c of CANDIDATES) {
		console.log(`--- ${c.label}`);
		const r = await tryCandidate(c);
		console.log(`    toolCalled=${r.toolCalled} turnDone=${r.turnDone} sawResult=${r.sawResult} error=${r.error ?? "none"}`);
		if (r.toolCalled && r.turnDone) {
			console.log(`\n✅ WINNER: ${c.label}\n   -> wire this threadStart shape into registerToolsAndStartThread()`);
			process.exit(0);
		}
	}
	console.log(`\n❌ No candidate made codex call the client tool. Dump the raw protocol:`);
	console.log(`   PROBE_VERBOSE=1 node probe/appserver-probe.mjs  (watch stderr + add more candidates)`);
	console.log(`   also: codex app-server generate-json-schema --out /tmp/cs && grep -rl dynamic /tmp/cs`);
	process.exit(1);
})();
