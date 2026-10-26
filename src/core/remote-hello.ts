// Generated from api/src/app-sdk/remote-hello.ts. Do not edit here.
import { defineApp } from './index';
import { matchRoute } from './page-check';
import type { AppDefinition, AppManifest, AppTool, JsonObject } from './types';

export const REMOTE_PROTOCOL_VERSION = 1;
// A voice route receives recordings: audio (Ogg/Opus as recorded) or text
// (the cloud recognizes speech and sends the words).
export type VoiceInput = 'audio' | 'text';
export type VoiceRoute = { route: string; input: VoiceInput };
export type RemoteRoutes = { pages?: string[]; actions?: string[]; progress?: string[]; voice?: VoiceRoute[] };
export type RemoteHello = { manifest: AppManifest; routes: Required<RemoteRoutes> };
export type HelloCheckOptions = {
  /** Account namespace; the public app ID is "<namespace>.<manifest.id>". */
  namespace: string;
  /** Cloud-only: stored tool names that platform tools already use. */
  isReservedTool?: (storedName: string) => boolean;
  /** Cloud-only: checks a tool inputSchema against the JSON Schema meta-schema. */
  isValidSchema?: (schema: JsonObject) => boolean;
};

// The ID an app declares is unique within its developer's account; the public
// app ID is "<developer namespace>.<local ID>".
export const LOCAL_APP_ID = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;

const MAX_TOOLS = 32;
const MAX_ROUTES = 200;
const MAX_SCHEMA_BYTES = 8192;
const MAX_MANIFEST_BYTES = 65536;
const ROUTE = /^\/(?:[A-Za-z0-9_.:-]+\/?)*$/;
// Icons are rasterized server-side; anything that can reference external
// resources, run script or expand entities is refused outright.
const UNSAFE_SVG = /<\s*(?:script|style|image|use|foreignObject|iframe|object|embed|a|feImage)\b|<!DOCTYPE|<!ENTITY|\bhref\s*=|url\s*\(|\bon[a-z]+\s*=|javascript:/i;

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && Array.from(value).length <= max);

// Developers name tools freely ("get_status"); the cloud stores and shows them as
// app_<name>. No platform tool may use this prefix, so names never collide.
export const REMOTE_TOOL_PREFIX = 'app_';
export const storedToolName = (name: string) => `${REMOTE_TOOL_PREFIX}${name}`;
export const appToolName = (stored: string) => stored.startsWith(REMOTE_TOOL_PREFIX) ? stored.slice(REMOTE_TOOL_PREFIX.length) : stored;

function checkRoutes(value: unknown, issues: string[]): Required<RemoteRoutes> {
  const routes = { pages: [] as string[], actions: [] as string[], progress: [] as string[], voice: [] as VoiceRoute[] };
  if (!isObject(value)) {
    issues.push('routes must be an object');
    return routes;
  }
  for (const kind of ['pages', 'actions', 'progress'] as const) {
    const list = value[kind] ?? [];
    if (!Array.isArray(list) || list.length > MAX_ROUTES) {
      issues.push(`routes.${kind} must be an array of at most ${MAX_ROUTES} routes`);
      continue;
    }
    for (const route of list) {
      if (typeof route !== 'string' || route.length > 200 || !ROUTE.test(route) || route.includes('..')) issues.push(`routes.${kind}: invalid route ${JSON.stringify(route).slice(0, 80)}`);
      else if (routes[kind].includes(route)) issues.push(`routes.${kind}: duplicate route ${route}`);
      else routes[kind].push(route);
    }
  }
  const voice = value.voice ?? [];
  if (!Array.isArray(voice) || voice.length > MAX_ROUTES) issues.push(`routes.voice must be an array of at most ${MAX_ROUTES} routes`);
  else for (const entry of voice) {
    const route = isObject(entry) ? entry.route : undefined;
    if (typeof route !== 'string' || route.length > 200 || !ROUTE.test(route) || route.includes('..')) issues.push(`routes.voice: invalid route ${JSON.stringify(route ?? entry).slice(0, 80)}`);
    else if (entry.input !== 'audio' && entry.input !== 'text') issues.push(`routes.voice: ${route} input must be "audio" or "text"`);
    else if (routes.voice.some(known => known.route === route)) issues.push(`routes.voice: duplicate route ${route}`);
    else routes.voice.push({ route, input: entry.input });
  }
  if (!routes.pages.length) issues.push('routes.pages must declare at least one page');
  return routes;
}

