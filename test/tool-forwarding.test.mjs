// Run OFF the live HUD host: node --experimental-strip-types --test test/tool-forwarding.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
process.env.PI_CODEX_BIN = fileURLToPath(new URL('./fake-appserver.mjs', import.meta.url));
const { streamCodexAppServer, currentTools, parkedToolResult, serializeHistory } = await import('../src/appserver.ts');
const model = { api: 'codex-bridge', provider: 'codex', id: 'default' };
const tools = ['dispatch', 'long_task'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
const context = (text) => ({ tools, messages: [{ role: 'user', content: text, timestamp: 1 }] });
const resultMessage = (id, isError = false, content = [{ type: 'text', text: 'worker-launched' }]) => ({ role: 'toolResult', toolCallId: id, toolName: 'dispatch', content, isError, timestamp: 1 });
const run = (ctx, signal) => streamCodexAppServer(model, ctx, { signal }).result();
const nextContext = (ctx, assistant, isError, content) => ({ ...ctx, messages: [...ctx.messages, assistant, resultMessage(assistant.content.find(b => b.type === 'toolCall').id, isError, content)] });

test('forwards HUD tools, then returns the actual Pi tool result', { timeout: 5000 }, async () => {
  const ctx = context('normal');
  const first = await run(ctx);
  assert.equal(first.stopReason, 'toolUse');
  assert.equal(first.content[0].name, 'dispatch');
  const final = await run(nextContext(ctx, first, false));
  assert.equal(final.stopReason, 'stop');
  assert.match(final.content.map(b => b.text ?? '').join(''), /worker-launched/);
});

test('preserves failed tool results and images', { timeout: 5000 }, async () => {
  const ctx = context('normal');
  const first = await run(ctx);
  const final = await run(nextContext(ctx, first, true, [{ type: 'text', text: 'denied' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]));
  const value = JSON.parse(final.content.map(b => b.text ?? '').join(''));
  assert.equal(value.success, false);
  assert.equal(value.contentItems[1].imageUrl, 'data:image/png;base64,aGVsbG8=');
});

test('buffers concurrent tool requests until Pi can execute each', { timeout: 5000 }, async () => {
  const ctx = context('parallel');
  const first = await run(ctx);
  const ctx2 = nextContext(ctx, first, false);
  const second = await run(ctx2);
  assert.equal(second.stopReason, 'toolUse');
  assert.equal(second.content[0].name, 'long_task');
  const final = await run(nextContext(ctx2, second, false));
  assert.equal(final.stopReason, 'stop');
});

test('keeps simultaneous conversations separate', { timeout: 5000 }, async () => {
  const ctx = context('normal');
  const [a, b] = await Promise.all([run(ctx), run(ctx)]);
  assert.notEqual(a.content[0].id, b.content[0].id);
  const results = await Promise.all([run(nextContext(ctx, a, false)), run(nextContext(ctx, b, false))]);
  assert.ok(results.every(r => r.stopReason === 'stop'));
});

test('rejects tool names absent from the calling session', { timeout: 5000 }, async () => {
  const result = await run(context('forbidden'));
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content.some(b => b.type === 'toolCall'), false);
  assert.match(result.content.map(b => b.text ?? '').join(''), /not available/);
});

test('turn failure and process exit produce errors', { timeout: 5000 }, async () => {
  const failed = await run(context('failed'));
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.errorMessage, /inference failed/);
  const exited = await run(context('exit'));
  assert.equal(exited.stopReason, 'error');
  assert.match(exited.errorMessage, /closed/);
});

test('abort closes an active turn', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const result = run(context('pending'), controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await result).stopReason, 'aborted');
});

test('abort during tool execution invalidates the parked continuation', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const ctx = context('normal');
  const first = await run(ctx, controller.signal);
  controller.abort();
  const result = await run(nextContext(ctx, first, false));
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /continuation is unavailable/);
});

test('unknown continuation fails instead of starting duplicate work', async () => {
  const result = await run({ tools, messages: [resultMessage('unknown')] });
  assert.equal(result.stopReason, 'error');
});

test('normalizes tools and applies transcript removals', () => {
  const ctx = context('normal');
  ctx.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'dispatch' }], timestamp: 2 });
  assert.deepEqual(currentTools(ctx).map(t => t.name), ['long_task']);
  assert.equal(parkedToolResult(ctx), null);
});

test('serializes actual Pi results and system sections into fresh turns', () => {
  const history = serializeHistory({ messages: [
    { role: 'system', content: 'base', sections: { hud: 'use HUD tools' }, timestamp: 0 },
    resultMessage('id', true, [{ type: 'text', text: 'permission denied' }]),
  ] });
  assert.match(history, /use HUD tools/);
  assert.match(history, /permission denied/);
});
