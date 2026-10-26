import assert from 'node:assert/strict';
import test from 'node:test';
import { AppRequestError, defineApp, page, type AppContext } from '../src';
import { helloParams } from '../src/define';
import { Dispatcher, type StreamChannel } from '../src/dispatch';
import { LocalApp } from '../src/local';

const mountPath = '/apps/k7m3xq.live';
const context = { requestId: 'request-1', appId: 'k7m3xq.live', mountPath, openId: 'od_test', locale: 'zh-CN', timezone: 'UTC', client: { width: 460, height: 700, textPixelSize: 28, features: [], protocol: 2 } };
const start = (route: string, input: 'audio' | 'text', extra: object = {}) => ({
  context, url: `${mountPath}${route.replace(':id', '1')}`, path: route.replace(':id', '1'), query: '', route, params: { id: '1' },
  currentPage: { url: `${mountPath}/tasks/1`, revision: 'r1' }, requestId: 'voice-1', input, ...extra
});
const drain = () => new Promise(resolve => setImmediate(resolve));
const channel = (id: string): StreamChannel => ({ id, notify: () => {} });

// 60 ms per Ogg page after the header page, like the device's encoder.
function oggPage(body: Buffer, flags: number, seq: number, granule: number) {
  const header = Buffer.alloc(28);
  header.write('OggS'); header[5] = flags; header.writeUIntLE(granule, 6, 6); header.writeUInt32LE(seq, 18); header[26] = 1; header[27] = body.length;
  return Buffer.concat([header, body]);
}
const recording = Buffer.concat([oggPage(Buffer.from('OpusHead'), 2, 0, 0), ...Array.from({ length: 50 }, (_v, index) => oggPage(Buffer.alloc(200, index), 0, index + 1, (index + 1) * 2880))]);

function voiceApp(log: string[] = []) {
  return defineApp({
    manifest: { manifestVersion: 1, id: 'live', name: 'Live', version: '1.0.0', entry: '/', permissions: [], agent: { instructions: '', tools: [] } },
    pages: {
      '/': ctx => page(ctx, { title: 'Home' }).paragraph('No recording here').toString(),
      '/tasks/:id': ctx => page(ctx, { title: 'Task', voice: { mode: 'capture', url: ctx.url(`/tasks/${ctx.params.id}/say`), hint: '说出下一步' } }).paragraph(`Task ${ctx.params.id}`).toString(),
      '/tasks/:id/notes': ctx => page(ctx, { title: 'Notes', voice: { mode: 'capture', url: ctx.url(`/tasks/${ctx.params.id}/memo`) } }).paragraph('Notes').toString(),
      '/live': async function* (ctx) { yield page(ctx, { title: 'Live' }).toString(); yield 'Running\n'; }
    },
    tools: {},
    voice: {
      // Text: the recording parameter is typed by input.
      '/tasks/:id/say': {
        input: 'text',
        handler: async (ctx, speech) => {
          for await (const text of speech.transcripts) log.push(text);
          const { transcript, language, complete } = await speech.done;
          log.push(`done ${transcript} ${language} ${complete} ${ctx.currentPage?.revision}`);
          if (transcript === 'stream') return ctx.renderPage('/live');
          if (transcript === 'later') return { kind: 'accepted' };
          return ctx.renderPage(`/tasks/${ctx.params.id}`);
        }
      },
      '/tasks/:id/memo': {
        input: 'audio',
        handler: async (_ctx, audio) => {
          const chunks: Buffer[] = [];
          for await (const chunk of audio.chunks) chunks.push(chunk);
          const { complete, durationMs } = await audio.done;
          log.push(`audio ${Buffer.concat(chunks).length} ${audio.format.codec} ${complete} ${durationMs}`);
        }
      },
      '/tasks/:id/busy': { input: 'audio', handler: () => { throw new AppRequestError(409, '任务正忙'); } }
    }
  });
}

