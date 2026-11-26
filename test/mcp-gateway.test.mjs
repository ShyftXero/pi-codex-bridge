import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

// Production uses .js specifiers; resolve source TS in strip-types tests.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') &&
        context.parentURL?.includes('/src/')) {
      return next(specifier.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  },
});

const directory = await mkdtemp(join(tmpdir(), 'codex-gateway-test-'));
process.env.PI_CODING_AGENT_DIR = directory;
const fake = fileURLToPath(new URL('./fake-mcp-appserver.mjs',
  import.meta.url));
await chmod(fake, 0o755);
process.env.PI_CODEX_BIN = fake;
const gateway = await import('../src/mcp-gateway.ts');
after(() => rm(directory, { recursive: true, force: true }));

function harness() {
  const events = new Map();
  const rawEvents = new Map();
  const tools = new Map();
  const commands = new Map();
  let active = [];
  const pi = {
    on(name, handler) {
      rawEvents.set(name, handler);
      // Most existing tests need a ready catalog. Keep the raw handler
      // accessible for assertions about nonblocking lifecycle behavior.
      events.set(name, name === 'session_start' ? async (...args) => {
        handler(...args);
        await ctx.ready;
      } : name === 'session_shutdown' ? () => handler({}, ctx) : handler);
    },
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getAllTools: () => [...tools.values(), { name: 'tool_search' }],
    getActiveTools: () => active,
    setActiveTools: names => { active = names; },
  };
  const ctx = {
    cwd: directory,
    ready: Promise.resolve(),
    ui: {
      notify: text => { ctx.notice = text; },
      setStatus(_key, value) {
        ctx.status = value;
        if (value) {
          ctx.ready = new Promise(resolve => { ctx.resolveReady = resolve; });
        } else {
          // Allow the background error handler to publish its notification.
          setImmediate(() => ctx.resolveReady?.());
        }
      },
    },
    waitForIdle: async () => {},
  };
  gateway.registerMcpGateway(pi);
  return { events, rawEvents, tools, commands, ctx,
    active: () => active };
}

async function config(connectors) {
  await writeFile(gateway.configPath, JSON.stringify({
    mcp: { connectors },
  }));
}

const visible = h => [...h.tools.values()]
  .filter(tool => tool.exposure !== 'hidden');

test('config defaults, empty allowlist, and invalid config', async () => {
  assert.deepEqual(await gateway.readConnectors(), []);

  await writeFile(gateway.configPath, '{}');
  assert.deepEqual(await gateway.readConnectors(), []);

  await writeFile(gateway.configPath, '{"mcp":{}}');
  assert.deepEqual(await gateway.readConnectors(), []);

  await config([]);
  assert.deepEqual(await gateway.readConnectors(), []);

  await config('notes');
  await assert.rejects(gateway.readConnectors(), /array/);

  await writeFile(gateway.configPath, '{broken');
  await assert.rejects(gateway.readConnectors(), SyntaxError);
});

test('new installs discover connectors but enable no tools by default',
  async () => {
    await rm(gateway.configPath);
    const h = harness();
    h.ctx.hasUI = true;
    h.ctx.ui.select = async (_title, options) => {
      assert.ok(options.includes('[off] notes'));
      assert.ok(options.includes('[off] issues'));
      assert.ok(options.includes('[off] local'));
      return undefined;
    };
    try {
      await h.events.get('session_start')({}, h.ctx);
      assert.equal(visible(h).length, 0);
      await h.commands.get('codex-mcp').handler('', h.ctx);
      assert.deepEqual(await gateway.readConnectors(), []);
    } finally {
      await h.events.get('session_shutdown')();
    }
  });

