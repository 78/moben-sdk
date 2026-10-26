import WebSocket from 'ws';
import { defineApp, helloParams } from './define';
import type { AppDefinition } from './types';
import { connectUrlFor, readCredentials } from './credentials';
import { CAPTURE_APP, Dispatcher, toRpcError } from './dispatch';

const SDK_NAME = '@moben-ai/app-sdk';
export const SDK_VERSION: string = require('../package.json').version;
const DEFAULT_CONNECT_URL = 'wss://moben.cn/api/app-connect/ws';
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_BACKOFF_MS = 30000;
// The cloud pings every 30 seconds; silence for longer means a dead link.
const LIVENESS_TIMEOUT_MS = 75000;
const CLOSE_REASONS: Record<number, string> = {
  4001: 'The developer key was revoked or the app was deleted in Console.',
  4002: 'Another process connected as this app; this one stops.',
  4400: 'The cloud rejected this app. Update the SDK or fix the issues above and restart.'
};

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'stopped';
export type ConnectOptions = {
  /** Developer key. Defaults to MOBEN_DEVELOPER_KEY, then the key saved by `moben login`. */
  key?: string;
  /** Defaults to MOBEN_APP_CONNECT_URL, the server of `moben login`, or wss://moben.cn/api/app-connect/ws. */
  url?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
};
export type RemoteAppConnection = { readonly status: ConnectionStatus; close(): Promise<void> };

/**
 * Connects an app to Moben and keeps the connection alive. Pages, actions and
 * tools run in this process; devices reach them through the cloud.
 */
export function connect(app: AppDefinition, options: ConnectOptions = {}): RemoteAppConnection {
  defineApp(app);
  const capture = (globalThis as Record<symbol, unknown>)[CAPTURE_APP];
  if (typeof capture === 'function') {
    capture(app);
    return { status: 'stopped', close: async () => {} };
  }
  const saved = options.key || process.env.MOBEN_DEVELOPER_KEY ? null : readCredentials();
  let key = options.key || process.env.MOBEN_DEVELOPER_KEY || saved?.key;
  if (!key) throw new Error('A developer key is required: run npx moben login, set MOBEN_DEVELOPER_KEY, or pass { key }.');
  const url = options.url ?? process.env.MOBEN_APP_CONNECT_URL ?? (saved ? connectUrlFor(saved.apiUrl) : DEFAULT_CONNECT_URL);
  const logger = options.logger ?? console;
  const dispatcher = new Dispatcher(app);
  const hello = {
    jsonrpc: '2.0', id: 'hello', method: 'app.hello',
    params: { ...helloParams(app), sdk: { name: SDK_NAME, version: SDK_VERSION } }
  };

  let status: ConnectionStatus = 'connecting';
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let livenessTimer: NodeJS.Timeout | undefined;
  const inFlight = new Map<string | number, AbortController>();

  const setStatus = (next: ConnectionStatus, detail?: string) => {
    if (status === next && !detail) return;
    status = next;
    options.onStatus?.(next, detail);
  };
  const stop = (reason: string) => {
    stopped = true;
    clearTimeout(retryTimer);
    logger.error(`[moben] ${reason}`);
    setStatus('stopped', reason);
  };
  // Logging in again revokes this computer's previous key; switch to the new one.
  const useNewLogin = () => {
    const fresh = saved ? readCredentials() : null;
    if (!fresh || fresh.key === key) return false;
    key = fresh.key;
    logger.info('[moben] Using the key from the latest moben login.');
    return true;
  };
  const scheduleReconnect = () => {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt += 1;
    setStatus('offline');
    retryTimer = setTimeout(open, delay);
  };
  const keepAlive = (ws: WebSocket) => {
    clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => ws.terminate(), LIVENESS_TIMEOUT_MS);
  };

  const onMessage = (ws: WebSocket, raw: WebSocket.RawData) => {
    let message: any;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message?.id === 'hello') {
      if (message.error) {
        const issues: string[] = message.error.data?.issues ?? [];
        logger.error(`[moben] ${message.error.message}${issues.map(issue => `\n  - ${issue}`).join('')}`);
        return;
      }
      attempt = 0;
      logger.info(`[moben] ${app.manifest.id} is online`);
      setStatus('online');
      return;
    }
    if (typeof message?.method !== 'string') return;
    if (message.method === '$/cancel') {
      inFlight.get(message.params?.id)?.abort(new Error('Request canceled'));
      inFlight.delete(message.params?.id);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method.startsWith('voice.')) return dispatcher.notify(message.method, message.params);
      if (message.method === 'connection.replaced') logger.warn('[moben] Another process connected as this app.');
      return;
    }
    const id = message.id;
    const controller = new AbortController();
    inFlight.set(id, controller);
    const send = (payload: object) => {
      if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify({ jsonrpc: '2.0', id, ...payload });
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The response is too large.' } }));
      ws.send(text);
    };
    const notify = (method: string, params: object) => {
      if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    };
    dispatcher.handle(message.method, message.params ?? {}, controller.signal, { id, notify })
      .then(result => send({ result }))
      .catch(error => {
        // The cloud gave up on this request (the device left a streaming
        // page, a timeout or a disconnect); nothing is sent or logged.
        if (controller.signal.aborted) return;
        send({ error: toRpcError(error, message.params?.context?.locale, logger, message.method) });
      })
      .finally(() => inFlight.delete(id));
  };

  function open() {
    if (stopped) return;
    setStatus('connecting');
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, maxPayload: MAX_MESSAGE_BYTES });
    socket = ws;
    ws.on('unexpected-response', (request, response) => {
      if (response.statusCode === 401) {
        if (!useNewLogin()) stop('The developer key was rejected. Run npx moben login.');
      }
      else logger.warn(`[moben] Connection refused with HTTP ${response.statusCode}`);
      request.destroy();
    });
    ws.on('open', () => {
      keepAlive(ws);
      ws.send(JSON.stringify(hello));
    });
    ws.on('ping', () => keepAlive(ws));
    ws.on('message', raw => onMessage(ws, raw));
    ws.on('error', error => logger.warn(`[moben] ${error.message}`));
    ws.on('close', code => {
      clearTimeout(livenessTimer);
      for (const [id, controller] of inFlight) {
        if (!dispatcher.disconnect(id)) controller.abort(new Error('Connection closed'));
      }
      inFlight.clear();
      if (socket === ws) socket = null;
      if (stopped) return;
      if (code === 4001 && useNewLogin()) return scheduleReconnect();
      if (CLOSE_REASONS[code]) return stop(CLOSE_REASONS[code]);
      scheduleReconnect();
    });
  }

  open();
  return {
    get status() { return status; },
    async close() {
      stopped = true;
      clearTimeout(retryTimer);
      setStatus('stopped');
      const ws = socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>(resolve => {
        ws.once('close', () => resolve());
        ws.close(1000);
      });
    }
  };
}
