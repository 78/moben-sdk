import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { AppRequestError, connect, defineApp, md, page, type AppDefinition, type ConnectionStatus } from '../src';

const silent = { info() {}, warn() {}, error() {} };
const context = {
  requestId: 'request-1', appId: 'k7m3xq.tasks', mountPath: '/apps/k7m3xq.tasks', openId: 'od_test', locale: 'en-US', timezone: 'America/Los_Angeles',
  client: { width: 460, height: 700, textPixelSize: 28, features: [], protocol: 1 }
};

function tasksApp() {
  const items = new Map([['a', 'Buy milk']]);
  let added = 0;
  const app = defineApp({
    manifest: {
      manifestVersion: 1, id: 'tasks', name: 'Tasks', version: '0.1.0', entry: '/', permissions: [],
      agent: { instructions: 'Manage tasks.', tools: [{ name: 'add', description: 'Add a task', mutates: true, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }] }
    },
    pages: {
      '/': ctx => page(ctx, { title: 'Tasks' }).heading('Tasks').list([...items].map(([id, title]) => `${md.text(title)} ${md.action('Delete', ctx.url(`/items/${id}/delete`))}`)).toString(),
      '/items/:id': ctx => {
        if (!items.has(ctx.params.id)) throw new AppRequestError(404, 'Task was deleted');
        return page(ctx).paragraph(items.get(ctx.params.id)).toString();
      }
    },
    actions: { '/items/:id/delete': ctx => { items.delete(ctx.params.id); return ctx.renderPage('/'); } },
    tools: { add: async (_ctx, args) => { added += 1; items.set(`n${added}`, String(args.title)); return { result: { added: args.title }, uiEffects: [{ type: 'reload' }] }; } }
  });
  return { app, items, added: () => added };
}

async function fakeCloud() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: Array<{ ws: WebSocket; auth: string; hello: Promise<any> }> = [];
  server.on('connection', (ws, request) => {
    const hello = new Promise(resolve => ws.once('message', raw => {
      const message = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { appId: 'k7m3xq.tasks', mountPath: '/apps/k7m3xq.tasks', heartbeatSeconds: 30, limits: {} } }));
      resolve(message);
    }));
    sockets.push({ ws, auth: String(request.headers.authorization), hello });
  });
  let next = 0;
  const call = (ws: WebSocket, method: string, params: object) => new Promise<any>(resolve => {
    const id = `c-${++next}`;
    const chunks: string[] = [];
    const listener = (raw: unknown) => {
      const message = JSON.parse(String(raw));
      if (message.method === 'page.chunk' && message.params.id === id) { chunks.push(message.params.markdown); return; }
      if (message.id !== id) return;
      ws.off('message', listener);
      resolve({ ...message, markdown: chunks.join('') });
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { context, ...params } }));
  });
  return { server, url, sockets, call };
}

test('connect handshakes, serves pages, actions and tools, and maps errors', async t => {
  const cloud = await fakeCloud();
  t.after(() => cloud.server.close());
  const tasks = tasksApp();
  const statuses: ConnectionStatus[] = [];
  const logs: string[] = [];
  const logger = { ...silent, info: (line: string) => logs.push(line) };
  const connection = connect(tasks.app, { key: 'mdk_test', url: cloud.url, logger, onStatus: status => statuses.push(status) });
  t.after(() => connection.close());
  await once(cloud.server, 'connection');
  const { ws, auth, hello } = cloud.sockets[0];
  assert.equal(auth, 'Bearer mdk_test');
  const helloMessage = await hello;
  assert.equal(helloMessage.method, 'app.hello');
  assert.equal(helloMessage.params.manifest.id, 'tasks');
  assert.equal(helloMessage.params.protocol, 1);
  assert.deepEqual(helloMessage.params.routes, { pages: ['/', '/items/:id'], actions: ['/items/:id/delete'], progress: [], voice: [] });

  const home = await cloud.call(ws, 'page.get', { url: '/apps/k7m3xq.tasks/', path: '/', query: '', route: '/', params: {} });
  assert.match(home.markdown, /^<!-- moben:page .*"url":"\/apps\/k7m3xq\.tasks\/"/);
  assert.match(home.markdown, /\[Delete\]\(action:\/apps\/k7m3xq\.tasks\/items\/a\/delete\)/);

  const missing = await cloud.call(ws, 'page.get', { url: '/apps/k7m3xq.tasks/items/zz', path: '/items/zz', query: '', route: '/items/:id', params: { id: 'zz' } });
  assert.deepEqual(missing.error, { code: -32000, message: 'Task was deleted', data: { httpStatus: 404 } });

  const toolCall = { name: 'add', arguments: { title: 'Pay the power bill' }, requestId: 'tool-1', page: null };
  const first = await cloud.call(ws, 'tool.call', toolCall);
  const replay = await cloud.call(ws, 'tool.call', toolCall);
  assert.deepEqual(first.result, { result: { added: 'Pay the power bill' }, uiEffects: [{ type: 'reload' }] });
  assert.deepEqual(replay.result, first.result);
  assert.equal(tasks.added(), 1);

  const invalid = await cloud.call(ws, 'tool.call', { ...toolCall, arguments: {}, requestId: 'tool-2' });
  assert.equal(invalid.error.data.httpStatus, 400);
  assert.match(invalid.error.message, /missing title/);

  const action = await cloud.call(ws, 'action.post', {
    url: '/apps/k7m3xq.tasks/items/a/delete', path: '/items/a/delete', query: '', route: '/items/:id/delete', params: { id: 'a' },
    currentPage: { url: '/apps/k7m3xq.tasks/' }, body: { currentPage: { url: '/apps/k7m3xq.tasks/' } }, requestId: 'action-1'
  });
  assert.equal(tasks.items.has('a'), false);
  assert.deepEqual(action.result, { path: '/apps/k7m3xq.tasks/' });
  const updated = await cloud.call(ws, 'page.get', { url: action.result.path, path: '/', route: '/', params: {} });
  assert.doesNotMatch(updated.markdown, /Buy milk/);

  const unknown = await cloud.call(ws, 'storage.get', {});
  assert.equal(unknown.error.code, -32601);
  assert.ok(statuses.includes('online'));
  assert.deepEqual(logs, ['[moben] tasks is online']);
});

