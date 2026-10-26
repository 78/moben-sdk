// Generated from api/src/app-sdk/page-check.ts. Do not edit here.
import { ActionSheetRegistry } from './action-sheet';
import { serializeMetadata } from './index';
import type { AppManifest, PageMetadata, UiEffect } from './types';

// Page checks read only the manifest and route tables, so official and remote
// app definitions both fit.
type RoutedApp = { manifest: AppManifest; pages: Record<string, unknown>; actions?: Record<string, unknown>; progress?: Record<string, unknown>; voice?: Record<string, unknown> };

// The cloud and the SDK run these same checks, so `moben app page` reports exactly
// what a device would receive.

/** A page or URL rejected by the Markdown app gateway. */
export class AppPageError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AppPageError';
  }
}

const ORIGIN = 'https://apps.invalid';
export type UrlOptions = { mountPath: string; pageUrl?: string; allowLauncher?: boolean; allowFragment?: boolean; allowAction?: boolean; allowActionSheet?: boolean };
export function normalizeAppUrl(value: string, options: UrlOptions): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x20\\]/.test(value)) throw new AppPageError(400, 'APP_URL_INVALID', "Invalid app URL.");
  const action = value.startsWith('action:');
  if (action && !options.allowAction) throw new AppPageError(400, 'APP_URL_ACTION', "Actions are not allowed here.");
  const target = action ? value.slice(7) : value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) throw new AppPageError(400, 'APP_URL_EXTERNAL', "Apps cannot open external URLs.");
  let url: URL;
  try {
    const rawPath = target.split(/[?#]/, 1)[0];
    if (/%(?:2f|5c|00|25)/i.test(rawPath) || rawPath.split('/').some(segment => segment.includes('%') && ['.', '..'].includes(decodeURIComponent(segment)))) throw new Error();
    url = new URL(target, `${ORIGIN}${options.pageUrl ?? `${options.mountPath}/`}`);
    url.pathname = url.pathname.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
  } catch { throw new AppPageError(400, 'APP_URL_INVALID', "Invalid app URL."); }
  if (url.origin !== ORIGIN || !(url.pathname === options.mountPath || url.pathname.startsWith(`${options.mountPath}/`) || options.allowLauncher && url.pathname === '/apps/')) throw new AppPageError(403, 'APP_URL_BOUNDARY', "The URL does not belong to this app.");
  if (url.hash) {
    if (!options.allowFragment || action) throw new AppPageError(400, 'APP_URL_FRAGMENT', "The URL cannot contain page navigation parameters.");
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.has('action-sheet')) {
      if (!options.allowActionSheet || action || Array.from(fragment.keys()).length !== 1 || !/^[a-z0-9_-]{1,64}$/.test(fragment.get('action-sheet') ?? '')) throw new AppPageError(400, 'APP_URL_FRAGMENT', "Invalid action menu link.");
    } else {
      const keys = Array.from(fragment.keys());
      if (keys.length !== new Set(keys).size || keys.some(key => !['line', 'offset', 'page', 'history'].includes(key))) throw new AppPageError(400, 'APP_URL_FRAGMENT', "Invalid page navigation parameters.");
      for (const key of ['line', 'offset']) if (fragment.has(key) && (!/^\d{1,9}$/.test(fragment.get(key)!) || key === 'line' && Number(fragment.get(key)) < 1)) throw new AppPageError(400, 'APP_URL_POSITION', "Invalid reading position.");
      if (fragment.has('page') && (!/^[0-9]{1,9}$/.test(fragment.get('page')!) || Number(fragment.get('page')) < 1 || fragment.has('line') || fragment.has('offset'))) throw new AppPageError(400, 'APP_URL_POSITION', "Invalid page number.");
      if (fragment.has('history') && fragment.get('history') !== 'replace') throw new AppPageError(400, 'APP_URL_FRAGMENT', "Invalid page navigation parameters.");
    }
    url.hash = fragment.toString();
  }
  return `${action ? 'action:' : ''}${url.pathname}${url.search}${url.hash}`;
}
export function matchRoute<T>(routes: Record<string, T>, path: string): { handler: T; params: Record<string, string> } | null {
  const target = path.replace(/\/$/, '') || '/';
  for (const [route, handler] of Object.entries(routes)) {
    const names: string[] = [];
    const regex = (route.replace(/\/$/, '') || '/').split('/').map(segment => segment.startsWith(':') ? (names.push(segment.slice(1)), '([^/]+)') : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    const found = target.match(new RegExp(`^${regex}$`));
    if (found) return { handler, params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])])) };
  }
  return null;
}

