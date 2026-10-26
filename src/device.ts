import { setTimeout as sleep } from 'node:timers/promises';
import { DeviceError, DeviceFrame, DeviceProtocol, parseFields, type CaptureFormat, type DeviceTask, type DeviceTransport, type DeviceResult, type DeviceSnapshot, type DeviceLog } from './device-protocol';

export { DeviceError, DeviceFrame } from './device-protocol';
export type { CaptureFormat, DeviceTask, DeviceLog, DeviceSnapshot, DeviceBrowserSnapshot, DeviceSnapshotLink } from './device-protocol';

export interface DevicePort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  /** A discovery hint, never proof of Moben identity. */
  candidate: boolean;
}

export interface DeviceHello {
  identity: 'moben' | 'legacy';
  product?: string;
  model?: string;
  firmware?: string;
  fields: Record<string, string>;
}

export interface DeviceStatus {
  state?: string;
  lowPower: boolean | null;
  lightSleep: boolean | null;
  fields: Record<string, string>;
}

export interface ConnectDeviceOptions {
  /** Omit only when exactly one Espressif USB Serial/JTAG candidate is connected. */
  port?: string;
  /** Per-command deadline, including USB writes. Default 8000; range (0, 120000]. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Live ordinary log lines. Callback exceptions are isolated from USB requests. */
  onLog?: (log: DeviceLog) => void;
}

export type DeviceButton = 'voice' | 'prev' | 'next' | 'menu';
export type DeviceKeyEvent = 'click' | 'long' | 'down' | 'up';

export function validateDeviceTimeout(timeoutMs = 8000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new DeviceError('invalid_argument', 'USB timeout must be in (0, 120000] milliseconds.');
  return timeoutMs;
}

/** @internal Shared by the CLI so invalid input is rejected before opening hardware. */
export function validateDeviceUrl(url: string): void {
  const path = url.split('?', 1)[0];
  const id = path.slice(6).split('/', 1)[0];
  if (!url.startsWith('/apps/') || url.length > 107 || !/^[\x21-\x7e]+$/.test(url) || /[\\#]/.test(url) ||
      path.includes('%') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..') ||
      (path !== '/apps/' && (!/^[a-z][a-z0-9.-]{0,63}$/.test(id) || id === 'moben.launcher'))) {
    throw new DeviceError('invalid_argument', 'URL must be a canonical ASCII /apps/ page path, at most 107 bytes, without fragments, external URLs or action: links.');
  }
}

/** @internal */
export function validateDeviceKey(button: string, event: string): void {
  if (!['voice', 'prev', 'next', 'menu'].includes(button) || !['click', 'long', 'down', 'up'].includes(event) ||
      (button === 'menu' && (event === 'down' || event === 'up'))) {
    throw new DeviceError('invalid_argument', 'Use key <voice|prev|next|menu> --event <click|long|down|up>; menu has no down/up events.');
  }
}

/** @internal */
export function validateDeviceText(text: string): void {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 72 || /[\x00-\x1f\x7f]/.test(text)) throw new DeviceError('invalid_argument', 'Test text must be nonempty, one line, and at most 72 UTF-8 bytes.');
}

async function serialModule() {
  try { return await import('serialport'); }
  catch (error) {
    throw new DeviceError('serial_dependency_missing', `USB support could not load serialport. In your app, run npm install serialport@^13 (do not omit optional dependencies). Windows 7 is unsupported. ${(error as Error).message}`);
  }
}

