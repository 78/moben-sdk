// Generated from api/src/app-sdk/index.ts. Do not edit here.
export * from './types';
export * from './action-sheet';
export * from './i18n';
import { serializeActionSheet, validateActionSheet, type ActionSheet } from './action-sheet';
import type { AppContext, AppDefinition, PageMetadata } from './types';

// Highest page protocol level served. Metadata added later must be gated on
// ctx.client.protocol, because shipped firmware cannot learn new semantics.
// Level 2 uses one incremental page stream and supports voice capture (voice).
// Optional page activity is negotiated through the appPageActivity feature.
export const APP_PROTOCOL_LEVEL = 2;
// Manifest icons are single-colour SVGs on a 24-unit grid; the launcher
// rasterizes them to 32x32 PNGs.
const MAX_ICON_BYTES = 4096;

export function defineApp<T extends AppDefinition>(app: T): T {
  const manifest = app.manifest;
  if (manifest.manifestVersion !== 1 || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(manifest.id) || manifest.id === 'moben.launcher') {
    throw new Error('Invalid application manifest identity/version');
  }
  if (!manifest.name || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) || !app.pages[manifest.entry]) {
    throw new Error('Invalid application manifest name/version/entry');
  }
  if (manifest.shortName !== undefined && (typeof manifest.shortName !== 'string' || !manifest.shortName.trim() || Array.from(manifest.shortName).length > 64 || /[\u0000-\u001F\u007F]/.test(manifest.shortName) || /[\uD800-\uDFFF]/u.test(manifest.shortName))) throw new Error('Invalid application short name');
  if (manifest.icon !== undefined && (typeof manifest.icon !== 'string' || !/^<svg[\s>]/.test(manifest.icon) || !manifest.icon.trimEnd().endsWith('</svg>') || Buffer.byteLength(manifest.icon) > MAX_ICON_BYTES)) throw new Error('Invalid application icon');
  if (manifest.permissions.some(value => !['storage', 'location'].includes(value))) throw new Error('Unsupported application permission');
  const blockedTools = manifest.agent.blockedPlatformTools;
  if (blockedTools !== undefined && (!Array.isArray(blockedTools) || blockedTools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) || new Set(blockedTools).size !== blockedTools.length)) throw new Error('Invalid blocked platform tools');
  const welcome = manifest.agent.welcome;
  if (welcome !== undefined && (typeof welcome !== 'string' || Array.from(welcome).length > 200 || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(welcome) || /[\uD800-\uDFFF]/u.test(welcome))) throw new Error('Invalid application agent welcome');
  if (manifest.locales !== undefined) {
    if (!manifest.locales || typeof manifest.locales !== 'object' || Array.isArray(manifest.locales)) throw new Error('Invalid application locales');
    for (const [locale, texts] of Object.entries(manifest.locales)) {
      if (!['zh-CN', 'en'].includes(locale) || !texts || typeof texts !== 'object' || Array.isArray(texts)) throw new Error('Invalid application locale');
      for (const [key, value] of Object.entries(texts)) {
        if (key === 'tools') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid application tool titles');
          for (const [tool, title] of Object.entries(value)) {
            if (!(manifest.agent?.tools ?? []).some(item => item.name === tool) || typeof title !== 'string' || !title.trim() || Array.from(title).length > 40 || /[\u0000-\u001F\u007F]/.test(title) || /[\uD800-\uDFFF]/u.test(title)) throw new Error('Invalid application tool title');
          }
          continue;
        }
        const limit = key === 'shortName' ? 64 : key === 'name' ? 100 : 200;
        if (!['name', 'shortName', 'description', 'welcome'].includes(key) || typeof value !== 'string' || !value.trim() || Array.from(value).length > limit || (key === 'welcome' ? /[\u0000-\u0009\u000B-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(value) || /[\uD800-\uDFFF]/u.test(value)) throw new Error('Invalid application localized text');
      }
    }
  }
  const names = new Set<string>();
  for (const tool of manifest.agent.tools) {
    if (tool.showCall !== undefined && typeof tool.showCall !== 'boolean') throw new Error('Invalid application tool showCall: must be a boolean');
    if (!/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(tool.name) || names.has(tool.name) || !app.tools[tool.name] || tool.inputSchema.type !== 'object') {
      throw new Error('Invalid or duplicate application tool');
    }
    names.add(tool.name);
  }
  if (Object.keys(app.tools).some(name => !names.has(name))) throw new Error('Undeclared application tool handler');
  for (const routes of [app.pages, app.actions ?? {}, app.progress ?? {}]) {
    for (const route of Object.keys(routes)) {
      if (!/^\/(?:[A-Za-z0-9_.:-]+\/?)*$/.test(route) || route.includes('..')) throw new Error('Invalid application route');
    }
  }
  return app;
}