export type SanitizeOptions = {
  manifest?: AppManifest; canonicalBody?: boolean; onIssue?: (message: string) => void;
  // Interaction chosen by an action result, applied over the page's own.
  interaction?: { startMode?: 'read' | 'select'; initialFocus?: string };
};

const MAX_PAGE_BYTES = 512 * 1024;
// `<!-- moben:page ` + 4 KiB of JSON + ` -->`.
const MAX_METADATA_LINE_BYTES = 4096 + 32;

// Pages are documents: stream-editing controls (CR, BS, ESC) would rewrite
// device text. Form feed remains the only control and forces a new screen.
const stripControls = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000D-\u001F\u007F]/g, '');
const pageSizeError = () => new AppPageError(413, 'APP_PAGE_SIZE', "The page is too large. Split it into smaller pages.");

// Checks the metadata line, then cleans the body one line at a time. Whole
// pages and streamed pages share it, so both produce the same text.
class PageSanitizer {
  readonly metadata: PageMetadata;
  private readonly report: (message: string) => void;
  private readonly mountPath: string;
  private readonly urlOptions: UrlOptions;
  private readonly sheets: ActionSheetRegistry;
  private readonly retained = new Set<string>();
  private readonly focus?: string;
  private fence: { char: string; length: number } | null = null;
  private comment = false;

