import { PAGE_ACTIVITY_STATES, resolveAppLocale, type PageActivity, type AppPageOutput, type AppPageSnapshot, type JsonObject, type PageResponse } from './core';
import { matchRoute, normalizeAppUrl } from './core/page-check';
import { pageChunks } from './core/page-stream';
import type { AppContext, AppDefinition, AudioRecording, TextRecording, VoiceAudioFormat } from './types';

const RECEIPT_TTL_MS = 5 * 60000;
const HTTP_STATUSES = new Set([400, 403, 404, 409, 410, 422, 429]);
// Chunks yielded in a burst travel as one message.
const CHUNK_MERGE_MS = 50;
// Even if every character needs a JSON escape, a chunk stays under 512 KiB.
const MAX_CHUNK_CHARS = 64 * 1024;

// The moben CLI sets this before loading an app entry: connect() then hands
// the app to the CLI instead of going online.
export const CAPTURE_APP = Symbol.for('@moben-ai/app-sdk/capture');

/** Throw from a page, action or tool to show `message` to the user with an HTTP status. */
export class AppRequestError extends Error {
  constructor(readonly httpStatus: 400 | 403 | 404 | 409 | 410 | 422 | 429, message: string) {
    super(message);
    this.name = 'AppRequestError';
  }
}

export type RemoteContext = {
  requestId: string; appId: string; mountPath: string; openId: string; locale: string; timezone: string;
  location?: AppContext['location']; client: AppContext['client'];
};
export type RouteTarget = { context: RemoteContext; url: string; path: string; route: string; params: Record<string, string> };

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Notifications for one request that the cloud asked to stream. */
export type StreamChannel = { id: string | number; notify(method: string, params: object): void };

// Every page uses page.chunk notifications; a string is one final chunk. It may
// pause for as long as it likes. Cancelling the request stops reading and
// closes the handler's iterator; handlers should also watch ctx.signal while
// they wait.
async function streamPage(output: AppPageOutput | Promise<AppPageOutput>, signal: AbortSignal, channel: StreamChannel,
  bindActivity: (report: (state: PageActivity) => void) => void) {
  let pending = '';
  let started = false;
  let activity: PageActivity | undefined;
  let mergeTimer: NodeJS.Timeout | undefined;
  const flush = () => {
    clearTimeout(mergeTimer);
    mergeTimer = undefined;
    while (pending) {
      const chunk = pending.slice(0, MAX_CHUNK_CHARS);
      pending = pending.slice(chunk.length);
      channel.notify('page.chunk', { id: channel.id, markdown: chunk });
      started = true;
    }
    if (started && activity !== undefined) {
      channel.notify('page.activity', { id: channel.id, state: activity });
      activity = undefined;
    }
  };
  bindActivity(state => {
    if (signal.aborted) return;
    if (!PAGE_ACTIVITY_STATES.includes(state)) throw new Error('Invalid page activity.');
    activity = state;
    flush(); // Metadata and earlier text must arrive before their activity.
  });
  try {
    for await (const chunk of pageChunks(output, signal)) {
      pending += chunk;
      mergeTimer ??= setTimeout(flush, CHUNK_MERGE_MS);
    }
    flush();
  } finally {
    bindActivity(() => {});
    clearTimeout(mergeTimer);
  }
}

// A single-reader queue for audio and the one final text result.
class Feed<T> {
  private items: T[] = [];
  private ended = false;
  private failure: unknown;
  private wake: (() => void) | null = null;

  push(item: T) {
    if (this.ended) return;
    this.items.push(item);
    this.wake?.();
  }

  end(failure?: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.failure = failure;
    this.wake?.();
  }

