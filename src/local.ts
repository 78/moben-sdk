import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_PROTOCOL_LEVEL, localizeAppManifest, type AppPageSnapshot, type JsonObject, type PageMetadata, type UiEffect } from './core';
import type { AppDefinition } from './types';
import { matchRoute, normalizeAppUrl, PageStreamSanitizer, sanitizeUiEffects } from './core/page-check';
import { defineApp } from './define';
import { CAPTURE_APP, Dispatcher, VOICE_FORMAT, type RemoteContext, type StreamChannel } from './dispatch';

// Limits the cloud enforces on remote apps; the local runner reports them
// instead of failing, so slow handlers are still visible.
const PAGE_TIMEOUT_MS = 10000;
const TOOL_TIMEOUT_MS = 15000;
const TOOL_RESULT_BYTES = 8192;
// After voice.end the cloud waits this long for the reply.
const VOICE_REPLY_TIMEOUT_MS = 60000;
// Local runs feed the recording in pieces of this size; the cloud sends
// whatever arrived every 300 ms or 32 KiB.
const VOICE_AUDIO_CHUNK_BYTES = 4096;
const ORIGIN = 'https://apps.invalid';
// A typical device screen; pages get the same values from a real device.
const PREVIEW_CLIENT = { width: 460, height: 700, textPixelSize: 28, features: [] as string[] };

export type LocalOptions = { locale?: string; timezone?: string; city?: string };
export type LocalPage = { url: string; markdown: string; title?: string; revision?: string; voice?: PageMetadata['voice']; issues: string[]; elapsedMs: number; initialFocus?: string; startMode?: string };
export type LocalVoiceOptions = {
  /** Page the device shows while recording (default: the entry page). */
  page?: string;
  /** Ogg/Opus recording for an audio route. */
  audio?: Buffer;
  /** What the user said, for a text route. */
  text?: string;
};
/** accepted: the app shows the result on its page stream; otherwise the page it returned. */
export type LocalVoiceResult = { accepted: boolean; page?: LocalPage; issues: string[]; elapsedMs: number };
export type LocalToolResult = { result: unknown; uiEffects: UiEffect[]; issues: string[]; elapsedMs: number };
export type LocalPageOptions = {
  /** Receives each part of the page as the device would get it. */
  onText?: (text: string) => void;
  /** Stops following the page. */
  signal?: AbortSignal;
};

const ENTRY_CANDIDATES = ['app.ts', 'src/app.ts', 'index.ts', 'app.js', 'index.js'];