test('a revoked connection stops instead of reconnecting', async t => {
  const cloud = await fakeCloud();
  t.after(() => cloud.server.close());
  let stopped!: () => void;
  const done = new Promise<void>(resolve => { stopped = resolve; });
  const connection = connect(tasksApp().app, { key: 'mdk_test', url: cloud.url, logger: silent, onStatus: status => { if (status === 'stopped') stopped(); } });
  t.after(() => connection.close());
  await once(cloud.server, 'connection');
  await cloud.sockets[0].hello;
  cloud.sockets[0].ws.close(4001, 'revoked');
  await done;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(cloud.sockets.length, 1);
  assert.equal(connection.status, 'stopped');
});

test('remote apps declare a local ID and plain tool names', () => {
  const app = tasksApp().app;
  // The namespace comes from the developer key, so IDs have no dot.
  assert.throws(() => defineApp({ ...app, manifest: { ...app.manifest, id: 'k7m3xq.tasks' } }), /manifest\.id must be 2-31 lowercase letters/);
  const { id: _id, ...withoutId } = app.manifest;
  assert.throws(() => defineApp({ ...app, manifest: withoutId } as unknown as AppDefinition), /manifest\.id must be/);
  const badTool = { ...app.manifest.agent.tools[0], name: 'Add-Task' };
  assert.throws(() => defineApp({ ...app, manifest: { ...app.manifest, agent: { ...app.manifest.agent, tools: [badTool] } } }), /agent\.tools\[0\]: name must be lowercase letters/);
  assert.throws(() => defineApp({ ...app, tools: {} }), /tool add: add a handler to tools\.add/);
  assert.throws(() => defineApp({ ...app, tools: { ...app.tools, extra: async () => ({ result: null }) } }), /tools\.extra is not declared/);
  const titled = { ...app, manifest: { ...app.manifest, locales: { 'zh-CN': { name: '任务', tools: { add: '添加' } } } } };
  assert.equal(defineApp(titled), titled);
  for (const showCall of [undefined, true, false, null, 0, 'false']) {
    const candidate = { ...app, manifest: { ...app.manifest, agent: { ...app.manifest.agent, tools: app.manifest.agent.tools.map(tool => ({ ...tool, showCall })) } } };
    if (showCall === undefined || typeof showCall === 'boolean') assert.equal(defineApp(candidate as AppDefinition), candidate);
    else assert.throws(() => defineApp(candidate as AppDefinition), /showCall must be a boolean/);
  }
});


test('API WebSocket closure delivers partial audio and reconnects only the app connection', { timeout: 10000 }, async t => {
  const cloud = await fakeCloud();
  t.after(() => cloud.server.close());
  const seen: Buffer[] = [];
  let finish!: (value: unknown) => void;
  const saved = new Promise(resolve => { finish = resolve; });
  const app = defineApp({ ...tasksApp().app, voice: { '/record': { input: 'audio', handler: async (ctx, audio) => {
    for await (const chunk of audio.chunks) seen.push(chunk);
    finish({ end: await audio.done, aborted: ctx.signal.aborted });
  } } } });
  const connection = connect(app, { key: 'mdk_test', url: cloud.url, logger: silent });
  t.after(() => connection.close());
  await once(cloud.server, 'connection'); await cloud.sockets[0].hello;
  const ws = cloud.sockets[0].ws;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'recording', method: 'voice.start', params: {
    context, url: '/apps/k7m3xq.tasks/record', path: '/record', route: '/record', params: {}, currentPage: { url: '/apps/k7m3xq.tasks/' }, requestId: 'partial-recording', input: 'audio'
  } }));
  const audio = Buffer.from('received audio bytes');
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'voice.audio', params: { id: 'recording', data: audio.toString('base64'), durationMs: 3600000 } }));
  for (let wait = 0; wait < 100 && !seen.length; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  const reconnect = once(cloud.server, 'connection');
  ws.close(1001, 'server_shutdown');
  assert.deepEqual(await saved, { end: { complete: false, durationMs: 3600000 }, aborted: false });
  assert.deepEqual(Buffer.concat(seen), audio);
  await reconnect; await cloud.sockets[1].hello;
});