test('gateway discovery, calls, refresh and cancellation',
  { timeout: 10_000 }, async () => {
    await config(['notes']);
    const h = harness();
    try {
      await h.events.get('session_start')({}, h.ctx);
      assert.equal(visible(h).length, 3, h.ctx.notice);
      assert.ok(h.active().includes('tool_search'));
      assert.ok(visible(h).every(t => t.exposure === 'deferred'));

      // Both write and unannotated tools are intentionally included.
      const search = visible(h).find(t => t.description.startsWith('Search'));
      assert.ok(visible(h).some(t => t.annotations.destructiveHint));
      assert.ok(visible(h).some(t => !Object.keys(t.annotations).length));
      assert.deepEqual(search.parameters.required, ['query']);
      const result = await search.execute('id', { query: 'hello' });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { ok: true });
      const call = JSON.parse(result.content[0].text);
      assert.equal(call.server, 'codex_apps');
      assert.equal(call.tool, 'notes.search');
      assert.deepEqual(call.arguments, { query: 'hello' });

      const failed = await search.execute('id', { query: 'error' });
      assert.equal(failed.isError, true);

      await config(['issues', 'local']);
      await h.commands.get('codex-mcp').handler('refresh', h.ctx);
      assert.equal(visible(h).length, 2);
      await assert.rejects(search.execute('id', { query: 'stale' }),
        /unavailable/);

      const next = visible(h)[0];
      const controller = new AbortController();
      const pending = next.execute('id', { query: 'pending' },
        controller.signal);
      controller.abort();
      await assert.rejects(pending, /disposed/);

      // Recovery is explicit; the cancelled call is never retried.
      await h.commands.get('codex-mcp').handler('refresh', h.ctx);
      const recovered = await visible(h)[0].execute('id', { query: 'ok' });
      assert.equal(recovered.isError, false);

      await config([]);
      await h.commands.get('codex-mcp').handler('refresh', h.ctx);
      assert.equal(visible(h).length, 0);
    } finally {
      h.events.get('session_shutdown')();
    }
  });

test('TUI mounts immediately and Enter toggles without closing/remounting',
  { timeout: 5000 }, async () => {
    const { initTheme } = await import('@earendil-works/pi-coding-agent');
    initTheme('dark');
    await config(['notes']);
    process.env.FAKE_MCP_DELAY_MS = '150';
    const h = harness();
    h.ctx.hasUI = true;
    h.ctx.mode = 'tui';
    let component;
    let mounts = 0;
    let dismissals = 0;
    h.ctx.ui.custom = factory => new Promise(resolve => {
      mounts++;
      component = factory({ requestRender() {} }, {
        fg: (_color, text) => text, bold: text => text,
      }, {
        matches: (data, action) =>
          action === 'tui.select.cancel' && data === '\u001b',
      }, () => { dismissals++; resolve(); });
    });
    async function until(predicate) {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'UI update timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      h.rawEvents.get('session_start')({}, h.ctx);
      const command = h.commands.get('codex-mcp').handler('', h.ctx);
      await until(() => component !== undefined);
      assert.match(component.render(80).join('\n'), /Discovering connectors/);
      await until(() => component.render(80).join('\n').includes('issues'));

      // The first setting is issues. Enter should toggle it in-place.
      // Existing definitions must survive: toggles use the cached catalog.
      const originalSearch = visible(h).find(tool =>
        tool.description.startsWith('Search notes'));
      component.handleInput('\r');
      await until(() => visible(h).length === 4);
      assert.deepEqual(await gateway.readConnectors(), ['notes', 'issues']);
      assert.equal(visible(h).find(tool =>
        tool.description.startsWith('Search notes')), originalSearch);
      assert.equal(mounts, 1);
      assert.equal(dismissals, 0);

      component.handleInput('\r');
      await until(() => visible(h).length === 3);
      assert.deepEqual(await gateway.readConnectors(), ['notes']);
      assert.equal(mounts, 1);
      assert.equal(dismissals, 0);
      assert.ok(component.render(30).every(line =>
        !line.includes('Discovering connectors')));

      component.handleInput('\u001b');
      await command;
      assert.equal(dismissals, 1);
    } finally {
      delete process.env.FAKE_MCP_DELAY_MS;
      await h.events.get('session_shutdown')();
    }
  });