test('voice routes join the hello and need a handler', () => {
  assert.deepEqual(helloParams(voiceApp()).routes.voice, [
    { route: '/tasks/:id/say', input: 'text' }, { route: '/tasks/:id/memo', input: 'audio' }, { route: '/tasks/:id/busy', input: 'audio' }
  ]);
  const base = { manifest: { manifestVersion: 1 as const, id: 'live', name: 'Live', version: '1.0.0', entry: '/', permissions: [], agent: { instructions: '', tools: [] } }, pages: { '/': () => '' }, tools: {} };
  assert.throws(() => defineApp({ ...base, voice: { '/say': { input: 'text' } } } as any), /voice \/say: add a handler/);
  assert.throws(() => defineApp({ ...base, voice: { '/say': { input: 'video', handler: () => {} } } } as any), /input must be/);
});

test('an audio handler reads the recording while it arrives and accepts it', async () => {
  const log: string[] = [];
  const dispatcher = new Dispatcher(voiceApp(log));
  const reply = dispatcher.handle('voice.start', start('/tasks/:id/memo', 'audio', { format: { container: 'ogg', codec: 'opus', sampleRate: 16000, channels: 1 } }), new AbortController().signal, channel('v1'));
  const half = recording.length >> 1;
  dispatcher.notify('voice.audio', { id: 'v1', seq: 0, data: recording.subarray(0, half).toString('base64') });
  dispatcher.notify('voice.audio', { id: 'other', seq: 0, data: 'AAAA' });
  await drain();
  dispatcher.notify('voice.audio', { id: 'v1', seq: 1, data: recording.subarray(half).toString('base64') });
  dispatcher.notify('voice.end', { id: 'v1', complete: false, durationMs: 3000 });
  assert.deepEqual(await reply, { kind: 'accepted' });
  assert.deepEqual(log, [`audio ${recording.length} opus false 3000`]);
  // The recording is forgotten once the handler has replied.
  dispatcher.notify('voice.end', { id: 'v1', complete: true, durationMs: 1 });
});

test('a text handler receives only the final words and returns a page like an action', async () => {
  const log: string[] = [];
  const dispatcher = new Dispatcher(voiceApp(log));
  const run = async (transcript: string, extra: object = {}) => {
    log.length = 0;
    const reply = dispatcher.handle('voice.start', start('/tasks/:id/say', 'text', extra), new AbortController().signal, channel('t1'));
    dispatcher.notify('voice.transcript', { id: 't1', text: '开' });
    await drain();
    dispatcher.notify('voice.transcript', { id: 't1', text: '开始' });
    await drain();
    dispatcher.notify('voice.end', { id: 't1', complete: true, durationMs: 1200, transcript, language: 'zh' });
    return reply as Promise<any>;
  };
  const shown = await run('开始构建');
  assert.deepEqual(shown, { path: `${mountPath}/tasks/1` });
  assert.deepEqual(log, ['开始构建', 'done 开始构建 zh true r1']);
  // A streamed result page is opened by the cloud, so only its path returns.
  assert.deepEqual(await run('stream', { stream: true }), { path: `${mountPath}/live` });
  assert.deepEqual(await run('stream'), { path: `${mountPath}/live` });
  assert.deepEqual(await run('later'), { kind: 'accepted' });
});

test('cancelling ends the streams and the handler; an app can refuse at once', async () => {
  const dispatcher = new Dispatcher(voiceApp());
  const controller = new AbortController();
  const reply = dispatcher.handle('voice.start', start('/tasks/:id/say', 'text'), controller.signal, channel('c1'));
  dispatcher.notify('voice.transcript', { id: 'c1', text: '算了' });
  await drain();
  controller.abort(new Error('Request canceled'));
  await assert.rejects(reply, /Request canceled/);

  const refused = dispatcher.handle('voice.start', start('/tasks/:id/busy', 'audio'), new AbortController().signal, channel('b1'));
  await assert.rejects(refused, (error: any) => error.httpStatus === 409);
  await assert.rejects(dispatcher.handle('voice.start', start('/tasks/:id/nope', 'audio'), new AbortController().signal, channel('n1')), (error: any) => error.httpStatus === 404);
  // The route's input must match what the cloud announces.
  await assert.rejects(dispatcher.handle('voice.start', start('/tasks/:id/memo', 'text'), new AbortController().signal, channel('m1')), (error: any) => error.httpStatus === 404);
});

