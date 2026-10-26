import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';

export class DeviceError extends Error {
  constructor(public readonly code: string, message: string, public readonly deviceCode?: string) {
    super(message);
    this.name = 'DeviceError';
  }
}

/** Internal adapter; hardware is loaded only by the USB commands. */
export interface DeviceTransport {
  on(event: 'data' | 'error' | 'close', listener: (...args: any[]) => void): unknown;
  off(event: 'data' | 'error' | 'close', listener: (...args: any[]) => void): unknown;
  write(data: Buffer, callback: (error?: Error | null) => void): unknown;
  close(callback: (error?: Error | null) => void): unknown;
}

const protocolError = (message: string) => new DeviceError('protocol_error', message);
const timeoutError = () => new DeviceError('timeout', 'USB response timed out. Check Advanced settings → Low power mode is OFF, the data cable, firmware support and device startup. A UI command may already have executed; it was not retried.');

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type CaptureFormat = 'panel' | 'l8';

export class DeviceFrame {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly pixels: Buffer,
    public readonly source: 'PANEL' | 'L8',
    public readonly frameId: number,
    public readonly completedFrameId: number,
    public readonly refreshing: boolean,
    public readonly grayscale: boolean
  ) {}

  /** Encode the validated framebuffer as an 8-bit grayscale PNG on the host. */
  png(): Buffer {
    const chunk = (kind: string, data: Buffer) => {
      const bytes = Buffer.alloc(data.length + 12);
      bytes.writeUInt32BE(data.length);
      bytes.write(kind, 4, 4, 'ascii');
      data.copy(bytes, 8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
      return bytes;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    const rows = Buffer.alloc((this.width + 1) * this.height);
    for (let y = 0; y < this.height; y++) this.pixels.copy(rows, y * (this.width + 1) + 1, y * this.width, (y + 1) * this.width);
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  }
}

export interface DeviceTask {
  number: number;
  name: string;
  state: string;
  priority: number;
  core: number;
  /** Minimum unused stack since task creation, in bytes (not current free stack). */
  stackMinFreeBytes: number;
}

export interface DeviceLog { line: string; truncated: boolean }
export interface DeviceSnapshotLink { index: number; text: string; url: string; valid: boolean; screen: number | null; focused: boolean }
export interface DeviceBrowserSnapshot {
  appId: string; url: string; title: string; revision: string;
  navigationId: string; contentRevision: string; mode: 'read' | 'select';
  screen: { index: number; loadedCount: number; count: number | null };
  loading: boolean; launching: boolean; pendingUrl: string | null; complete: boolean; receiving: boolean; truncated: boolean; stale: boolean;
  focusedLinkIndex: number | null; focusedLink: string | null;
  markdown: string; text: string; visibleText: string; links: DeviceSnapshotLink[];
  openActionSheet: null | { id: string; title: string; focusedIndex: number; items: { text: string; url: string; focused: boolean }[] };
}
export interface DeviceSnapshot {
  version: 1; state: string; messageVisible: boolean; assistantVisible: boolean;
  frame: { frameId: number; completedFrameId: number; refreshing: boolean; grayscale: boolean };
  browser: DeviceBrowserSnapshot | null;
}
export type DeviceResult = string | DeviceTask[] | DeviceFrame | DeviceSnapshot;

function validateSnapshot(value: any): DeviceSnapshot {
  const object = (item: any) => item !== null && typeof item === 'object' && !Array.isArray(item);
  const number = (item: any) => Number.isSafeInteger(item) && item >= 0 && item <= 0xffffffff;
  const strings = (item: any, keys: string[]) => object(item) && keys.every(key => typeof item[key] === 'string');
  const bools = (item: any, keys: string[]) => object(item) && keys.every(key => typeof item[key] === 'boolean');
  if (!object(value) || value.version !== 1 || typeof value.state !== 'string' || !bools(value, ['messageVisible', 'assistantVisible']) ||
      !bools(value.frame, ['refreshing', 'grayscale']) || !number(value.frame.frameId) || !number(value.frame.completedFrameId)) throw protocolError('Malformed snapshot state/frame.');
  const browser = value.browser;
  if (browser !== null) {
    if (!strings(browser, ['appId', 'url', 'title', 'revision', 'navigationId', 'contentRevision', 'markdown', 'text', 'visibleText']) ||
        !/^\d+$/.test(browser.navigationId) || !/^\d+$/.test(browser.contentRevision) || !['read', 'select'].includes(browser.mode) ||
        !bools(browser, ['loading', 'launching', 'complete', 'receiving', 'truncated', 'stale']) ||
        !(browser.pendingUrl === null || typeof browser.pendingUrl === 'string') || !object(browser.screen) ||
        !number(browser.screen.index) || browser.screen.index < 1 || !number(browser.screen.loadedCount) ||
        !(browser.screen.count === null || number(browser.screen.count)) ||
        !(browser.focusedLink === null || typeof browser.focusedLink === 'string') ||
        !(browser.focusedLinkIndex === null || number(browser.focusedLinkIndex)) || !Array.isArray(browser.links)) throw protocolError('Malformed browser snapshot.');
    const indices = new Set<number>();
    for (const link of browser.links) {
      if (!strings(link, ['text', 'url']) || !number(link.index) || indices.has(link.index) || !bools(link, ['valid', 'focused']) ||
          !(link.screen === null || number(link.screen) && link.screen > 0)) throw protocolError('Malformed snapshot link.');
      indices.add(link.index);
    }
    if (browser.openActionSheet !== null) {
      const sheet = browser.openActionSheet;
      if (!strings(sheet, ['id', 'title']) || !number(sheet.focusedIndex) || !Array.isArray(sheet.items) || sheet.focusedIndex >= sheet.items.length ||
          sheet.items.some((item: any) => !strings(item, ['text', 'url']) || !bools(item, ['focused']))) throw protocolError('Malformed snapshot action sheet.');
    }
  }
  return value as DeviceSnapshot;
}

function uint(value: string | undefined, maximum = 0xffffffff): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw protocolError('Invalid unsigned integer in USB response.');
  return Number(value);
}