/** @internal Pure discovery rules, shared with tests. */
export function normalizeDevicePorts(ports: Omit<DevicePort, 'candidate'>[], platform = process.platform): DevicePort[] {
  const result = new Map<string, DevicePort>();
  for (const port of ports) {
    const path = platform === 'darwin' ? port.path.replace(/^\/dev\/tty\.(usbmodem.*)$/, '/dev/cu.$1') : port.path;
    const vendorId = port.vendorId?.replace(/^0x/i, '').toLowerCase();
    const productId = port.productId?.replace(/^0x/i, '').toLowerCase();
    result.set(path, { ...port, path, candidate: vendorId === '303a' && productId === '1001' });
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Enumerate without opening or probing any port. */
export async function listDevices(): Promise<DevicePort[]> {
  const { SerialPort } = await serialModule();
  try { return normalizeDevicePorts(await SerialPort.list()); }
  catch (error) { throw new DeviceError('enumeration_failed', `Cannot enumerate serial ports: ${(error as Error).message}`); }
}

/** @internal */
export function selectDevicePort(ports: DevicePort[]): string {
  const candidates = ports.filter(port => port.candidate);
  if (!candidates.length) throw new DeviceError('no_device', 'No candidate USB serial port found. Check the data cable, USB port, device power, serial driver and Advanced settings → Low power mode is OFF. Use --port for a port without USB metadata.');
  if (candidates.length > 1) throw new DeviceError('multiple_devices', `Several candidate devices found; choose --port: ${candidates.map(port => port.path).join(', ')}. USB IDs alone do not confirm Moben identity.`);
  return candidates[0].path;
}

function fields(result: DeviceResult): Record<string, string> {
  if (typeof result !== 'string') throw new DeviceError('protocol_error', 'Expected a USB field response.');
  return parseFields(result);
}

/** USB connection. Create with connectDevice(), and always close in finally. */
export class DeviceClient {
  private info?: DeviceHello;
  private onAbort?: () => void;
  private textInProgress = false;

  /** @internal */
  constructor(private readonly protocol: DeviceProtocol, public readonly port: string, private readonly signal?: AbortSignal) {
    if (signal) {
      // Defer abort cleanup until the synthetic recording is canceled/released.
      this.onAbort = () => { if (!this.textInProgress) void this.close(); };
      signal.addEventListener('abort', this.onAbort, { once: true });
      if (signal.aborted) this.onAbort();
    }
  }

  async hello(): Promise<DeviceHello> {
    try {
      const values = fields(await this.protocol.request('HELLO'));
      if (values.version !== '1') throw new DeviceError('unsupported_protocol', `Unsupported USB protocol version ${values.version ?? '(missing)'}.`);
      if (values.product !== undefined && (values.product !== 'moben' || values.model !== 'pocket-sage')) {
        throw new DeviceError('identity_mismatch', `USB device identity does not match Moben Pocket Sage: ${values.product}/${values.model ?? '(missing)'}.`);
      }
      this.info = { identity: values.product === 'moben' ? 'moben' : 'legacy', product: values.product, model: values.model, firmware: values.firmware, fields: values };
      return this.info;
    } catch (error) { await this.close(); throw error; }
  }

  private async supports(field: string, value = '1'): Promise<void> {
    const info = this.info ?? await this.hello();
    if (!info.fields[field]?.split(',').includes(value)) throw new DeviceError('unsupported_capability', `Device firmware does not advertise ${field}=${value}. Update the firmware or use a supported operation.`);
  }

  async status(): Promise<DeviceStatus> {
    const values = fields(await this.protocol.request('STATUS'));
    const flag = (key: string) => values[key] === '0' ? false : values[key] === '1' ? true : null;
    return { state: values.state, lowPower: flag('low_power'), lightSleep: flag('light_sleep'), fields: values };
  }

  async tasks(): Promise<DeviceTask[]> {
    await this.supports('tasks');
    const result = await this.protocol.request('TASKS');
    if (!Array.isArray(result)) throw new DeviceError('protocol_error', 'Expected a task snapshot.');
    return result;
  }

  /** Acknowledges acceptance, not page download, rendering or physical refresh completion. */
  async open(url: string): Promise<Record<string, string>> {
    validateDeviceUrl(url);
    await this.supports('open');
    return fields(await this.protocol.request(`OPEN ${url}`));
  }

  /** Inject an application gesture, not a GPIO signal. Never automatically retried. */
  async key(button: DeviceButton, event: DeviceKeyEvent = 'click'): Promise<Record<string, string>> {
    validateDeviceKey(button, event);
    await this.supports('keys', button);
    await this.supports(event === 'down' || event === 'up' ? `${button}_edges` : 'events', event);
    return fields(await this.protocol.request(`KEY ${button} ${event}`));
  }

  async capture(options: { format?: CaptureFormat } = {}): Promise<DeviceFrame> {
    const format = options.format ?? 'panel';
    if (format !== 'panel' && format !== 'l8') throw new DeviceError('invalid_argument', 'Capture format must be panel or l8.');
    await this.supports('capture', format.toUpperCase());
    const frame = await this.protocol.request(`CAPTURE ${format.toUpperCase()}`);
    if (!(frame instanceof DeviceFrame)) throw new DeviceError('protocol_error', 'Expected a framebuffer.');
    return frame;
  }

  /** Export the loaded Browser document without navigating, rendering or selecting. */
  async snapshot(): Promise<DeviceSnapshot> {
    await this.supports('snapshot');
    const result = await this.protocol.request('SNAPSHOT');
    if (typeof result !== 'object' || Array.isArray(result) || result instanceof DeviceFrame) throw new DeviceError('protocol_error', 'Expected a structured snapshot.');
    return result;
  }

  /** Replace ASR for one ordinary device voice flow; server allowlist required. */
  async text(message: string): Promise<Record<string, string>> {
    validateDeviceText(message);
    if (!this.info) await this.hello();
    return this.protocol.transaction(async request => {
      await this.supports('text', 'base64');
      await this.supports('keys', 'voice');
      await this.supports('voice_edges', 'down');
      await this.supports('voice_edges', 'up');
      await this.supports('events', 'long');
      this.signal?.throwIfAborted();
      this.textInProgress = true;
      let downAttempted = false;
      let result: Record<string, string> | undefined;
      let failure: unknown;
      try {
        await request(`TEXT ${Buffer.from(message, 'utf8').toString('base64')}`);
        this.signal?.throwIfAborted();
        downAttempted = true;
        await request('KEY voice down');
        await sleep(600, undefined, { signal: this.signal });
        await request('KEY voice long');
        await sleep(300, undefined, { signal: this.signal });
      } catch (error) { failure = error; }
      finally {
        let release = true;
        if (failure && downAttempted && this.info?.fields.text_cancel === '1' && !this.protocol.closed) {
          try { await request('CANCELTEXT'); } catch { release = false; /* Do not submit by releasing an unconfirmed cancellation. */ }
        }
        if (downAttempted && release) {
          try { result = fields(await request('KEY voice up')); }
          catch (error) { failure ??= error; }
        }
        if (failure && this.info?.fields.text_clear === '1' && !this.protocol.closed) {
          try { await request('CLEARTEXT'); } catch { /* Preserve the original failure; never replay the voice flow. */ }
        }
        this.textInProgress = false;
        if (this.signal?.aborted) await this.close();
      }
      if (failure) throw failure;
      return result!;
    });
  }

  onLog(listener: (log: DeviceLog) => void): () => void { return this.protocol.onLog(listener); }
  whenClosed(): Promise<DeviceError> { return this.protocol.whenClosed; }

  async close(): Promise<void> {
    if (this.onAbort) this.signal?.removeEventListener('abort', this.onAbort);
    await this.protocol.close();
  }
}

/** @internal Connect an already-open adapter; also used for protocol tests. */
export async function connectDeviceTransport(transport: DeviceTransport, port: string, timeoutMs = 8000, signal?: AbortSignal, onLog?: (log: DeviceLog) => void): Promise<DeviceClient> {
  const client = new DeviceClient(new DeviceProtocol(transport, validateDeviceTimeout(timeoutMs), onLog), port, signal);
  try { await client.hello(); return client; }
  catch (error) { await client.close(); throw error; }
}

/** @internal Explicit pairs matter: SerialPort.set resets omitted flags to defaults. */
export async function releaseDeviceControlLines(set: (flags: { dtr: boolean; rts: boolean }) => Promise<void>): Promise<void> {
  await set({ dtr: true, rts: false });
  await set({ dtr: false, rts: false });
}

/** Open a local USB serial port and verify PSG1 identity/capabilities. No login is required. */
export async function connectDevice(options: ConnectDeviceOptions = {}): Promise<DeviceClient> {
  const timeoutMs = validateDeviceTimeout(options.timeoutMs);
  options.signal?.throwIfAborted();
  if (options.port !== undefined && (!options.port.trim() || /[\x00-\x1f\x7f]/.test(options.port))) throw new DeviceError('invalid_argument', 'Provide a valid serial port path.');
  const path = options.port ?? selectDevicePort(await listDevices());
  options.signal?.throwIfAborted();
  const { SerialPort } = await serialModule();
  // hupcl=false also opens Windows DTR/RTS disabled. Never copy pyserial's
  // pre-open assignments: Node's API only supports set() on an open port.
  const stream = new SerialPort({ path, baudRate: 115200, autoOpen: false, lock: true, rtscts: false, xon: false, xoff: false, hupcl: false });
  // Start listening before open/set: an unplug or driver failure must never
  // become an unhandled stream error.
  const protocol = new DeviceProtocol(stream, timeoutMs, options.onLog);
  const client = new DeviceClient(protocol, path, options.signal);
  try {
    await new Promise<void>((resolve, reject) => {
      let pending = true;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      const abort = () => {
        pending = false;
        cleanup();
        reject(new DeviceError('closed', 'USB connection was cancelled.'));
      };
      const timer = setTimeout(() => {
        pending = false;
        cleanup();
        reject(new DeviceError('port_open_failed', `Opening ${path} timed out.`));
      }, timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      stream.open(error => {
        cleanup();
        if (!pending || options.signal?.aborted || protocol.closed) {
          if (!error) stream.close(() => undefined);
          if (pending) reject(new DeviceError('closed', 'USB connection was cancelled.'));
          return;
        }
        pending = false;
        if (error) reject(new DeviceError('port_open_failed', `Cannot open ${path}: ${error.message}. Check access permissions and close other serial monitors.`));
        else resolve();
      });
    });
    await releaseDeviceControlLines(flags => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeviceError('port_open_failed', 'Setting USB control lines timed out.')), timeoutMs);
      stream.set(flags, error => { clearTimeout(timer); error ? reject(new DeviceError('port_open_failed', `Cannot set USB control lines: ${error.message}`)) : resolve(); });
    }));
    await client.hello();
    return client;
  } catch (error) { await client.close(); throw error; }
}
