#!/usr/bin/env node
// Deterministic MCP transport fixture; no credentials or network access.
import { createInterface } from 'node:readline';

const send = value => console.log(JSON.stringify(value));
const tool = (description, annotations = {}) => ({
  description,
  inputSchema: {
    type: 'object', properties: { query: { type: 'string' } },
    required: ['query'], additionalProperties: false,
  },
  annotations,
});

// Synthetic managed apps exercise namespacing without vendor dependencies.
const appTool = (connector, description, annotations) => ({
  ...tool(description, annotations),
  _meta: { connector_id: `app-${connector}`, connector_name: connector },
});

createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;

  let result = {};
  switch (method) {
    case 'initialize':
      if (!params.capabilities.experimentalApi) process.exit(2);
      break;
    case 'thread/start':
      result = { thread: { id: 'gateway-thread' } };
      break;
    case 'mcpServerStatus/list':
      result = params.cursor ? {
        data: [{
          name: 'local', tools: { 'lookup.item': tool('local lookup') },
        }],
      } : {
        data: [{
          name: 'codex_apps',
          tools: {
            'notes.search': appTool('notes', 'Search notes', {
              readOnlyHint: true,
            }),
            'notes.send': appTool('notes', 'Write notes', {
              destructiveHint: true,
            }),
            'notes.unknown': appTool('notes', 'Unannotated notes operation'),
            'issues.search': appTool('issues', 'Search issues'),
          },
        }],
        nextCursor: 'page-two',
      };
      break;
    case 'mcpServer/tool/call':
      if (process.env.FAKE_MCP_FORBID_CALL) process.exit(5);
      if (params.threadId !== 'gateway-thread') process.exit(3);
      if (params.arguments.query === 'pending') return;
      if (params.arguments.query === 'exit') process.exit(4);
      result = {
        content: [{ type: 'text', text: JSON.stringify(params) }],
        structuredContent: { ok: true },
        isError: params.arguments.query === 'error',
      };
      break;
    default:
      send({ id, error: { code: -32601, message: method } });
      return;
  }
  if (method === 'initialize' && process.env.FAKE_MCP_DELAY_MS) {
    setTimeout(() => send({ id, result }),
      Number(process.env.FAKE_MCP_DELAY_MS));
  } else {
    send({ id, result });
  }
});