/** Finds the app entry: --entry, then common file names, then package.json "main". */
export function findEntry(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Entry file ${explicit} does not exist.`);
    return resolve(explicit);
  }
  const found = ENTRY_CANDIDATES.find(name => existsSync(name));
  if (found) return resolve(found);
  try {
    const main = JSON.parse(readFileSync('package.json', 'utf8')).main;
    if (typeof main === 'string' && existsSync(main)) return resolve(main);
  } catch { /* no package.json */ }
  throw new Error(`No app entry found. Pass --entry <file> or create one of: ${ENTRY_CANDIDATES.join(', ')}.`);
}

/** Resolves a package from the app's own node_modules, such as tsx. */
export function resolveFromApp(entry: string, specifier: string): string | null {
  try { return createRequire(join(dirname(entry), 'package.json')).resolve(specifier); } catch { return null; }
}

const isApp = (value: unknown): value is AppDefinition =>
  Boolean(value) && typeof value === 'object' && typeof (value as AppDefinition).manifest === 'object' && typeof (value as AppDefinition).pages === 'object';

/**
 * Imports the entry with connect() captured, so no connection is opened.
 * Entries that export the app instead of connecting are supported too.
 */
export async function loadApps(entry: string): Promise<AppDefinition[]> {
  const captured: AppDefinition[] = [];
  (globalThis as Record<symbol, unknown>)[CAPTURE_APP] = (app: AppDefinition) => captured.push(app);
  if (/\.[cm]?tsx?$/.test(entry)) {
    const api = resolveFromApp(entry, 'tsx/esm/api');
    if (!api) throw new Error('Loading a TypeScript entry needs tsx in the app: run npm install --save-dev tsx');
    const { register } = await import(pathToFileURL(api).href);
    register();
  }
  const exports = await import(pathToFileURL(entry).href);
  if (!captured.length) {
    const exported = [exports.default, exports.app, exports.default?.default].find(isApp);
    if (exported) captured.push(defineApp(exported));
  }
  if (!captured.length) throw new Error(`${entry} neither calls connect(app) nor exports an app.`);
  return captured;
}

/** Runs an app's pages, actions and tools the way the cloud calls them. */
export class LocalApp {
  readonly appId: string;
  readonly mountPath: string;
  private readonly dispatcher: Dispatcher;
  // The gateway checks pages against the route tables under the public app ID.
  private readonly gatewayView: AppDefinition;

  constructor(readonly app: AppDefinition, private readonly options: LocalOptions = {}) {
    this.appId = `local.${app.manifest.id}`;
    this.mountPath = `/apps/${this.appId}`;
    this.dispatcher = new Dispatcher(app);
    this.gatewayView = { ...app, manifest: { ...app.manifest, id: this.appId } };
  }

  /** Accepts "/path", "path" or a full app URL and returns the device URL. */
  url(path: string): string {
    const target = path.startsWith('action:') ? path.slice(7) : path;
    const absolute = target.startsWith(`${this.mountPath}/`) || target === this.mountPath ? target : `${this.mountPath}${target.startsWith('/') ? '' : '/'}${target}`;
    return normalizeAppUrl(absolute, { mountPath: this.mountPath });
  }

  async page(path = this.app.manifest.entry, options: LocalPageOptions = {}): Promise<LocalPage> {
    const url = this.url(path);
    const started = Date.now();
    const protocol = APP_PROTOCOL_LEVEL;
    const target = { context: this.context(undefined, protocol), ...this.target(url, this.app.pages, 'page') };
    return this.readPage(url, target, started, options);
  }

  // Streams the page through the cloud's incremental checks until the
  // handler finishes or options.signal stops it.
  private async readPage(url: string, target: object, started: number, options: LocalPageOptions): Promise<LocalPage> {
    const issues: string[] = [];
    const manifest = localizeAppManifest(this.gatewayView.manifest, this.options.locale ?? 'en');
    const sanitizer = new PageStreamSanitizer(this.gatewayView, url, { manifest, onIssue: message => issues.push(message) });
    const controller = new AbortController();
    const stop = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
    let markdown = '';
    let firstChunkAt = 0;
    let failure: unknown;
    const emit = (text: string) => {
      if (!text) return;
      markdown += text;
      options.onText?.(text);
    };
    const channel: StreamChannel = {
      id: 'local',
      notify: (method, params: any) => {
        if (method !== 'page.chunk' || failure) return;
        firstChunkAt ||= Date.now();
        try { emit(sanitizer.push(params.markdown)); }
        catch (error) { failure = error; controller.abort(error); }
      }
    };
    try {
      await this.dispatcher.handle('page.get', target, controller.signal, channel);
    } catch (error) {
      throw failure ?? error;
    } finally {
      options.signal?.removeEventListener('abort', stop);
    }
    emit(sanitizer.end());
    if (firstChunkAt - started > PAGE_TIMEOUT_MS) issues.push(`The first part took ${firstChunkAt - started} ms; the cloud gives up after ${PAGE_TIMEOUT_MS / 1000} s.`);
    const metadata = sanitizer.metadata!;
    return {
      url: metadata.page.url, markdown, issues, elapsedMs: Date.now() - started,
      ...(metadata.page.title ? { title: metadata.page.title } : {}),
      ...(metadata.page.revision ? { revision: metadata.page.revision } : {}),
      ...(metadata.voice ? { voice: metadata.voice } : {})
    };
  }

  /**
   * Records into a voice route the way the cloud delivers it: voice.start,
   * the audio in pieces, then voice.end with the final text for text routes.
   */
  async voice(path: string, options: LocalVoiceOptions = {}): Promise<LocalVoiceResult> {
    const url = this.url(path);
    const target = this.target(url, this.app.voice ?? {}, 'voice');
    const input = this.app.voice![target.route].input;
    if (input === 'audio' && !options.audio) throw new Error(`${target.route} is an audio route; pass a recording with --file <file.ogg>.`);
    if (input === 'text' && options.text === undefined) throw new Error(`${target.route} is a text route; the cloud recognizes speech, so pass the words with --text.`);
    const current = await this.page(options.page);
    const issues: string[] = [];
    if (current.voice?.mode !== 'capture' || current.voice.url !== url) {
      issues.push(`${current.url} does not declare voice { mode: "capture", url: "${url}" }; the device records into the voice URL of the page it shows. Pass the right page with --page.`);
    }
    const requestId = randomUUID();
    const id = 'local-voice';
    const started = Date.now();
    const reply = this.dispatcher.handle('voice.start', {
      context: this.context(requestId, APP_PROTOCOL_LEVEL), ...target,
      currentPage: { url: current.url, ...(current.revision ? { revision: current.revision } : {}) }, requestId, input,
      ...(input === 'audio' ? { format: VOICE_FORMAT } : {})
    }, new AbortController().signal, { id, notify: () => {} }) as Promise<{ kind?: string; path?: string; initialFocus?: string; startMode?: string }>;
    let replied = false;
    reply.then(() => { replied = true; }, () => { replied = true; });
    const send = async (method: string, params: object) => {
      // Like the network, deliver each notification after the handler had a chance to run.
      await new Promise(resolve => setImmediate(resolve));
      if (!replied) this.dispatcher.notify(method, { id, ...params });
    };
    if (input === 'audio') {
      const audio = options.audio!;
      for (let offset = 0, seq = 0; offset < audio.length; offset += VOICE_AUDIO_CHUNK_BYTES, seq++) {
        await send('voice.audio', { seq, data: audio.subarray(offset, offset + VOICE_AUDIO_CHUNK_BYTES).toString('base64') });
      }
      await send('voice.end', { complete: true, durationMs: oggDurationMs(audio) });
    } else {
      const text = options.text!.trim();
      if (!text) issues.push('The cloud cancels a recording with no recognized words instead of sending voice.end; the device asks the user to speak again.');
      else await send('voice.end', { complete: true, durationMs: 0, transcript: text, language: (this.options.locale ?? 'en').startsWith('zh') ? 'zh' : 'en' });
    }
    const ended = Date.now();
    const result = await reply;
    const elapsedMs = Date.now() - started;
    if (Date.now() - ended > VOICE_REPLY_TIMEOUT_MS) issues.push(`The reply came ${Date.now() - ended} ms after the recording ended; the cloud gives up after ${VOICE_REPLY_TIMEOUT_MS / 1000} s.`);
    if (result?.kind === 'accepted') return { accepted: true, issues, elapsedMs };
    if (typeof result.path !== 'string') throw new Error('The voice route returned an invalid page destination.');
    const page = await this.page(result.path);
    if (result.initialFocus && !this.links(page.markdown).has(this.linkKey(result.initialFocus))) {
      page.issues.push(`initialFocus ${result.initialFocus} matches no link on the returned page; the device focuses the first link instead.`);
    }
    return { accepted: false, page: { ...page, ...(result.initialFocus ? { initialFocus: result.initialFocus } : {}), ...(result.startMode ? { startMode: result.startMode } : {}) }, issues, elapsedMs };
  }

  /** Runs an action from `fromPath` (default: the entry page) and returns the page it renders. */
  async action(path: string, fromPath?: string): Promise<LocalPage> {
    const current = await this.page(fromPath);
    const url = this.url(path);
    const linked = this.links(current.markdown).has(`action:${url}`);
    const requestId = randomUUID();
    const started = Date.now();
    const reply = await this.dispatcher.handle('action.post', {
      context: this.context(requestId), ...this.target(url, this.app.actions ?? {}, 'action'),
      currentPage: { url: current.url, ...(current.revision ? { revision: current.revision } : {}) }, body: {}, requestId
    }, new AbortController().signal) as { path: string; initialFocus?: string; startMode?: string };
    const page = await this.page(reply.path);
    if (!linked) page.issues.unshift(`${current.url} has no link to action:${url}; the device can only run actions linked from the page it shows. Pass the right page with --page.`);
    if (reply.initialFocus && !this.links(page.markdown).has(this.linkKey(reply.initialFocus))) {
      page.issues.push(`initialFocus ${reply.initialFocus} matches no link on the returned page; the device focuses the first link instead.`);
    }
    return { ...page, ...(reply.initialFocus ? { initialFocus: reply.initialFocus } : {}), ...(reply.startMode ? { startMode: reply.startMode } : {}) };
  }

  /** Link targets on a sanitized page, including Action Sheet options, in comparable form. */
  private links(markdown: string): Set<string> {
    const targets = [...markdown.matchAll(/\]\(([^\s)]+)/g)].map(match => match[1]);
    const sheetItems = [...markdown.matchAll(/"url":"(action:[^"]+)"/g)].map(match => match[1]);
    return new Set([...targets, ...sheetItems].map(target => this.linkKey(target)));
  }

  // Devices compare links as full app URLs; Action Sheet entries by their fragment.
  private linkKey(target: string): string {
    const sheet = target.indexOf('#action-sheet=');
    if (sheet >= 0) return target.slice(sheet);
    try {
      return target.startsWith('action:') ? `action:${this.url(target)}` : this.url(target);
    } catch {
      return target;
    }
  }

  /** Calls a tool by the name declared in the manifest, as the assistant would. */
  async tool(name: string, args: JsonObject = {}, pagePath?: string): Promise<LocalToolResult> {
    const tools = this.app.manifest.agent.tools.map(tool => tool.name);
    if (!tools.includes(name)) throw new Error(`Unknown tool ${name}. Declared tools: ${tools.join(', ') || 'none'}.`);
    const page: AppPageSnapshot | null = pagePath ? { url: this.url(pagePath) } : null;
    const issues: string[] = [];
    const started = Date.now();
    const reply = await this.dispatcher.handle('tool.call', {
      context: this.context(), name, arguments: args, requestId: randomUUID(), page
    }, new AbortController().signal) as { result: unknown; uiEffects?: unknown };
    const elapsedMs = Date.now() - started;
    if (elapsedMs > TOOL_TIMEOUT_MS) issues.push(`The tool took ${elapsedMs} ms; the cloud gives up after ${TOOL_TIMEOUT_MS / 1000} s.`);
    const bytes = Buffer.byteLength(JSON.stringify(reply.result ?? null));
    if (bytes > TOOL_RESULT_BYTES) issues.push(`The result is ${bytes} bytes; the cloud rejects results over ${TOOL_RESULT_BYTES} bytes.`);
    const uiEffects = sanitizeUiEffects(reply.uiEffects, this.mountPath, page?.url, this.gatewayView, message => issues.push(message));
    return { result: reply.result ?? null, uiEffects, issues, elapsedMs };
  }

  private context(requestId = randomUUID(), protocol = APP_PROTOCOL_LEVEL): RemoteContext {
    const { locale = 'en', timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, city } = this.options;
    const location = city && this.app.manifest.permissions.includes('location') ? { location: { city } } : {};
    const client = { ...PREVIEW_CLIENT, protocol };
    return { requestId, appId: this.appId, mountPath: this.mountPath, openId: 'local-preview', locale, timezone, ...location, client };
  }

  private target(url: string, routes: Record<string, unknown>, kind: 'page' | 'action' | 'voice') {
    const parsed = new URL(url, ORIGIN);
    const path = parsed.pathname.slice(this.mountPath.length) || '/';
    const match = matchRoute(Object.fromEntries(Object.keys(routes).map(route => [route, route])), path);
    if (!match) throw new Error(`No ${kind} route matches ${path}. Registered: ${Object.keys(routes).join(', ') || 'none'}.`);
    return { url, path, query: parsed.search, route: match.handler, params: match.params };
  }

}

// Recorded length from the last Ogg page's granule position (48 kHz for Opus).
function oggDurationMs(audio: Buffer) {
  const at = audio.lastIndexOf('OggS');
  return at >= 0 && audio.length >= at + 14 ? Math.round(audio.readUIntLE(at + 6, 6) / 48) : 0;
}

export type ValidationReport = { app: string; errors: string[]; warnings: string[]; pages: Array<{ route: string; locale: string; title?: string; bytes: number; elapsedMs: number }>; skipped: string[] };

/** Renders every page without parameters in English and Chinese and checks localization. */
export async function validateApp(app: AppDefinition, options: Omit<LocalOptions, 'locale'> = {}): Promise<ValidationReport> {
  const report: ValidationReport = { app: app.manifest.id, errors: [], warnings: [], pages: [], skipped: [] };
  const routes = Object.keys(app.pages);
  report.skipped = routes.filter(route => route.includes(':'));
  for (const locale of ['en', 'zh-CN']) {
    const local = new LocalApp(app, { ...options, locale });
    for (const route of routes.filter(route => !route.includes(':'))) {
      try {
        const page = await local.page(route);
        report.pages.push({ route, locale, ...(page.title ? { title: page.title } : {}), bytes: Buffer.byteLength(page.markdown), elapsedMs: page.elapsedMs });
        report.warnings.push(...page.issues.map(issue => `page ${route} (${locale}): ${issue}`));
      } catch (error) {
        report.errors.push(`page ${route} (${locale}): ${(error as Error).message}`);
      }
    }
  }
  const zh = app.manifest.locales?.['zh-CN'];
  if (!zh?.name) report.warnings.push('manifest.locales["zh-CN"].name is missing; Chinese devices show the English name.');
  for (const tool of app.manifest.agent.tools) {
    if (!tool.title) report.warnings.push(`tool ${tool.name}: add a title so the device can show what the assistant is doing.`);
    else if (!zh?.tools?.[tool.name]) report.warnings.push(`tool ${tool.name}: add manifest.locales["zh-CN"].tools.${tool.name} for Chinese devices.`);
  }
  return report;
}