  constructor(first: string, private readonly app: RoutedApp | null, requestUrl: string, private readonly options: SanitizeOptions) {
    const report = this.report = options.onIssue ?? (() => {});
    const found = first.match(/^<!-- moben:page (.+) -->$/);
    if (!found || Buffer.byteLength(found[1]) > 4096) throw new AppPageError(400, 'APP_METADATA', "The page is missing valid metadata.");
    let raw: any;
    try { raw = JSON.parse(found[1]); } catch { throw new AppPageError(400, 'APP_METADATA', "Invalid page metadata format."); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppPageError(400, 'APP_METADATA', "Page metadata must be an object.");
    const appId = app?.manifest.id ?? 'moben.launcher';
    const mountPath = this.mountPath = app ? `/apps/${appId}` : '/apps';
    if (raw.version !== 1 || raw.app?.id !== appId) throw new AppPageError(400, 'APP_PROTOCOL_VERSION', "The page protocol or app identity does not match.");
    const pageUrl = normalizeAppUrl(raw.page?.url ?? requestUrl, { mountPath });
    if (!app && pageUrl !== '/apps/') throw new AppPageError(400, 'APP_METADATA', "Invalid app launcher URL.");
    if (app && !matchRoute(app.pages, new URL(pageUrl, 'https://apps.invalid').pathname.slice(mountPath.length) || '/')) throw new AppPageError(400, 'APP_METADATA', "The canonical page URL is not registered.");
    const title = raw.page?.title;
    if (title !== undefined && (typeof title !== 'string' || title.length > 200) || raw.page?.revision !== undefined && (typeof raw.page.revision !== 'string' || raw.page.revision.length > 128)) throw new AppPageError(400, 'APP_METADATA', "Invalid page title or revision.");
    const manifest = options.manifest ?? app?.manifest;
    const meta: PageMetadata = this.metadata = { version: 1, app: { id: appId, name: manifest?.shortName ?? manifest?.name ?? '应用' }, page: { url: pageUrl, ...(title !== undefined ? { title } : {}), ...(raw.page?.revision ? { revision: raw.page.revision } : {}) } };
    // Only the registered manifest supplies display text. Raw agent fields and
    // private model instructions never enter device page metadata.
    const welcome = manifest?.agent.welcome;
    if (welcome !== undefined) {
      if (typeof welcome !== 'string' || Array.from(welcome).length > 200 || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(welcome) || /[\uD800-\uDFFF]/u.test(welcome)) throw new AppPageError(400, 'APP_METADATA', "Invalid app assistant welcome message.");
      meta.agent = { welcome };
    }
    this.urlOptions = { mountPath, pageUrl, allowFragment: true, allowAction: true, allowActionSheet: true, allowLauncher: true };
    this.sheets = new ActionSheetRegistry(mountPath, target => {
      const url = normalizeAppUrl(target, { mountPath, allowAction: true });
      const path = new URL(url.slice(7), 'https://apps.invalid').pathname.slice(mountPath.length) || '/';
      if (!app || !matchRoute(app.actions ?? {}, path)) throw new Error('Unregistered Action Sheet action');
    });
    const interaction = options.interaction ? { ...(raw.interaction ?? {}), ...options.interaction } : raw.interaction;
    if (interaction) {
      const mode = interaction.startMode;
      if (mode !== undefined && mode !== 'read' && mode !== 'select') throw new AppPageError(400, 'APP_METADATA', "Unknown page interaction mode.");
      meta.interaction = { ...(mode ? { startMode: mode } : {}) };
      if (interaction.autoPage !== undefined && typeof interaction.autoPage !== 'boolean') report('interaction.autoPage must be true or false and is ignored.');
      else if (interaction.autoPage) meta.interaction.autoPage = true;
      if (interaction.initialFocus) {
        this.focus = app ? normalizeAppUrl(interaction.initialFocus, this.urlOptions) : normalizeAppUrl(interaction.initialFocus, { mountPath: '/apps', pageUrl, allowFragment: true });
      }
    }
    if (app && raw.navigation) {
      meta.navigation = {};
      for (const name of ['previousPage', 'nextPage', 'parentPage'] as const) if (raw.navigation[name]) {
        const url = normalizeAppUrl(raw.navigation[name], { mountPath, pageUrl, allowFragment: name !== 'parentPage' });
        const path = new URL(url, 'https://apps.invalid').pathname.slice(mountPath.length) || '/';
        if (!matchRoute(app.pages, path)) throw new AppPageError(400, 'APP_NAVIGATION', "The navigation destination is not registered.");
        if (name === 'parentPage' && new URL(url, 'https://apps.invalid').pathname === new URL(pageUrl, 'https://apps.invalid').pathname) throw new AppPageError(400, 'APP_NAVIGATION', 'A page cannot be its own parent.');
        meta.navigation[name] = url;
      }
    }
    if (raw.refresh !== undefined) {
      const policy = raw.refresh;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => key !== 'intervalSeconds') ||
          !Number.isSafeInteger(policy.intervalSeconds) || policy.intervalSeconds < 30 || policy.intervalSeconds > 86400)
        throw new AppPageError(400, 'APP_METADATA', 'Page refresh interval must be an integer between 30 and 86400 seconds.');
      meta.refresh = { intervalSeconds: policy.intervalSeconds };
    }
    if (raw.voice !== undefined) this.checkVoice(raw.voice, app, mountPath, pageUrl);
    if (app && raw.readingProgress) {
      const url = normalizeAppUrl(raw.readingProgress.reportUrl, { mountPath, pageUrl });
      const path = new URL(url, 'https://apps.invalid').pathname.slice(mountPath.length) || '/';
      if (!matchRoute(app.progress ?? {}, path)) throw new AppPageError(400, 'APP_PROGRESS', "The progress endpoint is not registered.");
      meta.readingProgress = { reportUrl: url };
    }
  }

  // Invalid voice metadata fails the page so developers notice; a device
  // below protocol 2 simply keeps its assistant.
  private checkVoice(voice: any, app: RoutedApp | null, mountPath: string, pageUrl: string) {
    const invalid = (message: string) => new AppPageError(400, 'APP_VOICE', message);
    if (!voice || typeof voice !== 'object' || Array.isArray(voice)) throw invalid('Page voice settings must be an object.');
    if (!['assistant', 'off', 'capture'].includes(voice.mode)) throw invalid('voice.mode must be "assistant", "off" or "capture".');
    if (voice.lock !== undefined && typeof voice.lock !== 'boolean') throw invalid('voice.lock must be true or false.');
    if (voice.hint !== undefined && (typeof voice.hint !== 'string' || Array.from(voice.hint).length > 40 || /[\u0000-\u001F\u007F]/.test(voice.hint))) throw invalid('voice.hint must be at most 40 characters on one line.');
    if (voice.maxSeconds !== undefined && (!Number.isSafeInteger(voice.maxSeconds) || voice.maxSeconds < 1 || voice.maxSeconds > 86400)) throw invalid('voice.maxSeconds must be an integer between 1 and 86400.');
    let url: string | undefined;
    if (voice.mode === 'capture') {
      if (typeof voice.url !== 'string') throw invalid('voice.url is required for capture.');
      url = normalizeAppUrl(voice.url, { mountPath, pageUrl });
      if (!app || !matchRoute(app.voice ?? {}, new URL(url, 'https://apps.invalid').pathname.slice(mountPath.length) || '/')) throw invalid('voice.url is not a registered voice route.');
    }
    if (voice.mode === 'assistant') return;
    this.metadata.voice = {
      mode: voice.mode, ...(url ? { url } : {}),
      ...(voice.lock === false ? { lock: false } : {}),
      ...(voice.hint ? { hint: voice.hint } : {}),
      ...(voice.maxSeconds ? { maxSeconds: voice.maxSeconds } : {})
    };
  }

  // A whole page keeps initialFocus only when it names one of its links. A
  // streamed page sends metadata first, so the device checks the focus itself.
  applyFocus(checked: boolean) {
    if (!this.focus) return;
    if (!checked || this.retained.has(this.focus)) this.metadata.interaction!.initialFocus = this.focus;
    else this.report(`interaction.initialFocus ${this.focus} does not match a link on the page and is ignored.`);
  }

  line(rawLine: string): string {
    const { app, mountPath, options, report, sheets } = this;
    const pageUrl = this.metadata.page.url;
    const boundary = rawLine.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!this.fence) this.fence = { char: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === this.fence.char && boundary[1].length >= this.fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(rawLine)) this.fence = null;
      return rawLine;
    }
    if (this.fence) return rawLine;
    const sheet = !this.comment && rawLine.match(/^<!-- moben:action-sheet (.+) -->$/);
    if (sheet) {
      try { return sheets.register(sheet[1]); }
      catch { throw new AppPageError(400, 'APP_ACTION_SHEET', "Invalid or oversized action menu."); }
    }
    let line = ''; let codeTicks = 0;
    for (let at = 0; at < rawLine.length;) {
      if (this.comment) {
        const close = rawLine.indexOf('-->', at);
        if (close < 0) break;
        at = close + 3; this.comment = false; continue;
      }
      if (!codeTicks && rawLine[at] === '\\' && at + 1 < rawLine.length) { line += rawLine.slice(at, at + 2); at += 2; continue; }
      if (rawLine[at] === '`') {
        let end = at + 1; while (rawLine[end] === '`') end++;
        const count = end - at;
        if (!codeTicks) codeTicks = count; else if (codeTicks === count) codeTicks = 0;
        line += rawLine.slice(at, end); at = end; continue;
      }
      if (!codeTicks && rawLine.startsWith('<!--', at)) { this.comment = true; at += 4; continue; }
      line += rawLine[at++];
    }
    // Consume the whole link (including its quoted title) before looking for
    // inline code, so backticks in confirmation text cannot split the link.
    // Escapes are consumed as pairs: md.text() output such as \[url\](url)
    // is text on the device and must stay intact.
    line = line.replace(/(`+[^`]*`+)|(\\.)|(?<!!)\[((?:\\.|[^\]\\\n])*)\]\(([^\s\n]+)(?: +("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?\)/g, (_link, code: string | undefined, escaped: string | undefined, text: string, target: string, title: string | undefined) => {
      if (code) return code;
      if (escaped) return escaped;
      try {
        if (target.includes('#action-sheet=')) {
          const id = target.slice(target.indexOf('#action-sheet=') + '#action-sheet='.length);
          if (!sheets.has(id) || !(target.startsWith('#action-sheet=') || options.canonicalBody && target === `${pageUrl}#action-sheet=${id}`)) {
            report(`Link ${target} does not open an action menu declared on this page; it is shown as plain text.`);
            return text;
          }
        }
        const url = app ? normalizeAppUrl(target, this.urlOptions) : normalizeAppUrl(target, { mountPath: '/apps', pageUrl, allowFragment: true });
        const path = new URL(url.replace(/^action:/, ''), 'https://apps.invalid').pathname;
        if (app && url.startsWith('action:') && !matchRoute(app.actions ?? {}, path.slice(mountPath.length) || '/')) {
          report(`Link ${target} does not match a registered action; it is shown as plain text.`);
          return text;
        }
        this.retained.add(url);
        return `[${text}](${url}${title ? ` ${title}` : ''})`;
      } catch (error) {
        report(`Link ${target} is shown as plain text: ${(error as Error).message}`);
        return text;
      }
    });
    return line.replace(/(\\.)|!\[([^\]]*)\]\((?!data:image\/png;base64,)([^)]*)\)/g, (_image, escaped: string | undefined, alt: string, source: string) => {
      if (escaped) return escaped;
      report(`Image ${source.slice(0, 80)} was removed: only inline data:image/png;base64 images are allowed.`);
      return alt;
    });
  }
}

