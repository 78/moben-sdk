import assert from 'node:assert/strict';
import test from 'node:test';
import { defineApp, page, type AppContext } from '../src';
import { sanitizeAppMarkdown } from '../src/core/page-check';
import { Dispatcher, type StreamChannel } from '../src/dispatch';
import { LocalApp } from '../src/local';

const mountPath = '/apps/k7m3xq.live';
const context = (protocol = 2) => ({
  requestId: 'request-1', appId: 'k7m3xq.live', mountPath, openId: 'od_test', locale: 'en', timezone: 'UTC',
  client: { width: 460, height: 700, textPixelSize: 28, features: [], protocol }
});
const target = (path: string, protocol?: number) => ({ context: context(protocol), url: `${mountPath}${path}`, path, query: '', route: path, params: {} });
const drain = () => new Promise(resolve => setImmediate(resolve));

function liveApp() {
  const state = { closed: false, gate: Promise.resolve() };
  const header = (ctx: AppContext) => page(ctx, { title: 'Task', interaction: { autoPage: false } }).toString();
  const app = defineApp({
    manifest: { manifestVersion: 1, id: 'live', name: 'Live', version: '1.0.0', entry: '/', permissions: [], agent: { instructions: '', tools: [] } },
    pages: {
      '/': async function* (ctx) {
        yield header(ctx);
        yield '# Task\n\nStarted';
        await state.gate;
        yield ' and finished.\n';
      },
      '/forever': async function* (ctx) {
        try {
          yield header(ctx);
          await new Promise(resolve => ctx.signal.addEventListener('abort', resolve));
        } finally {
          state.closed = true;
        }
      },
      '/static': ctx => page(ctx, { title: 'Static' }).paragraph('Done').toString()
    },
    actions: {
      '/approve': ctx => ctx.renderPage('/'),
      '/finish': ctx => ctx.renderPage('/static')
    },
    tools: {}
  });
  return { app, state };
}

function channel() {
  const notes: Array<{ method: string; params: any }> = [];
  const value: StreamChannel = { id: 'c-1', notify: (method, params) => notes.push({ method, params }) };
  return { notes, value, text: () => notes.filter(note => note.method === 'page.chunk').map(note => note.params.markdown).join('') };
}

test('every page uses chunks, including strings and calls without a stream flag', async () => {
  const { app } = liveApp();
  const dispatcher = new Dispatcher(app);
  for (const path of ['/', '/static']) {
    const stream = channel();
    assert.deepEqual(await dispatcher.handle('page.get', target(path), new AbortController().signal, stream.value), { done: true });
    assert.match(stream.text(), /^<!-- moben:page /);
    assert.match(stream.text(), path === '/' ? /Started and finished/ : /Done/);
  }
  await assert.rejects(dispatcher.handle('page.get', target('/'), new AbortController().signal), /stream channel/);
});

test('cancelling a streamed page closes the handler', async () => {
  const { app, state } = liveApp();
  const controller = new AbortController();
  const stream = channel();
  const reply = new Dispatcher(app).handle('page.get', { ...target('/forever') }, controller.signal, stream.value);
  while (!stream.notes.length) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new Error('Request canceled'));
  await assert.rejects(reply, /Request canceled/);
  await drain();
  assert.equal(state.closed, true);
});

test('a streamed page may stay quiet without sending anything', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { app, state } = liveApp();
  let release!: () => void;
  state.gate = new Promise(resolve => { release = resolve; });
  const stream = channel();
  const reply = new Dispatcher(app).handle('page.get', { ...target('/') }, new AbortController().signal, stream.value);
  await drain();
  t.mock.timers.tick(50);
  assert.equal(stream.notes.filter(note => note.method === 'page.chunk').length, 1, 'a burst travels as one chunk');
  t.mock.timers.tick(10 * 60000);
  assert.equal(stream.notes.length, 1);
  release();
  await drain();
  t.mock.timers.tick(50);
  assert.deepEqual(await reply, { done: true });
  assert.match(stream.text(), /Started and finished/);
});

