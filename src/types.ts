import type {
  AppContext as PlatformAppContext,
  AppManifest as PlatformAppManifest,
  AppPageOutput,
  AppToolResult,
  JsonObject,
  PageResponse,
  PageActivity
} from './core';

/**
 * What a page, action or tool handler receives. Remote apps keep their own data
 * (files or a local database such as SQLite), so there is no platform storage;
 * use `openId` to keep each device's records apart.
 */
export type AppContext = Omit<PlatformAppContext, 'storage' | 'openId'> & {
  /** Stable pseudonymous ID of this device within your app. */
  openId: string;
  /** Temporary cloud-rendered activity for a streamed page; never part of its Markdown. */
  setActivity(state: PageActivity): void;
};

/** Remote apps may only ask for city-level location. */
export type AppManifest = Omit<PlatformAppManifest, 'permissions'> & { permissions: Array<'location'> };

export type AppDefinition = {
  manifest: AppManifest;
  pages: Record<string, (ctx: AppContext) => AppPageOutput | Promise<AppPageOutput>>;
  actions?: Record<string, (ctx: AppContext) => PageResponse | Promise<PageResponse>>;
  tools: Record<string, (ctx: AppContext, args: JsonObject) => AppToolResult | Promise<AppToolResult>>;
  progress?: Record<string, (ctx: AppContext, report: JsonObject) => { accepted: boolean } | Promise<{ accepted: boolean }>>;
  /** Routes a page can record into (page metadata `voice: { mode: 'capture', url }`). */
  voice?: Record<string, VoiceRoute>;
};

/** Audio exactly as the device records it. */
export type VoiceAudioFormat = { container: 'ogg'; codec: 'opus'; sampleRate: 16000; channels: 1 };

/** How a recording ended. complete is false after a device/API connection loss; received audio is still delivered. */
export type VoiceEnd = { complete: boolean; durationMs: number };

export type AudioRecording = {
  input: 'audio';
  format: VoiceAudioFormat;
  /** The Ogg stream in order while the user speaks. It ends with the recording and throws if the user cancels. Read it once. */
  chunks: AsyncIterable<Buffer>;
  /** Resolves when the recording ends; rejects when the user cancels. */
  done: Promise<VoiceEnd>;
};

export type TextRecording = {
  input: 'text';
  /**
   * Yields the final transcript once, then ends. Kept for existing handlers.
   * Throws if the user cancels. Read it once.
   */
  transcripts: AsyncIterable<string>;
  /** Resolves with the final transcript when the recording ends; rejects when the user cancels. */
  done: Promise<VoiceEnd & { transcript: string; language: string }>;
};

/**
 * Nothing (or { kind: 'accepted' }) when the page's stream shows the result,
 * or a page to open, like an action: ctx.renderCurrentPage() or ctx.renderPage(path).
 */
export type VoiceReply = PageResponse | { kind: 'accepted' } | void;

/** audio receives the recording itself; text receives the words the cloud recognizes. */
export type VoiceRoute =
  | { input: 'audio'; handler: (ctx: AppContext, recording: AudioRecording) => VoiceReply | Promise<VoiceReply> }
  | { input: 'text'; handler: (ctx: AppContext, recording: TextRecording) => VoiceReply | Promise<VoiceReply> };
