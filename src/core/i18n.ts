// Generated from api/src/app-sdk/i18n.ts. Do not edit here.
import type { AppContext, AppManifest } from './types';

export type AppLocale = 'zh-CN' | 'en';
type LocaleInput = string | Pick<AppContext, 'locale'> | undefined;

/** UI negotiation only. Keep the original locale for conversation preferences. */
export function resolveAppLocale(input?: LocaleInput): AppLocale {
  const source = typeof input === 'object' ? input.locale : input;
  if (!source?.trim()) return 'zh-CN';
  const ranges = source.slice(0, 4096).split(',').map((item, index) => {
    const match = item.trim().match(/^([a-z]{1,8}(?:-[a-z0-9]{1,8})*|\*)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i);
    return { tag: match?.[1].toLowerCase(), quality: match ? Number(match[2] ?? 1) : 0, index };
  }).filter(range => range.quality > 0).sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranges) {
    if (tag === 'zh' || /^zh-(?:cn|sg|hans)(?:-|$)/.test(tag!)) return 'zh-CN';
    if (tag === 'en' || tag?.startsWith('en-')) return 'en';
  }
  return 'en';
}

/** English is required; a missing translated key falls back to English. */
export function createAppTranslator<K extends string>(messages: { en: Record<K, string>; 'zh-CN'?: Partial<Record<K, string>> }) {
  return (locale: LocaleInput, key: K, values: Record<string, string | number> = {}) => {
    const text = messages[resolveAppLocale(locale)]?.[key] ?? messages.en[key];
    // Values are inserted once, then escaped by the Markdown builder at the call site.
    return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
  };
}

/** Return a per-request copy; never mutate the shared registered manifest. */
export function localizeAppManifest(manifest: AppManifest, locale?: LocaleInput): AppManifest {
  const english = manifest.locales?.en;
  const selected = manifest.locales?.[resolveAppLocale(locale)];
  return { ...manifest,
    name: selected?.name ?? english?.name ?? manifest.name,
    shortName: selected?.shortName ?? english?.shortName ?? manifest.shortName,
    description: selected?.description ?? english?.description ?? manifest.description,
    agent: { ...manifest.agent, welcome: selected?.welcome ?? english?.welcome ?? manifest.agent.welcome,
      tools: manifest.agent.tools.map(tool => ({ ...tool, title: selected?.tools?.[tool.name] ?? english?.tools?.[tool.name] ?? tool.title })) }
  };
}