test('picker is a passive view; Escape prevents late action updates',
  async () => {
    const { showConnectorPicker } = await import('../src/connector-picker.ts');
    const state = {
      connectors: [{ id: 'notes', label: 'Notes', enabled: false }],
      discovering: false,
    };
    let component;
    let mounts = 0;
    let renders = 0;
    let listener;
    let refreshes = 0;
    let toggles = 0;
    let rejectToggle;
    const pendingToggle = new Promise((_resolve, reject) => {
      rejectToggle = reject;
    });
    const ctx = { ui: { custom: factory => new Promise(resolve => {
      mounts++;
      component = factory({ requestRender() { renders++; } }, {
        fg: (_color, text) => text, bold: text => text,
      }, {
        matches: (data, action) =>
          action === 'tui.select.cancel' && data === '\u001b',
      }, resolve);
    }) } };
    const shown = showConnectorPicker(ctx, {
      snapshot: () => state,
      subscribe(callback) {
        listener = callback;
        return () => { listener = undefined; };
      },
      async refresh() { refreshes++; },
      toggle() { toggles++; return pendingToggle; },
    });
    assert.equal(mounts, 1);
    assert.equal(refreshes, 0);
    assert.equal(toggles, 0);

    component.handleInput('\r');
    assert.equal(toggles, 1);
    assert.match(component.render(80).join('\n'), /Saving/);
    component.handleInput('\u001b');
    await shown;
    assert.equal(listener, undefined);

    const before = renders;
    rejectToggle(new Error('late failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(renders, before);
    assert.equal(mounts, 1);
    assert.equal(refreshes, 0);
  });

test('startup returns immediately; picker joins background discovery',
  { timeout: 5000 }, async () => {
    await config(['notes']);
    process.env.FAKE_MCP_DELAY_MS = '250';
    const h = harness();
    h.ctx.hasUI = true;
    let opened = false;
    h.ctx.ui.select = async () => {
      opened = true;
      assert.equal(visible(h).length, 3);
      return undefined;
    };
    try {
      const result = h.rawEvents.get('session_start')({}, h.ctx);
      assert.equal(result, undefined);
      assert.match(h.ctx.status, /connecting/);
      assert.equal(visible(h).length, 0);

      const picker = h.commands.get('codex-mcp').handler('', h.ctx);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(opened, false);
      await picker;
      assert.equal(opened, true);
      assert.equal(h.ctx.status, undefined);

      // A ready picker must reuse the existing tool objects/connection.
      const search = visible(h)[0];
      await h.commands.get('codex-mcp').handler('', h.ctx);
      assert.equal(visible(h)[0], search);
    } finally {
      delete process.env.FAKE_MCP_DELAY_MS;
      await h.events.get('session_shutdown')();
    }
  });

test('shutdown cancels startup before config I/O completes', async () => {
  await config(['notes']);
  const h = harness();
  h.rawEvents.get('session_start')({}, h.ctx);
  await h.events.get('session_shutdown')();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.tools.size, 0);
  assert.equal(h.ctx.notice, undefined);
  assert.equal(h.ctx.status, undefined);
});

test('shutdown cancels an in-flight RPC without late registration',
  { timeout: 5000 }, async () => {
    await config(['notes']);
    process.env.FAKE_MCP_DELAY_MS = '1000';
    const h = harness();
    try {
      h.rawEvents.get('session_start')({}, h.ctx);
      await new Promise(resolve => setTimeout(resolve, 100));
      await h.events.get('session_shutdown')();
      assert.equal(h.tools.size, 0);
      assert.equal(h.ctx.notice, undefined);
      assert.equal(h.ctx.status, undefined);
    } finally {
      delete process.env.FAKE_MCP_DELAY_MS;
      await h.events.get('session_shutdown')();
    }
  });

test('picker enables and disables connectors from an empty allowlist',
  { timeout: 10_000 }, async () => {
    await writeFile(gateway.configPath, JSON.stringify({
      other: { keep: true }, mcp: { connectors: [], extra: 42 },
    }));
    const h = harness();
    h.ctx.hasUI = true;
    const choices = ['[off] notes', '[off] issues', '[on] notes'];
    let selections = 0;
    h.ctx.ui.select = async (_title, options) => {
      // Changes are persisted and reflected in tool registration before
      // the next picker is displayed, with no model/provider involved.
      const expectedCounts = [0, 3, 4, 1];
      assert.equal(visible(h).length, expectedCounts[selections]);
      const choice = choices[selections++];
      if (choice) assert.ok(options.includes(choice));
      return choice;
    };
    try {
      await h.events.get('session_start')({}, h.ctx);
      await h.commands.get('codex-mcp').handler('', h.ctx);
      assert.equal(selections, 4);
      assert.deepEqual(await gateway.readConnectors(), ['issues']);
      const saved = JSON.parse(await readFile(gateway.configPath, 'utf8'));
      assert.deepEqual(saved.other, { keep: true });
      assert.equal(saved.mcp.extra, 42);
      assert.equal(visible(h).length, 1);
    } finally {
      h.events.get('session_shutdown')();
    }
  });

test('picker refreshes without changing config; Escape is a no-op',
  async () => {
    await config(['notes']);
    const h = harness();
    h.ctx.hasUI = true;
    let visits = 0;
    h.ctx.ui.select = async (_title, options) => {
      visits++;
      assert.ok(options.includes('[on] notes'));
      return visits === 1 ? 'Refresh available connectors' : undefined;
    };
    try {
      await h.events.get('session_start')({}, h.ctx);
      await h.commands.get('codex-mcp').handler('', h.ctx);
      assert.equal(visits, 2);
      assert.deepEqual(await gateway.readConnectors(), ['notes']);
      assert.equal(visible(h).length, 3);
    } finally {
      h.events.get('session_shutdown')();
    }
  });

test('saving refuses malformed config rather than overwriting it',
  async () => {
    await writeFile(gateway.configPath, '{broken');
    await assert.rejects(gateway.saveConnectors(['issues']), SyntaxError);
    assert.equal(await readFile(gateway.configPath, 'utf8'), '{broken');
  });

test('startup errors are reported without exposing tools', async () => {
  await config(123);
  const h = harness();
  try {
    await h.events.get('session_start')({}, h.ctx);
    assert.equal(visible(h).length, 0);
    assert.match(h.ctx.notice, /array/);
  } finally {
    h.events.get('session_shutdown')();
  }
});

test('process failure is returned, not retried', async () => {
  await config(['notes']);
  const h = harness();
  try {
    await h.events.get('session_start')({}, h.ctx);
    await assert.rejects(visible(h)[0].execute('id', { query: 'exit' }),
      /closed/);
    await assert.rejects(visible(h)[0].execute('id', { query: 'next' }),
      /closed/);
  } finally {
    h.events.get('session_shutdown')();
  }
});

test('text, images, structured results and errors survive conversion',
  async () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ];
    const result = await gateway.toolResult({
      content, structuredContent: { count: 1 }, isError: true,
    });
    assert.deepEqual(result.content, content);
    assert.deepEqual(result.structuredContent, { count: 1 });
    assert.equal(result.isError, true);
  });