export function sanitizeAppMarkdown(source: string, app: RoutedApp | null, requestUrl: string, options: SanitizeOptions = {}): { markdown: string; metadata: PageMetadata } {
  source = stripControls(source);
  const newline = source.indexOf('\n');
  const page = new PageSanitizer(newline < 0 ? source : source.slice(0, newline), app, requestUrl, options);
  const cleaned = (newline < 0 ? '' : source.slice(newline + 1)).split('\n').map(line => page.line(line));
  page.applyFocus(true);
  const markdown = `${serializeMetadata(page.metadata)}\n${cleaned.join('\n')}`;
  if (Buffer.byteLength(markdown) > MAX_PAGE_BYTES) throw pageSizeError();
  return { markdown, metadata: page.metadata };
}

/**
 * Sanitizes a page that arrives in chunks. Each push returns the text that
 * became final: the metadata line first, then every completed line. The
 * concatenated output equals sanitizeAppMarkdown on the whole page, except
 * that initialFocus is kept without checking it against the page's links.
 */
export class PageStreamSanitizer {
  private page: PageSanitizer | null = null;
  private pending = '';
  private bytes = 0;

  constructor(private readonly app: RoutedApp | null, private readonly requestUrl: string, private readonly options: SanitizeOptions & { maxBytes?: number } = {}) {}