test('moben app voice records locally and checks the page it starts from', async () => {
  const log: string[] = [];
  const local = new LocalApp(voiceApp(log), { locale: 'zh-CN' });
  const said = await local.voice('/tasks/1/say', { page: '/tasks/1', text: '开始构建项目' });
  assert.equal(said.accepted, false);
  assert.deepEqual(said.issues, []);
  assert.match(said.page!.markdown, /Task 1/);
  assert.deepEqual(log, ['开始构建项目', 'done 开始构建项目 zh true undefined']);
  // The page shown to a recording device keeps its voice settings.
  assert.deepEqual((await local.page('/tasks/1')).voice, { mode: 'capture', url: `${local.mountPath}/tasks/1/say`, hint: '说出下一步' });
  assert.match((await local.page('/tasks/1')).markdown, /Task 1/);

  log.length = 0;
  const memo = await local.voice('/tasks/1/memo', { page: '/tasks/1/notes', audio: recording });
  assert.equal(memo.accepted, true);
  assert.deepEqual(log, [`audio ${recording.length} opus true 3000`]);

  // Starting from a page that records elsewhere is reported.
  const elsewhere = await local.voice('/tasks/1/memo', { page: '/', audio: recording });
  assert.match(elsewhere.issues[0], /does not declare voice/);
  await assert.rejects(local.voice('/tasks/1/say', { page: '/tasks/1', audio: recording }), /text route/);
  await assert.rejects(local.voice('/tasks/1/memo', { page: '/tasks/1/notes', text: 'hi' }), /audio route/);
  await assert.rejects(local.voice('/tasks/1/busy', { page: '/tasks/1', audio: recording }), /任务正忙/);
});

// Compile-time only: a text handler cannot read audio chunks.
export const typed: Parameters<typeof defineApp>[0] = {
  manifest: { manifestVersion: 1, id: 'typed', name: 'Typed', version: '1.0.0', entry: '/', permissions: [], agent: { instructions: '', tools: [] } },
  pages: { '/': (ctx: AppContext) => page(ctx, { title: 'T' }).toString() },
  tools: {},
  voice: {
    // @ts-expect-error transcripts only exist on text recordings
    '/a': { input: 'audio', handler: async (_ctx, recording) => { for await (const _text of recording.transcripts) break; } },
    '/t': { input: 'text', handler: async (_ctx, recording) => { await recording.done; } }
  }
};


test('API disconnection finishes received audio without aborting its handler', async () => {
  const log: string[] = [];
  const dispatcher = new Dispatcher(voiceApp(log));
  const controller = new AbortController();
  const reply = dispatcher.handle('voice.start', start('/tasks/:id/memo', 'audio'), controller.signal, channel('partial'));
  dispatcher.notify('voice.audio', { id: 'partial', data: recording.toString('base64'), durationMs: 3000 });
  assert.equal(dispatcher.disconnect('partial'), true);
  assert.deepEqual(await reply, { kind: 'accepted' });
  assert.deepEqual(log, [`audio ${recording.length} opus false 3000`]);
  assert.equal(controller.signal.aborted, false);
  assert.equal(dispatcher.disconnect('partial'), false);
});

test('explicit audio cancellation still aborts, and text is not saved partially', async () => {
  const dispatcher = new Dispatcher(voiceApp());
  const controller = new AbortController();
  const audio = dispatcher.handle('voice.start', start('/tasks/:id/memo', 'audio'), controller.signal, channel('cancel-audio'));
  controller.abort(new Error('Request canceled'));
  await assert.rejects(audio, /Request canceled/);
  const textController = new AbortController();
  const text = dispatcher.handle('voice.start', start('/tasks/:id/say', 'text'), textController.signal, channel('text-lost'));
  assert.equal(dispatcher.disconnect('text-lost'), false);
  textController.abort(new Error('Connection closed'));
  await assert.rejects(text, /Connection closed/);
});