export function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  for (const item of text.split(' ').filter(Boolean)) {
    const match = /^([a-zA-Z_][a-zA-Z_0-9]*)=([^\s=]+)$/.exec(item);
    if (!match || Object.hasOwn(fields, match[1])) throw protocolError('Malformed or duplicate USB response field.');
    fields[match[1]] = match[2];
  }
  if (!Object.keys(fields).length) throw protocolError('Empty USB response.');
  return fields;
}

/** Bounded binary/line reader. A failed transfer closes the session to avoid desynchronization. */
export class DeviceProtocol {
  private buffer = Buffer.alloc(0);
  private failure?: DeviceError;
  private wake?: () => void;
  private cancelWrite?: (error: DeviceError) => void;
  private sequence = randomInt(1, 0xffffffff);
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private receiving = false;
  private logOverflow = false;
  private readonly logListeners = new Set<(log: DeviceLog) => void>();
  private closedResolve!: (error: DeviceError) => void;
  readonly whenClosed = new Promise<DeviceError>(resolve => { this.closedResolve = resolve; });
  private readonly onData = (data: Buffer) => {
    if (this.failure) return;
    if (!this.receiving) { this.idleLogs(data); return; }
    if (this.buffer.length + data.length > 2 * 1024 * 1024 + 4096) {
      this.fail(protocolError('USB receive buffer limit exceeded.'));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    this.wake?.();
  };
  private readonly onError = (error: Error) => this.fail(new DeviceError('disconnected', `USB transport failed: ${error.message}`));
  private readonly onClose = () => this.fail(new DeviceError('disconnected', 'USB device disconnected. Reconnect and check its low power setting.'));

  constructor(private readonly transport: DeviceTransport, private readonly timeoutMs: number, onLog?: (log: DeviceLog) => void) {
    if (onLog) this.logListeners.add(onLog);
    transport.on('data', this.onData);
    transport.on('error', this.onError);
    transport.on('close', this.onClose);
  }

  get closed(): boolean { return this.failure !== undefined; }

  onLog(listener: (log: DeviceLog) => void): () => void {
    this.logListeners.add(listener);
    return () => { this.logListeners.delete(listener); };
  }

  private emitLog(bytes: Buffer, truncated = false) {
    const line = bytes.toString('utf8').replace(/\r$/, '');
    if (!line || /^PSG1 \d+ /.test(line)) return;
    for (const listener of this.logListeners) {
      try { listener({ line, truncated }); } catch { /* A log consumer must not corrupt a USB transfer. */ }
    }
  }

  private idleLogs(data: Buffer) {
    let at = 0;
    while (at < data.length) {
      const end = data.indexOf(10, at);
      const part = data.subarray(at, end < 0 ? data.length : end);
      if (!this.logOverflow) {
        const room = 4096 - this.buffer.length;
        this.buffer = Buffer.concat([this.buffer, part.subarray(0, room)]);
        if (part.length > room) { this.emitLog(this.buffer, true); this.buffer = Buffer.alloc(0); this.logOverflow = true; }
      }
      if (end < 0) break;
      if (!this.logOverflow) this.emitLog(this.buffer);
      this.buffer = Buffer.alloc(0);
      this.logOverflow = false;
      at = end + 1;
    }
  }

  private fail(error: DeviceError) {
    if (this.failure) return;
    this.failure = error;
    this.closedResolve(error);
    this.buffer = Buffer.alloc(0);
    this.cancelWrite?.(error);
    this.wake?.();
    void this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.failure ??= new DeviceError('closed', 'USB connection is closed.');
    this.closedResolve(this.failure);
    this.cancelWrite?.(this.failure);
    this.wake?.();
    this.closing = new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.transport.off('data', this.onData);
        this.transport.off('close', this.onClose);
        // Keep the error handler attached: drivers may emit a late error from
        // an interrupted write even after their close callback has returned.
        resolve();
      };
      const timer = setTimeout(done, 1000);
      try { this.transport.close(() => done()); } catch { done(); }
    });
    return this.closing;
  }

  private async wait(deadline: number) {
    if (this.failure) throw this.failure;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeoutError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.wake = undefined; reject(timeoutError()); }, remaining);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
    if (this.failure) throw this.failure;
  }

  private async exact(size: number, deadline: number): Promise<Buffer> {
    const data = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      if (this.failure) throw this.failure;
      if (performance.now() >= deadline) throw timeoutError();
      if (!this.buffer.length) { await this.wait(deadline); continue; }
      const count = Math.min(this.buffer.length, size - offset);
      this.buffer.copy(data, offset, 0, count);
      this.buffer = this.buffer.subarray(count);
      offset += count;
    }
    return data;
  }

  private async line(deadline: number, synchronizePrefix?: string): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(10);
      // Reopening a port can resume the previous connection's binary output.
      // Only HELLO may discard that tail; active payloads stay length/CRC strict.
      if (synchronizePrefix && this.logOverflow) {
        this.buffer = end < 0 ? Buffer.alloc(0) : this.buffer.subarray(end + 1);
        if (end >= 0) { this.logOverflow = false; continue; }
        await this.wait(deadline);
        continue;
      }
      if (end > 4096 || (end < 0 && this.buffer.length > 4096)) {
        if (!synchronizePrefix || this.buffer.subarray(0, synchronizePrefix.length).toString('ascii') === synchronizePrefix) {
          throw protocolError('USB response line is too long or a binary transfer was interrupted.');
        }
        this.buffer = end < 0 ? Buffer.alloc(0) : this.buffer.subarray(end + 1);
        this.logOverflow = end < 0;
        continue;
      }
      if (end >= 0) {
        const bytes = await this.exact(end + 1, deadline);
        // Boot/log lines may contain UTF-8; matching protocol lines are checked separately.
        return bytes.subarray(0, -1).toString('utf8').replace(/\r$/, '');
      }
      await this.wait(deadline);
    }
  }

  transaction<T>(operation: (request: (command: string) => Promise<DeviceResult>) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => operation(command => this.exchange(command)));
    this.tail = run.catch(() => undefined);
    return run;
  }

  request(command: string): Promise<DeviceResult> { return this.transaction(request => request(command)); }

  private async exchange(command: string): Promise<DeviceResult> {
    if (this.failure) throw this.failure;
    this.sequence = this.sequence === 0xffffffff ? 1 : this.sequence + 1;
    const prefix = `PSG1 ${this.sequence} `;
    const wire = `${prefix}${command}\n`;
    if (!/^[\x20-\x7e]+\n$/.test(wire) || wire.length - 1 > 128) throw new DeviceError('invalid_argument', 'USB command must fit in 128 ASCII bytes.');
    const deadline = performance.now() + this.timeoutMs;
    this.receiving = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error | null) => {
          clearTimeout(timer);
          this.cancelWrite = undefined;
          if (error) reject(error instanceof DeviceError ? error : new DeviceError('disconnected', `USB write failed: ${error.message}`));
          else resolve();
        };
        const timer = setTimeout(() => finish(timeoutError()), Math.max(1, deadline - performance.now()));
        this.cancelWrite = finish;
        try {
          this.transport.write(Buffer.from(wire, 'ascii'), finish);
        } catch (error) { finish(error as Error); }
      });
      for (;;) {
        const line = await this.line(deadline, command === 'HELLO' ? prefix : undefined);
        if (this.logOverflow) { this.logOverflow = false; continue; }
        if (!line.startsWith(prefix)) { this.emitLog(Buffer.from(line)); continue; }
        if (!/^[\x20-\x7e]+$/.test(line)) throw protocolError('Non-ASCII protocol response.');
        const response = line.slice(prefix.length);
        if (/^ERROR [a-z_]+$/.test(response)) {
          const code = response.slice(6);
          throw new DeviceError('device_error', `Device rejected the command: ${code}. The command was not retried.`, code);
        }
        if (response.startsWith('OK ') && !command.startsWith('CAPTURE ') && command !== 'TASKS' && command !== 'SNAPSHOT') return response.slice(3);
        if (response.startsWith('SNAPSHOT ') && command === 'SNAPSHOT') return await this.snapshot(response.split(' '), prefix, deadline);
        if (response.startsWith('BEGIN ') && command.startsWith('CAPTURE ')) return await this.frame(response.split(' '), prefix, command.slice(8), deadline);
        if (response.startsWith('TASKS ') && command === 'TASKS') return await this.tasks(response.split(' '), prefix, deadline);
        throw protocolError('Unexpected USB response type.');
      }
    } catch (error) {
      const failure = error instanceof DeviceError ? error : protocolError(`USB protocol failed: ${(error as Error).message}`);
      if (failure.code !== 'device_error') this.fail(failure);
      throw failure;
    } finally {
      this.receiving = false;
      if (!this.failure) {
        const trailing = this.buffer;
        this.buffer = Buffer.alloc(0);
        this.idleLogs(trailing);
      }
    }
  }

  private async snapshot(fields: string[], prefix: string, deadline: number): Promise<DeviceSnapshot> {
    if (fields.length !== 3 || !/^[\da-fA-F]{8}$/.test(fields[2])) throw protocolError('Malformed snapshot header.');
    const size = uint(fields[1], 2 * 1024 * 1024);
    if (!size) throw protocolError('Empty snapshot payload.');
    const payload = await this.exact(size, deadline);
    let end = await this.line(deadline);
    if (!end) end = await this.line(deadline);
    if (end !== `${prefix}END` || crc32(payload) !== Number.parseInt(fields[2], 16)) throw protocolError('Snapshot length/end/CRC mismatch.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
    catch { throw protocolError('Invalid UTF-8/JSON snapshot.'); }
    return validateSnapshot(value);
  }

  private async frame(fields: string[], prefix: string, source: string, deadline: number): Promise<DeviceFrame> {
    if (fields.length !== 11 || fields[0] !== 'BEGIN') throw protocolError('Malformed frame header.');
    const width = uint(fields[1]), height = uint(fields[2]), size = uint(fields[4]);
    if (width !== 480 || height !== 800 || size < 1 || size > width * height || !['RAW8', 'RLE8'].includes(fields[3]) ||
        !/^[\da-fA-F]{8}$/.test(fields[5]) || fields[6] !== source || !['0', '1'].includes(fields[9]) || !['0', '1'].includes(fields[10])) throw protocolError('Invalid frame dimensions, encoding, source or flags.');
    const frameId = uint(fields[7]), completed = uint(fields[8]);
    const payload = await this.exact(size, deadline);
    let end = await this.line(deadline);
    if (!end) end = await this.line(deadline);
    if (end !== `${prefix}END`) throw protocolError('Missing frame end marker.');
    let pixels: Buffer;
    if (fields[3] === 'RAW8') pixels = Buffer.from(payload);
    else {
      if (size % 3) throw protocolError('Incomplete RLE triple.');
      pixels = Buffer.alloc(width * height);
      let at = 0;
      for (let offset = 0; offset < size; offset += 3) {
        const run = payload.readUInt16BE(offset);
        if (!run || at + run > pixels.length) throw protocolError('Invalid RLE run length.');
        pixels.fill(payload[offset + 2], at, at + run);
        at += run;
      }
      if (at !== pixels.length) throw protocolError('Incomplete RLE image.');
    }
    if (pixels.length !== width * height || crc32(pixels) !== Number.parseInt(fields[5], 16)) throw protocolError('Frame length/CRC mismatch; no image was saved.');
    return new DeviceFrame(width, height, pixels, source as 'PANEL' | 'L8', frameId, completed, fields[9] === '1', fields[10] === '1');
  }

  private async tasks(fields: string[], prefix: string, deadline: number): Promise<DeviceTask[]> {
    if (fields.length !== 3 || fields[2] !== 'bytes') throw protocolError('Invalid task snapshot header/units.');
    const count = uint(fields[1], 128);
    if (!count) throw protocolError('Empty task snapshot.');
    const tasks: DeviceTask[] = [], numbers = new Set<number>();
    for (;;) {
      const line = await this.line(deadline);
      if (!line.startsWith(prefix)) { this.emitLog(Buffer.from(line)); continue; }
      const row = line.slice(prefix.length).split(' ');
      if (row.length === 1 && row[0] === 'END') {
        if (tasks.length !== count) throw protocolError('Incomplete task snapshot.');
        return tasks;
      }
      if (row.length !== 7 || row[0] !== 'TASK' || tasks.length >= count) throw protocolError('Malformed task row.');
      const number = uint(row[1]), priority = uint(row[4], 255), free = uint(row[6]);
      if (numbers.has(number) || !/^(?:-|(?:[a-fA-F\d]{2}){1,64})$/.test(row[2]) ||
          !['running', 'ready', 'blocked', 'suspended', 'deleted', 'invalid'].includes(row[3]) || !['-2', '-1', '0', '1'].includes(row[5])) throw protocolError('Invalid task fields.');
      const name = row[2] === '-' ? Buffer.alloc(0) : Buffer.from(row[2], 'hex');
      if (name.some(byte => byte < 32 || byte === 127)) throw protocolError('Control character in task name.');
      numbers.add(number);
      tasks.push({ number, name: name.toString('utf8'), state: row[3], priority, core: Number(row[5]), stackMinFreeBytes: free });
    }
  }
}