test('page activity follows its metadata, stays out of Markdown and stops after cancellation', async () => {
  for (const [protocol, features, capable] of [[2, ['appPageActivity'], true], [2, [], true]] as const) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const app = defineApp({
      manifest: { manifestVersion: 1, id: 'activity', name: 'Activity', version: '1.0.0', entry: '/', permissions: [], agent: { instructions: '', tools: [] } },
      pages: { '/': async function* (ctx) {
        yield page(ctx, { interaction: { autoPage: false } }).heading('Task').toString();
        ctx.setActivity('waiting');
        ctx.setActivity('thinking');
        ctx.setActivity('executing');
        ctx.setActivity('waitingApproval');
        ctx.setActivity('waitingInput');
        await gate;
        ctx.setActivity('idle');
        yield 'Finished\n';
      } }, tools: {}
    });
    const stream = channel();
    const controller = new AbortController();
    const request = { ...target('/', protocol), context: { ...context(protocol), client: { ...context(protocol).client, features: [...features] }, appId: 'k7m3xq.activity', mountPath: '/apps/k7m3xq.activity' }, url: '/apps/k7m3xq.activity/' };
    const reply = new Dispatcher(app).handle('page.get', { ...request }, controller.signal, stream.value);
    await drain();
    if (capable) {
      assert.equal(stream.notes[0].method, 'page.chunk');
      assert.deepEqual(stream.notes[1], { method: 'page.activity', params: { id: 'c-1', state: 'waiting' } });
      assert.deepEqual(stream.notes[2], { method: 'page.activity', params: { id: 'c-1', state: 'thinking' } });
      assert.deepEqual(stream.notes.slice(1).map(note => note.params.state), ['waiting', 'thinking', 'executing', 'waitingApproval', 'waitingInput']);
    } else assert.ok(stream.notes.every(note => note.method === 'page.chunk'));
    assert.doesNotMatch(stream.text(), /waiting|Waiting|thinking|Thinking/);
    controller.abort(new Error('left page'));
    await assert.rejects(reply, /left page/);
    const count = stream.notes.length;
    release();
    await drain();
    assert.equal(stream.notes.length, count);
  }
});

test('an action whose result page streams returns only its path', async () => {
  const { app } = liveApp();
  const dispatcher = new Dispatcher(app);
  const action = (path: string, stream: boolean, requestId: string) => dispatcher.handle('action.post', {
    ...target(path), currentPage: { url: `${mountPath}/` }, body: {}, requestId, ...(stream ? { stream: true } : {})
  }, new AbortController().signal);
  assert.deepEqual(await action('/approve', true, 'a-1'), { path: `${mountPath}/` });
  assert.deepEqual(await action('/approve', false, 'a-2'), { path: `${mountPath}/` });
  assert.deepEqual(await action('/finish', true, 'a-3'), { path: `${mountPath}/static` });
});

test('local previews use the same incremental checks by default', async () => {
  const { app } = liveApp();
  const local = new LocalApp(app);
  const parts: string[] = [];
  const result = await local.page('/', { onText: text => parts.push(text) });
  assert.equal(parts.join(''), result.markdown);
  assert.match(result.markdown, /Started and finished/);
  assert.deepEqual(result.issues, []);
  const fixed: string[] = [];
  assert.match((await local.page('/static', { onText: text => fixed.push(text) })).markdown, /Done/);
  assert.equal(fixed.length, 1);
  app.pages['/static'] = ctx => page(ctx, { interaction: { autoPage: true } }).paragraph('Content').toString();
  assert.match((await local.page('/static')).markdown, /"autoPage":true/);
});

test('string-page activity follows metadata and action descriptors accept a root without trailing slash', async () => {
  const { app } = liveApp();
  app.pages['/static'] = ctx => { ctx.setActivity('waiting'); return page(ctx).paragraph('Ready').toString(); };
  const stream = channel();
  const dispatcher = new Dispatcher(app);
  await dispatcher.handle('page.get', target('/static'), new AbortController().signal, stream.value);
  assert.equal(stream.notes[0].method, 'page.chunk');
  assert.deepEqual(stream.notes.at(-1), { method: 'page.activity', params: { id: 'c-1', state: 'waiting' } });
  app.actions!['/root'] = ctx => ctx.renderCurrentPage();
  const result = await dispatcher.handle('action.post', { ...target('/root'), currentPage: { url: `${mountPath}?q=1` }, requestId: 'root', body: {} }, new AbortController().signal);
  assert.deepEqual(result, { path: `${mountPath}?q=1` });
});
