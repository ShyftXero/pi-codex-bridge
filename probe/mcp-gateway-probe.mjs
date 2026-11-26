#!/usr/bin/env node
// Discover registered MCP tools, or explicitly exercise one selected tool.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const usage = [
  'Usage: npm run probe:mcp',
  '       npm run probe:mcp -- --call SERVER TOOL ARGUMENTS_JSON',
  '',
  'Default: list enabled tools without executing any of them.',
  '--call executes the named tool; choose a safe operation explicitly.',
].join('\n');
const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length && (args.length !== 4 || args[0] !== '--call')) {
  throw new Error(usage);
}
let toolArguments;
if (args.length) {
  toolArguments = JSON.parse(args[3]);
  assert.ok(toolArguments && typeof toolArguments === 'object' &&
    !Array.isArray(toolArguments), 'Tool arguments must be a JSON object');
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') &&
        context.parentURL?.includes('/src/')) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  },
});
const { registerMcpGateway, localToolName } =
  await import('../src/mcp-gateway.ts');
const tools = new Map();
const events = new Map();
registerMcpGateway({
  registerTool: tool => tools.set(tool.name, tool),
  registerCommand() {},
  on: (name, handler) => events.set(name, handler),
  getAllTools: () => [...tools.values()],
  getActiveTools: () => [],
  setActiveTools() {},
});

let ready;
let failure;
const discovered = new Promise(resolve => { ready = resolve; });
const ctx = {
  cwd: process.cwd(),
  ui: {
    notify(message, level) {
      if (level === 'error') failure = message;
      else console.log(message);
    },
    setStatus(_key, value) { if (!value) ready(); },
  },
};
try {
  events.get('session_start')({}, ctx);
  await discovered;
  // Startup's background error reporter runs after its status is cleared.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!failure, failure);
  console.log('Registered tools:', tools.size);
  if (args.length) {
    const name = localToolName(args[1], args[2]);
    const tool = tools.get(name);
    assert.ok(tool, 'Requested tool is not registered; check the allowlist');
    const result = await tool.execute('probe', toolArguments);
    assert.equal(result.isError, false, 'MCP tool returned an error');
    console.log('PASS: direct gateway call returned',
      result.content.map(block => block.type).join(', '));
  } else {
    for (const tool of tools.values()) {
      console.log(`${tool.name}: ${tool.label}`);
    }
  }
} finally {
  await events.get('session_shutdown')({}, ctx);
}
