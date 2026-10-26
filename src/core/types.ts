// Generated from api/src/app-sdk/types.ts. Do not edit here.
export type JsonObject = Record<string, unknown>;
// Advertised by firmware that supports temporary text in app pages.
export const PAGE_ACTIVITY_FEATURE = 'appPageActivity';

export const PAGE_ACTIVITY_STATES = ['waiting', 'thinking', 'executing', 'waitingApproval', 'waitingInput', 'idle'] as const;
export type PageActivity = typeof PAGE_ACTIVITY_STATES[number];
// external: callable from other conversations through apps_describe/apps_call.
// title: short user-facing name, localized through manifest locales.
// showCall: show the call hint and elapsed time in assistant replies; defaults to true.
export type AppTool = { name: string; title?: string; description: string; inputSchema: JsonObject; mutates?: boolean; external?: boolean; showCall?: boolean };
export type AppManifest = {
  manifestVersion: 1; id: string; name: string; shortName?: string; version: string; description?: string;
  // Single-colour SVG drawn on a 24-unit grid; the launcher shows it at 32 px.
  icon?: string;
  locales?: Partial<Record<'zh-CN' | 'en', { name?: string; shortName?: string; description?: string; welcome?: string; tools?: Record<string, string> }>>;
  entry: string; permissions: Array<'storage' | 'location'>;
  agent: { instructions: string; externalInstructions?: string; welcome?: string; tools: AppTool[]; blockedPlatformTools?: string[] };
};
export type AppPageSnapshot = {
  url: string; revision?: string; mode?: string; screen?: { index: number; count: number | null };
  position?: { line: number; offset: number }; visibleText?: string;
  links?: Array<{ text: string; url: string }>; focusedLink?: string | null;
  openActionSheet?: unknown; stale?: boolean;
};
export type UiEffect =
  | { type: 'open'; url: string; history?: 'push' | 'replace'; focusLink?: string }
  | { type: 'reload'; focusLink?: string };
export type AppToolResult = { result: unknown; uiEffects?: UiEffect[] };
export type StoredRecord = {
  collection: string; key: string; data: unknown; revision: number;
  sortKey?: string; tags?: string[]; createdAt: string; updatedAt: string;
};
export type StorageListOptions = {
  tag?: string; sortKeyFrom?: string; sortKeyTo?: string; order?: 'asc' | 'desc'; limit?: number; cursor?: string;
};
export interface ReadonlyStorageScope {
  get(collection: string, key: string): Promise<StoredRecord | null>;
  list(collection: string, options?: StorageListOptions): Promise<{ records: StoredRecord[]; nextCursor?: string }>;
  count(collection: string, options?: { tag?: string }): Promise<number>;
}
export interface StorageScope extends ReadonlyStorageScope {
  put(collection: string, key: string, data: unknown, options?: { expectedRevision?: number; sortKey?: string; tags?: string[] }): Promise<StoredRecord>;
  delete(collection: string, key: string, options?: { expectedRevision?: number }): Promise<void>;
}
export type PageMetadata = {
  version: 1; app: { id: string; name?: string }; page: { url: string; title?: string; revision?: string };
  agent?: { welcome: string };
  // Every page is incremental. autoPage follows new screens only while the
  // reader is already on the last screen; omission keeps manual paging.
  interaction?: { startMode?: 'read' | 'select'; initialFocus?: string; autoPage?: boolean };
  navigation?: { previousPage?: string; nextPage?: string; parentPage?: string };
  readingProgress?: { reportUrl: string };
  refresh?: { intervalSeconds: number };
  // What the voice key does on this page: the assistant (default), nothing,
  // or capture: record into url, a registered voice route. lock: whether the
  // recording may be locked hands-free (default true); hint: up to 40
  // characters shown while recording; maxSeconds: the device submits at that
  // length. Sent only to protocol 2 devices.
  voice?: { mode: 'assistant' | 'off' | 'capture'; url?: string; lock?: boolean; hint?: string; maxSeconds?: number };
};
// Action results are whole pages; nothing is prepended above their body.
export type PageResponse = { kind: 'page'; path: string; initialFocus?: string; startMode?: 'read' | 'select' };
export interface AppContext {
  appId: string; mountPath: string; requestId: string;
  // Remote apps only: stable pseudonymous ID of this device within this app.
  openId?: string;
  locale: string; timezone: string; location?: { city: string; province?: string; country?: string };
  client: { width: number; height: number; textPixelSize: number; features: string[]; protocol: number };
  page: AppPageSnapshot | null; currentPage?: { url: string; revision?: string };
  query: URLSearchParams; params: Record<string, string>; signal: AbortSignal;
  storage: { device: StorageScope; app: ReadonlyStorageScope };
  url(path: string, options?: { history?: 'push' | 'replace' }): string;
  renderCurrentPage(options?: Omit<PageResponse, 'kind' | 'path'>): PageResponse;
  renderPage(path: string, options?: Omit<PageResponse, 'kind' | 'path'>): PageResponse;
}
export type AppPageOutput = string | AsyncIterable<string>;
export type AppDefinition = {
  manifest: AppManifest;
  pages: Record<string, (ctx: AppContext) => AppPageOutput | Promise<AppPageOutput>>;
  actions?: Record<string, (ctx: AppContext) => PageResponse | Promise<PageResponse>>;
  tools: Record<string, (ctx: AppContext, args: JsonObject) => AppToolResult | Promise<AppToolResult>>;
  progress?: Record<string, (ctx: AppContext, report: JsonObject) => { accepted: boolean } | Promise<{ accepted: boolean }>>;
  // Remote apps only: voice routes that pages may name in `voice.url`.
  voice?: Record<string, unknown>;
};
