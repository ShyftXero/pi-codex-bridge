#!/usr/bin/env node
// Verify that Codex emits reasoning/thinking events through the app-server bridge.
import assert from 'node:assert/strict';
import { streamCodexAppServer } from '../src/appserver.ts';

const id = process.env.PI_CODEX_PROBE_MODEL;
if (!id || id === 'default') throw new Error('Set PI_CODEX_PROBE_MODEL to an explicit model ID');

const model = { api: 'codex-bridge', provider: 'codex', id };
const context = {
  tools: [],
  messages: [
    { role: 'user', content: 'Briefly explain how HTTP works. Think step-by-step internally before answering.', timestamp: Date.now() },
  ],
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);

let sawThinking = false;
let sawText = false;

try {
  const stream = streamCodexAppServer(model, context, { signal: controller.signal, reasoning: 'high' });
  for await (const ev of stream) {
    if (ev.type === 'thinking_start' || ev.type === 'thinking_delta' || ev.type === 'thinking_end') sawThinking = true;
    if (ev.type === 'text_delta' || ev.type === 'text_end') sawText = true;
  }
  const message = await stream.result();
  const normal = message.stopReason === 'stop' || message.stopReason === 'length';
  if (sawThinking) {
    console.log('PASS: Codex emitted reasoning/thinking events on this model');
  } else {
    console.log('WARN: No thinking events observed; model or account may not expose reasoning deltas');
  }
  if (!normal) console.log(`WARN: Stream ended with stopReason=${message.stopReason} error=${message.errorMessage ?? ''}`);
  if (!sawText) throw new Error('No text output observed');
} finally {
  controller.abort();
  clearTimeout(timer);
}