test('names are stable, bounded and collision resistant', () => {
  const a = gateway.localToolName('a-b', 'notes.x');
  const b = gateway.localToolName('a_b', 'notes.x');
  assert.notEqual(a, b);
  assert.equal(a, gateway.localToolName('a-b', 'notes.x'));
  assert.ok(a.length <= 64);
  assert.match(a, /^[a-zA-Z0-9_]+$/);
});

test('connector IDs work without broadening to the shared server', () => {
  const tool = { _meta: { connector_id: 'app-id' } };
  assert.equal(gateway.isAllowed(['app-id'], 'codex_apps',
    'notes.search', tool), true);
  assert.equal(gateway.isAllowed(['codex_apps'], 'codex_apps',
    'notes.search', tool), false);
});

test('ordinary dotted tool names belong to their server', () => {
  assert.equal(gateway.isAllowed(['local'], 'local', 'lookup.item', {}),
    true);
  assert.equal(gateway.isAllowed(['lookup'], 'local', 'lookup.item', {}),
    false);
});

test('probe lists tools by default and calls only an explicit selection',
  { timeout: 5000 }, async () => {
    await config(['notes']);
    const probe = fileURLToPath(new URL('../probe/mcp-gateway-probe.mjs',
      import.meta.url));
    const execute = promisify(execFile);
    const listed = await execute(process.execPath, [probe], {
      env: { ...process.env, FAKE_MCP_FORBID_CALL: '1' },
    });
    assert.match(listed.stdout, /Registered tools: 3/);
    assert.match(listed.stdout, /notes\.search/);
    assert.doesNotMatch(listed.stdout, /PASS: direct gateway call/);

    const called = await execute(process.execPath, [probe, '--call',
      'codex_apps', 'notes.search', '{"query":"example"}']);
    assert.match(called.stdout, /PASS: direct gateway call returned text/);

    await assert.rejects(execute(process.execPath, [probe, '--call',
      'codex_apps', 'issues.search', '{"query":"example"}']),
    /Requested tool is not registered/);
  });

test('large output is bounded and complete data is recoverable', async () => {
  const remote = { content: [{ type: 'text', text: 'x'.repeat(60_000) }] };
  const result = await gateway.toolResult(remote);
  try {
    assert.ok(result.content[0].text.length < 53_000);
    assert.deepEqual(JSON.parse(await readFile(result.details.path,
      'utf8')), remote);
  } finally {
    await rm(join(result.details.path, '..'), { recursive: true });
  }
});