const escapeText = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/[\\`*_\[\]{}<>#!|~]/g, '\\$&');
const destination = (value: string) => value.replace(/[\s()\\<>]/g, char => encodeURIComponent(char));
export const md = {
  text: escapeText,
  bold: (value: unknown) => `**${escapeText(value)}**`,
  link: (text: unknown, url: string) => `[${escapeText(text)}](${destination(url)})`,
  actionSheet: (value: ActionSheet) => serializeActionSheet(validateActionSheet(value)),
  actionSheetLink: (text: unknown, instanceId: string) => {
    if (!/^[a-z0-9_-]{1,64}$/.test(instanceId)) throw new Error('Invalid Action Sheet identity');
    return `[${escapeText(text)}](#action-sheet=${instanceId})`;
  },
  action: (text: unknown, url: string, options: { confirm?: string } = {}) => {
    const parsed = new URL(url, 'https://apps.invalid');
    if (parsed.hash) throw new Error('Action URLs cannot contain fragments');
    const link = md.link(text, `action:${parsed.pathname}${parsed.search}`);
    if (!options.confirm) return link;
    // The device reads confirmation text from the standard Markdown link title.
    const title = escapeText(options.confirm.replace(/[\u0000-\u001F\u007F]/g, ' ')).replace(/"/g, '\\"');
    return `${link.slice(0, -1)} "${title}")`;
  }
};
// The official line-icon style: rounded 1.6-unit strokes on a 24-unit grid.
export const lineIcon = (shapes: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
export function serializeMetadata(meta: PageMetadata) {
  const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (Buffer.byteLength(json) > 4096) throw new Error('Page metadata exceeds 4KB');
  return `<!-- moben:page ${json} -->`;
}
export function page(ctx: Pick<AppContext, 'appId' | 'currentPage' | 'query' | 'url'> & Partial<Pick<AppContext, 'client'>>, metadata: Partial<Omit<PageMetadata, 'version' | 'app' | 'page'>> & { title?: string; revision?: string; url?: string } = {}) {
  const { title, revision, url, ...groups } = metadata;
  const meta: PageMetadata = { version: 1, app: { id: ctx.appId }, page: { url: url ?? ctx.currentPage?.url ?? ctx.url(`${ctx.query.size ? `/?${ctx.query}` : '/'}`), title, revision }, ...groups };
  const lines = [serializeMetadata(meta)];
  const builder = {
    heading(value: unknown, level = 1) { lines.push(`${'#'.repeat(Math.min(6, Math.max(1, level)))} ${escapeText(value)}`, ''); return builder; },
    paragraph(value: unknown) { lines.push(escapeText(value), ''); return builder; },
    list(values: string[]) { lines.push(...values.map(value => `- ${value}`), ''); return builder; },
    quote(value: unknown) { lines.push(`> ${escapeText(value)}`, ''); return builder; },
    rule() { lines.push('---', ''); return builder; },
    raw(value: string) { lines.push(value, ''); return builder; },
    toString() { return `${lines.join('\n')}\n`; }
  };
  return builder;
}