  async *read(): AsyncGenerator<T> {
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      if (this.items.length) { yield this.items.shift()!; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

// One voice.start request: the notifications naming it feed the handler's
// recording until voice.end; $/cancel aborts the request signal.
class Recording {
  private readonly feed: Feed<Buffer | string>;
  private ended = false;
  private durationMs = 0;
  private resolveDone!: (end: any) => void;
  readonly view: AudioRecording | TextRecording;

  constructor(readonly input: 'audio' | 'text', signal: AbortSignal, format: VoiceAudioFormat) {
    this.feed = new Feed();
    let rejectDone!: (reason: unknown) => void;
    const done = new Promise<any>((resolve, reject) => { this.resolveDone = resolve; rejectDone = reject; });
    // Handlers that only read the stream never look at done.
    done.catch(() => {});
    const onAbort = () => {
      const reason = signal.reason ?? new Error('Recording canceled');
      this.feed.end(reason);
      rejectDone(reason);
    };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const stream = { [Symbol.asyncIterator]: () => this.feed.read() };
    this.view = input === 'audio'
      ? { input, format, chunks: stream as AsyncIterable<Buffer>, done }
      : { input, transcripts: stream as AsyncIterable<string>, done };
  }

  finishPartial(): boolean {
    if (this.input !== 'audio') return false;
    this.receive('voice.end', { complete: false, durationMs: this.durationMs });
    return true;
  }

  receive(method: string, params: any) {
    if (this.ended) return;
    if (method === 'voice.audio' && this.input === 'audio' && typeof params.data === 'string') {
      if (Number.isFinite(params.durationMs) && params.durationMs >= 0) this.durationMs = Math.max(this.durationMs, params.durationMs);
      this.feed.push(Buffer.from(params.data, 'base64'));
    }
    else if (method === 'voice.end') {
      this.ended = true;
      const end = { complete: params.complete !== false, durationMs: Number.isFinite(params.durationMs) ? params.durationMs : 0 };
      if (this.input === 'text') {
        const transcript = typeof params.transcript === 'string' ? params.transcript : '';
        this.feed.push(transcript);
        this.resolveDone({ ...end, transcript, language: typeof params.language === 'string' ? params.language : '' });
      } else {
        this.resolveDone(end);
      }
      this.feed.end();
    }
  }
}

// The device records 16 kHz mono Ogg/Opus.
export const VOICE_FORMAT: VoiceAudioFormat = { container: 'ogg', codec: 'opus', sampleRate: 16000, channels: 1 };

function createContext(remote: RemoteContext, options: {
  url: string; params?: Record<string, string>; page?: AppPageSnapshot | null;
  currentPage?: { url: string; revision?: string }; signal: AbortSignal; requestId?: string;
  activity?: (state: PageActivity) => void;
}): AppContext {
  const { mountPath } = remote;
  const appUrl = (path: string) => `${mountPath}${path.startsWith('/') ? path : `/${path}`}`;
  return {
    appId: remote.appId, mountPath, requestId: options.requestId ?? remote.requestId, openId: remote.openId,
    locale: remote.locale, timezone: remote.timezone, ...(remote.location ? { location: remote.location } : {}), client: remote.client,
    page: options.page ?? null, currentPage: options.currentPage ?? { url: options.url },
    query: new URL(options.url, 'https://apps.invalid').searchParams, params: options.params ?? {}, signal: options.signal,
    setActivity: state => { options.activity?.(state); },
    url: (path, linkOptions = {}) => `${appUrl(path)}${linkOptions.history === 'replace' ? '#history=replace' : ''}`,
    renderCurrentPage: (pageOptions = {}) => ({ kind: 'page', path: options.currentPage?.url ?? options.url, ...pageOptions }),
    renderPage: (path, pageOptions = {}) => ({ kind: 'page', path: appUrl(path), ...pageOptions })
  };
}

const typeMatches = (type: unknown, value: unknown): boolean => {
  if (Array.isArray(type)) return type.some(item => typeMatches(item, value));
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof type !== 'string' || typeof value === type;
};

// The cloud never compiles developer schemas, so the SDK checks the common
// top-level constraints; handlers should still validate business rules.
function checkArguments(schema: JsonObject, args: unknown): string | null {
  if (!typeMatches('object', args)) return 'arguments must be an object';
  const values = args as JsonObject;
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  for (const name of (schema.required ?? []) as string[]) if (!(name in values)) return `missing ${name}`;
  for (const [name, value] of Object.entries(values)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument ${name}`;
      continue;
    }
    if (property.type !== undefined && !typeMatches(property.type, value)) return `${name} must be ${JSON.stringify(property.type)}`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `${name} must be one of ${JSON.stringify(property.enum)}`;
  }
  return null;
}

export class Dispatcher {
  private receipts = new Map<string, { expiresAt: number; result: Promise<unknown> }>();
  private recordings = new Map<string | number, Recording>();

  constructor(private readonly app: AppDefinition) {}

  handle(method: string, params: any, signal: AbortSignal, channel?: StreamChannel): Promise<unknown> {
    if (method === 'page.get') return this.page(params, signal, channel);
    if (method === 'action.post') return this.once(`action:${params.requestId}`, () => this.action(params, signal));
    if (method === 'progress.post') return this.progress(params, signal);
    if (method === 'voice.start') return this.voice(params, signal, channel);
    if (method === 'tool.call') {
      const mutates = this.app.manifest.agent.tools.some(tool => tool.name === params.name && tool.mutates);
      return mutates ? this.once(`tool:${params.requestId}`, () => this.tool(params, signal)) : this.tool(params, signal);
    }
    return Promise.reject(new RpcError(-32601, 'Method not found'));
  }

  // A lost API connection ends audio normally so an existing handler can save
  // its received bytes. Other requests still abort; no session survives/replays.
  disconnect(id: string | number): boolean {
    return this.recordings.get(id)?.finishPartial() ?? false;
  }

  /** Delivers voice.audio and voice.end to the recording they name. */
  notify(method: string, params: any) {
    this.recordings.get(params?.id)?.receive(method, params);
  }

  // The cloud retries with the same request ID; replays reuse the first result.
  private once(key: string, run: () => Promise<unknown>) {
    const now = Date.now();
    for (const [cached, receipt] of this.receipts) if (receipt.expiresAt <= now) this.receipts.delete(cached);
    const saved = this.receipts.get(key);
    if (saved) return saved.result;
    const result = run();
    this.receipts.set(key, { expiresAt: now + RECEIPT_TTL_MS, result });
    result.catch(() => this.receipts.delete(key));
    return result;
  }

  private async output(remote: RemoteContext, url: string, signal: AbortSignal, requestId?: string,
    activity?: (state: PageActivity) => void): Promise<AppPageOutput> {
    const path = new URL(url, 'https://apps.invalid').pathname.slice(remote.mountPath.length) || '/';
    const route = matchRoute(this.app.pages, path);
    if (!route) throw new AppRequestError(404, 'Page not found.');
    const ctx = createContext(remote, { url, params: route.params, signal, requestId, activity });
    return route.handler(ctx);
  }

  private async page(params: RouteTarget, signal: AbortSignal, channel?: StreamChannel) {
    if (!channel) throw new RpcError(-32602, 'A page stream channel is required. Update the Moben SDK/cloud together.');
    let activity = (_state: PageActivity) => {};
    const output = Promise.resolve().then(() => this.output(params.context, params.url, signal, undefined, state => activity(state)));
    await streamPage(output, signal, channel, report => { activity = report; });
    return { done: true };
  }

  private async action(params: RouteTarget & { currentPage: { url: string; revision?: string }; requestId: string }, signal: AbortSignal) {
    const handler = this.app.actions?.[params.route];
    if (!handler) throw new AppRequestError(404, 'Action not found.');
    const ctx = createContext(params.context, { url: params.url, params: params.params, currentPage: params.currentPage, signal, requestId: params.requestId });
    const response: PageResponse = await handler(ctx);
    if (!response || response.kind !== 'page') throw new Error('Action handlers must return ctx.renderCurrentPage() or ctx.renderPage(path).');
    return this.pageReply(params, response);
  }

  // The page an action or voice handler leads to.
  private pageReply(params: { context: RemoteContext; requestId: string }, response: PageResponse) {
    const extras = { ...(response.initialFocus ? { initialFocus: response.initialFocus } : {}), ...(response.startMode ? { startMode: response.startMode } : {}) };
    const url = normalizeAppUrl(response.path, { mountPath: params.context.mountPath });
    const path = new URL(url, 'https://apps.invalid').pathname.slice(params.context.mountPath.length) || '/';
    if (!matchRoute(this.app.pages, path)) throw new AppRequestError(404, 'Page not found.');
    return { path: url, ...extras };
  }

  // The handler runs while the user speaks; its reply is the result, sent
  // when it returns (usually after recording.done).
  private async voice(params: RouteTarget & { currentPage: { url: string; revision?: string }; requestId: string; input: 'audio' | 'text'; format?: VoiceAudioFormat }, signal: AbortSignal, channel?: StreamChannel) {
    const route = this.app.voice?.[params.route];
    if (!route || !channel || route.input !== params.input) throw new AppRequestError(404, 'Voice input not found.');
    const recording = new Recording(route.input, signal, params.format ?? VOICE_FORMAT);
    this.recordings.set(channel.id, recording);
    try {
      const ctx = createContext(params.context, { url: params.url, params: params.params, currentPage: params.currentPage, signal, requestId: params.requestId });
      const reply = await (route.handler as (ctx: AppContext, recording: AudioRecording | TextRecording) => unknown)(ctx, recording.view) as PageResponse | { kind: 'accepted' } | undefined;
      if (reply === undefined || reply?.kind === 'accepted') return { kind: 'accepted' };
      if (reply?.kind !== 'page') throw new Error('Voice handlers must return nothing, { kind: "accepted" }, ctx.renderCurrentPage() or ctx.renderPage(path).');
      return this.pageReply(params, reply);
    } finally {
      this.recordings.delete(channel.id);
    }
  }

  private async progress(params: RouteTarget & { report?: JsonObject }, signal: AbortSignal) {
    const handler = this.app.progress?.[params.route];
    if (!handler) throw new AppRequestError(404, 'Action not found.');
    const ctx = createContext(params.context, { url: params.url, params: params.params, signal });
    const result = await handler(ctx, params.report ?? {});
    return { accepted: result?.accepted !== false };
  }

  private async tool(params: { context: RemoteContext; name: string; arguments: JsonObject; requestId: string; page: AppPageSnapshot | null }, signal: AbortSignal) {
    const definition = this.app.manifest.agent.tools.find(tool => tool.name === params.name);
    const handler = this.app.tools[params.name];
    if (!definition || !handler) throw new AppRequestError(404, 'Tool not found.');
    const problem = checkArguments(definition.inputSchema, params.arguments);
    if (problem) throw new AppRequestError(400, `Invalid tool arguments: ${problem}`);
    const ctx = createContext(params.context, { url: params.page?.url ?? `${params.context.mountPath}/`, page: params.page ?? null, signal, requestId: params.requestId });
    const output = await handler(ctx, params.arguments);
    return { result: output?.result ?? null, ...(output?.uiEffects ? { uiEffects: output.uiEffects } : {}) };
  }
}

export function toRpcError(error: any, locale: string | undefined, logger: Pick<Console, 'error'> | undefined, method: string) {
  if (error instanceof RpcError) return { code: error.code, message: error.message };
  if (HTTP_STATUSES.has(error?.httpStatus)) return { code: -32000, message: String(error.message ?? '').slice(0, 200), data: { httpStatus: error.httpStatus } };
  logger?.error(`[moben] ${method} failed:`, error);
  // Unexpected failures stay private; the device shows a generic message.
  return { code: -32603, message: resolveAppLocale(locale) === 'zh-CN' ? '应用处理请求时出错' : 'The app failed to handle this request.' };
}