  /** Metadata of the page, once its first line has arrived. */
  get metadata(): PageMetadata | null { return this.page?.metadata ?? null; }

  push(chunk: string): string {
    this.pending += stripControls(chunk);
    let output = '';
    for (let newline = this.pending.indexOf('\n'); newline >= 0; newline = this.pending.indexOf('\n')) {
      output += `${this.take(this.pending.slice(0, newline))}\n`;
      this.pending = this.pending.slice(newline + 1);
    }
    if (!this.page && Buffer.byteLength(this.pending) > MAX_METADATA_LINE_BYTES) throw new AppPageError(400, 'APP_METADATA', "The page is missing valid metadata.");
    return this.count(output, Buffer.byteLength(this.pending));
  }

  end(): string {
    const output = !this.page ? `${this.take(this.pending)}\n` : this.pending ? this.take(this.pending) : '';
    this.pending = '';
    return this.count(output, 0);
  }

  private take(line: string): string {
    if (this.page) return this.page.line(line);
    this.page = new PageSanitizer(line, this.app, this.requestUrl, this.options);
    this.page.applyFocus(false);
    return serializeMetadata(this.page.metadata);
  }

  private count(output: string, buffered: number): string {
    this.bytes += Buffer.byteLength(output);
    if (this.bytes + buffered > (this.options.maxBytes ?? MAX_PAGE_BYTES)) throw pageSizeError();
    return output;
  }
}

export function sanitizeUiEffects(effects: unknown, mountPath: string, pageUrl: string | undefined, app?: RoutedApp, onIssue?: (message: string) => void): UiEffect[] {
  if (!Array.isArray(effects)) return [];
  const options = { mountPath, pageUrl };
  const result: UiEffect[] = [];
  for (const effect of effects.slice(0, 10)) {
    try {
      if (!effect || typeof effect !== 'object') throw new Error('An effect must be an object.');
      const focusLink = effect.focusLink === undefined ? undefined : normalizeAppUrl(effect.focusLink, { ...options, allowFragment: true, allowAction: true, allowActionSheet: true });
      if (effect.type === 'reload') result.push({ type: 'reload', ...(focusLink ? { focusLink } : {}) });
      else if (effect.type === 'open') {
        const url = normalizeAppUrl(effect.url, { ...options, allowFragment: true });
        if (effect.history !== undefined && !['push', 'replace'].includes(effect.history)) throw new Error('history must be "push" or "replace".');
        if (app && !matchRoute(app.pages, new URL(url, 'https://apps.invalid').pathname.slice(options.mountPath.length) || '/')) throw new Error('The URL is not a registered page.');
        result.push({ type: 'open', url, history: effect.history ?? 'push', ...(focusLink ? { focusLink } : {}) });
      } else throw new Error('type must be "open" or "reload".');
    } catch (error) {
      // An invalid application effect cannot navigate the device.
      onIssue?.(`uiEffect ${JSON.stringify(effect)?.slice(0, 120)} was dropped: ${(error as Error).message}`);
    }
  }
  if (effects.length > 10) onIssue?.('Only the first 10 uiEffects are used.');
  return result;
}
