import activate from "./dist/index.mjs";
let cfg;
activate({ registerProvider: (_id, c) => { cfg = c; } });
console.log("registered models:", cfg.models.map(m => m.id).join(", "), "| api:", cfg.api);
const model = { id: "default", api: "codex-bridge", provider: "codex" };
const context = { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: harness-ok" }] }] };
const stream = cfg.streamSimple(model, context);
let doneText, sawError, events = [];
for await (const ev of stream) {
  events.push(ev.type);
  if (ev.type === "done") doneText = ev.message?.content?.map(b => b.text).join("");
  if (ev.type === "error") sawError = ev.error?.errorMessage;
}
console.log("event types:", events.join(","));
console.log("done text:", JSON.stringify(doneText), "| error:", sawError ?? "none");
process.exit(doneText && doneText.includes("harness-ok") ? 0 : 1);
