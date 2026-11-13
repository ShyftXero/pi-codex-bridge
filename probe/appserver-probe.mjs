#!/usr/bin/env node
// Run off the live HUD host with Codex authenticated. Executes sentinel tools only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { streamCodexAppServer } from '../src/appserver.ts';
const id = process.env.PI_CODEX_PROBE_MODEL;
if (!id || id === 'default') throw new Error('Set PI_CODEX_PROBE_MODEL to an explicit model ID');
const nonce = randomUUID();
const seen = new Set();
const context = {
  tools: ['dispatch', 'long_task'].map(name => ({ name, description: `Test sentinel ${name}. No jobs are launched.`, parameters: { type: 'object', properties: {}, additionalProperties: false } })),
  messages: [{ role: 'user', content: 'Call pi.dispatch once. Then call pi.long_task once. Reply with both tool results exactly. These are harmless test sentinels.', timestamp: Date.now() }],
};
const model = { api: 'codex-bridge', provider: 'codex', id };
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
try {
  for (let step = 0; step < 6; step++) {
    const message = await streamCodexAppServer(model, context, { signal: controller.signal }).result();
    context.messages.push(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage);
    if (message.stopReason !== 'toolUse') {
      assert.deepEqual([...seen].sort(), ['dispatch', 'long_task']);
      const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      assert.ok(text.includes(nonce), 'Codex did not receive the sentinel result');
      console.log('PASS: Codex called both forwarded tools and received their results');
      break;
    }
    for (const call of message.content.filter(b => b.type === 'toolCall')) {
      assert.ok(['dispatch', 'long_task'].includes(call.name));
      seen.add(call.name);
      context.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: `${call.name}: ${nonce}` }], isError: false, timestamp: Date.now() });
    }
    if (step === 5) throw new Error('Probe exceeded tool-call limit');
  }
} finally {
  controller.abort();
  clearTimeout(timer);
}
