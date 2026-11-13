#!/usr/bin/env node
// Protocol fixture. No inference, credentials, shell jobs or external writes.
import readline from 'node:readline';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ id, result });
let initialized = false;
let mode;
let next = 100;
let completed = 0;
let expected = 1;
let toolNames = new Set();
let threadId = `thread-${process.pid}`;
const error = (id, message) => send({ id, error: { code: -32602, message } });
const call = (tool, namespace = 'pi') => send({ id: next++, method: 'item/tool/call', params: { threadId, turnId: 'turn-1', callId: `call-${next}`, namespace, tool, arguments: { value: 1 } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (!m.params.capabilities?.experimentalApi) return error(m.id, 'experimentalApi required');
    return reply(m.id, {});
  }
  if (m.method === 'initialized') { initialized = true; return; }
  if (m.method === 'thread/start') {
    if (!initialized) return error(m.id, 'initialized notification required');
    const ns = m.params.dynamicTools?.[0];
    if (ns?.type !== 'namespace' || ns.name !== 'pi' || ns.tools.some(t => t.type !== 'function' || !t.inputSchema)) return error(m.id, 'top-level dynamicTools required');
    if (m.params.config?.['features.shell_tool'] !== false || m.params.sandbox !== 'read-only') return error(m.id, 'native shell must be disabled');
    toolNames = new Set(ns.tools.map(t => t.name));
    return reply(m.id, { thread: { id: threadId } });
  }
  if (m.method === 'turn/start') {
    mode = m.params.input[0].text.split('\n').at(-1);
    reply(m.id, { turn: { id: 'turn-1' } });
    if (mode === 'exit') return process.exit(1);
    if (mode === 'failed') return send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'inference failed' } } } });
    if (mode === 'pending') return;
    if (!toolNames.has('dispatch') || !toolNames.has('long_task')) return error(0, 'HUD tools missing');
    if (mode === 'parallel') { expected = 2; call('dispatch'); call('long_task'); }
    else if (mode === 'forbidden') call('not_allowed', 'pi');
    else call('dispatch');
    return;
  }
  if (m.id >= 100 && m.result) {
    completed++;
    if (mode === 'pending-tool') return;
    if (completed === expected) {
      send({ method: 'item/agentMessage/delta', params: { delta: JSON.stringify(m.result) } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  }
});