function checkTool(tool: unknown, index: number, issues: string[], options: HelloCheckOptions): AppTool | null {
  const label = `agent.tools[${index}]`;
  if (!isObject(tool)) {
    issues.push(`${label} must be an object`);
    return null;
  }
  const name = tool.name;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(name)) {
    issues.push(`${label}: name must be lowercase letters, digits or underscores, starting with a letter`);
    return null;
  }
  if (options.isReservedTool?.(storedToolName(name))) issues.push(`tool ${name}: name is reserved by the platform`);
  if (typeof tool.description !== 'string' || !tool.description.trim() || Array.from(tool.description).length > 1000) issues.push(`tool ${name}: description must be 1-1000 characters`);
  if (!optionalText(tool.title, 40)) issues.push(`tool ${name}: title must be at most 40 characters`);
  for (const flag of ['mutates', 'external', 'showCall'] as const) if (tool[flag] !== undefined && typeof tool[flag] !== 'boolean') issues.push(`tool ${name}: ${flag} must be a boolean`);
  const schema = tool.inputSchema;
  if (!isObject(schema) || schema.type !== 'object') issues.push(`tool ${name}: inputSchema must be a JSON Schema with type "object"`);
  else if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) issues.push(`tool ${name}: inputSchema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  else if (options.isValidSchema && !options.isValidSchema(schema)) issues.push(`tool ${name}: inputSchema is not a valid JSON Schema`);
  return {
    name: storedToolName(name), description: String(tool.description ?? ''), inputSchema: isObject(schema) ? schema : {},
    ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
    ...(typeof tool.showCall === 'boolean' ? { showCall: tool.showCall } : {}),
    ...(tool.mutates === true ? { mutates: true } : {}),
    ...(tool.external === true ? { external: true } : {})
  };
}

// Localized tool titles are keyed by the developer's tool names.
function storedLocales(value: unknown) {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([locale, texts]) => [locale,
    isObject(texts) && isObject(texts.tools) ? { ...texts, tools: Object.fromEntries(Object.entries(texts.tools).map(([name, title]) => [storedToolName(name), title])) } : texts]));
}

// Validates app.hello and returns a manifest that carries only known fields,
// so stored metadata cannot smuggle extra keys. The namespace comes from the
// developer key, so an app can only claim IDs in its own account.
export function validateHello(params: unknown, options: HelloCheckOptions): { hello?: RemoteHello; issues: string[] } {
  const issues: string[] = [];
  if (!isObject(params)) return { issues: ['params must be an object'] };
  if (params.protocol !== REMOTE_PROTOCOL_VERSION) issues.push(`protocol must be ${REMOTE_PROTOCOL_VERSION}`);
  const routes = checkRoutes(params.routes, issues);
  const source = params.manifest;
  if (!isObject(source)) return { issues: [...issues, 'manifest must be an object'] };
  if (Buffer.byteLength(JSON.stringify(source)) > MAX_MANIFEST_BYTES) return { issues: [...issues, `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`] };
  const localId = typeof source.id === 'string' && LOCAL_APP_ID.test(source.id) ? source.id : '';
  if (!localId) issues.push('manifest.id must be 2-31 lowercase letters, digits or hyphens, starting with a letter and not ending with a hyphen, such as "computer-status"');
  if (typeof source.name !== 'string' || !source.name.trim() || Array.from(source.name).length > 100) issues.push('manifest.name must be 1-100 characters');
  if (!optionalText(source.description, 200)) issues.push('manifest.description must be at most 200 characters');
  if (typeof source.entry !== 'string' || !matchRoute(Object.fromEntries(routes.pages.map(route => [route, route])), source.entry)) issues.push('manifest.entry must match a page route');
  const permissions = source.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some(value => value !== 'location')) issues.push('manifest.permissions may only contain "location"');
  if (typeof source.icon === 'string' && UNSAFE_SVG.test(source.icon)) issues.push('manifest.icon contains unsupported SVG content');

  const agent = source.agent;
  const tools: AppTool[] = [];
  if (!isObject(agent)) issues.push('manifest.agent must be an object');
  else {
    if (typeof agent.instructions !== 'string' || Array.from(agent.instructions).length > 4000) issues.push('agent.instructions must be at most 4000 characters');
    if (!optionalText(agent.externalInstructions, 2000)) issues.push('agent.externalInstructions must be at most 2000 characters');
    if (!Array.isArray(agent.tools) || agent.tools.length > MAX_TOOLS) issues.push(`agent.tools must be an array of at most ${MAX_TOOLS} tools`);
    else agent.tools.forEach((tool, index) => {
      const checked = checkTool(tool, index, issues, options);
      if (checked) tools.push(checked);
    });
  }
  if (issues.length) return { issues };

  const agentSource = agent as JsonObject;
  const manifest: AppManifest = {
    manifestVersion: source.manifestVersion as 1, id: `${options.namespace}.${localId}`, name: source.name as string,
    version: source.version as string, entry: source.entry as string, permissions: permissions as Array<'location'>,
    ...(source.shortName !== undefined ? { shortName: source.shortName as string } : {}),
    ...(source.description !== undefined ? { description: source.description as string } : {}),
    ...(source.icon !== undefined ? { icon: source.icon as string } : {}),
    ...(source.locales !== undefined ? { locales: storedLocales(source.locales) as AppManifest['locales'] } : {}),
    agent: {
      instructions: agentSource.instructions as string, tools,
      ...(agentSource.externalInstructions !== undefined ? { externalInstructions: agentSource.externalInstructions as string } : {}),
      ...(agentSource.welcome !== undefined ? { welcome: agentSource.welcome as string } : {}),
      ...(agentSource.blockedPlatformTools !== undefined ? { blockedPlatformTools: agentSource.blockedPlatformTools as string[] } : {})
    }
  };
  // Reuse the shared manifest checks (version, identity, locales, welcome, icon size).
  try {
    defineApp(remoteAppDefinition(manifest, { ...routes, pages: [...new Set([...routes.pages, manifest.entry])] }));
  } catch (error) {
    return { issues: [(error as Error).message] };
  }
  return { hello: { manifest, routes }, issues: [] };
}

const unused = () => { throw new Error('Remote app handlers run in the developer process'); };

// The gateway validates remote pages with the same code as built-in apps; only
// route tables matter, handlers are never invoked on the server.
export function remoteAppDefinition(manifest: AppManifest, routes: RemoteRoutes): AppDefinition {
  const table = (list: string[] = []) => Object.fromEntries(list.map(route => [route, unused]));
  return {
    manifest,
    pages: table(routes.pages),
    actions: table(routes.actions),
    progress: table(routes.progress),
    voice: table(routes.voice?.map(entry => entry.route)),
    tools: Object.fromEntries(manifest.agent.tools.map(tool => [tool.name, unused]))
  };
}
