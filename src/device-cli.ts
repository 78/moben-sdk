import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { connectDevice, DeviceError, listDevices, validateDeviceKey, validateDeviceText, validateDeviceTimeout, validateDeviceUrl, type DeviceButton, type DeviceKeyEvent, type CaptureFormat, type DeviceClient, type DeviceLog } from './device';

export const DEVICE_HELP = `Usage: moben device <command> [options]

  list                    List serial ports without opening them (candidate is only a USB ID hint)
  doctor                  Verify Moben identity and low-power/light-sleep status
  hello                   Show PSG1 identity and capabilities
  status                  Query application and memory/power status
  tasks                   Show minimum unused task stack since creation, in bytes
  open <url>              Accept an /apps/ page request; does not wait for loading or refresh
  key <button>            Inject one application gesture, never automatically retried
  text <message>          Replace ASR in one voice flow (server test-device allowlist required)
  snapshot                Export state, full loaded Browser text/Markdown, links and focus
  logs                    Follow live logs on this connection until Ctrl-C (no device history)
  screenshot              Save a validated framebuffer as PNG (not an optical screen readback)

Options:
  --port <path>           COM3 (Windows), /dev/ttyACM0 (Linux), /dev/cu.usbmodem101 (macOS)
                          Omit only when exactly one Espressif USB Serial/JTAG candidate exists
  --timeout <seconds>     Per-command timeout, default 8; range (0, 120]
  --event <event>         key: click (default), long, down or up; menu has no down/up
  --output <file>         screenshot: required PNG; snapshot: optional JSON; logs: optional append file
  --format <format>       screenshot: panel (default) or l8
  --json                  Machine-readable output; errors include a stable code
  -h, --help              Show help

Before connecting: Advanced settings → Low power mode OFF; use a USB data cable;
close other serial monitors. Run on the computer physically connected to the device.
USB commands need no Moben login. Targets Windows 10/11, Linux and macOS; Windows 7 is unsupported.
`;

export interface DeviceFlags {
  port?: string;
  timeout?: string;
  event?: string;
  output?: string;
  format?: string;
  json?: boolean;
}

/** Validate arguments before loading native dependencies or touching a device. */
function validate(command: string | undefined, args: string[], flags: DeviceFlags) {
  if (!command || !['list', 'doctor', 'hello', 'status', 'tasks', 'open', 'key', 'text', 'snapshot', 'logs', 'screenshot'].includes(command)) throw new DeviceError('invalid_argument', 'Use moben device <list|doctor|hello|status|tasks|open|key|text|snapshot|logs|screenshot>. Run moben device --help.');
  if (args.length !== (['open', 'key', 'text'].includes(command) ? 1 : 0)) throw new DeviceError('invalid_argument', `Wrong arguments for moben device ${command}. Run moben device --help.`);
  const timeoutMs = validateDeviceTimeout(flags.timeout === undefined ? undefined : Number(flags.timeout) * 1000);
  if (flags.event !== undefined && command !== 'key' || flags.output !== undefined && !['screenshot', 'snapshot', 'logs'].includes(command) || flags.format !== undefined && command !== 'screenshot') throw new DeviceError('invalid_argument', '--event is for key; --output is for screenshot/snapshot/logs; --format is for screenshot.');
  if (flags.output !== undefined && !flags.output.trim()) throw new DeviceError('invalid_argument', 'Provide a nonempty --output path.');
  if (command === 'open') validateDeviceUrl(args[0]);
  if (command === 'key') validateDeviceKey(args[0], flags.event ?? 'click');
  if (command === 'text') validateDeviceText(args[0]);
  if (command === 'screenshot' && (!flags.output?.trim() || !['panel', 'l8'].includes(flags.format ?? 'panel'))) throw new DeviceError('invalid_argument', 'Use screenshot --output <file.png> [--format panel|l8].');
  if (flags.port !== undefined && (!flags.port.trim() || /[\x00-\x1f\x7f]/.test(flags.port))) throw new DeviceError('invalid_argument', 'Provide a valid --port path.');
  return timeoutMs;
}

/** Atomic replace happens only after the entire image has been validated and encoded. */
export async function saveDeviceFile(path: string, data: Buffer): Promise<string> {
  const output = resolve(path);
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, output);
  } finally { await unlink(temporary).catch(() => undefined); }
  return output;
}

// Injectable functions keep CLI tests independent of native addons and hardware.
export async function runDeviceCommand(command: string | undefined, args: string[], flags: DeviceFlags,
  dependencies = { listDevices, connectDevice }, signal?: AbortSignal): Promise<number> {
  const timeoutMs = validate(command, args, flags);
  const print = (data: unknown, text: string) => process.stdout.write(flags.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
  if (command === 'list') {
    const ports = await dependencies.listDevices();
    print({ ports }, ports.length ? ports.map(port => `${port.path}${port.candidate ? '  candidate (brand unconfirmed)' : ''}${port.manufacturer ? `  ${port.manufacturer}` : ''}`).join('\n') : 'No serial ports found. Check the data cable, USB port, device power, driver and low power setting.');
    return 0;
  }
  if (command === 'logs') {
    const file = flags.output ? openSync(resolve(flags.output), 'a') : undefined;
    let device: DeviceClient | undefined;
    let logFailure: Error | undefined;
    try {
      const onLog = (log: DeviceLog) => {
        if (logFailure) return;
        try {
          if (process.stdout.writableLength > 1024 * 1024) throw new DeviceError('log_consumer_slow', 'Log output cannot keep up; stopped to bound host memory.');
          const line = flags.json ? JSON.stringify({ type: 'log', ...log }) : log.line + (log.truncated ? ' [truncated]' : '');
          if (file !== undefined) writeSync(file, `${line}\n`);
          process.stdout.write(`${line}\n`);
        } catch (error) { logFailure = error as Error; void device?.close(); }
      };
      device = await dependencies.connectDevice({ port: flags.port, timeoutMs, signal, onLog });
      if (logFailure) throw logFailure;
      if (!flags.json) process.stderr.write(`Following ${device.port}; Ctrl-C stops. Logs before connection are unavailable.\n`);
      const reason = await device.whenClosed();
      if (logFailure) throw logFailure;
      if (!signal?.aborted) throw reason;
      return 0;
    } finally {
      await device?.close();
      if (file !== undefined) closeSync(file);
    }
  }
  const device = await dependencies.connectDevice({ port: flags.port, timeoutMs, signal });
  try {
    const hello = await device.hello();
    const warnings: string[] = hello.identity === 'legacy' ? ['Compatible legacy PSG1 device; Moben identity is unconfirmed. Update the firmware for brand identification.'] : [];
    if (!flags.json) for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    const envelope = (data: object) => ({ port: device.port, identity: hello.identity, warnings, ...data });
    switch (command) {
      case 'hello':
        print(envelope({ hello }), JSON.stringify(hello, null, 2));
        break;
      case 'doctor': {
        const status = await device.status();
        const ready = hello.identity === 'moben' && status.lowPower === false && status.lightSleep === false;
        const message = ready ? 'Moben connected; USB debugging is ready.' : hello.identity === 'legacy'
          ? 'Legacy PSG1 endpoint responds; Moben identity is unconfirmed. Update the firmware.'
          : 'Moben responds, but power settings are not confirmed safe for debugging. Turn low power OFF and check firmware/startup.';
        print(envelope({ ready, hello, status, message }), `${message}\n${JSON.stringify({ hello, status }, null, 2)}`);
        return ready ? 0 : 1;
      }
      case 'status': {
        const status = await device.status();
        print(envelope({ status }), JSON.stringify(status, null, 2));
        break;
      }
      case 'tasks': {
        const tasks = await device.tasks();
        const rows = [...tasks].sort((a, b) => a.stackMinFreeBytes - b.stackMinFreeBytes).map(task =>
          `${task.name.padEnd(20)} ${String(task.number).padStart(3)}  ${task.state.padEnd(10)} ${String(task.priority).padStart(4)}  ${String(task.core === -1 ? 'any' : task.core === -2 ? '?' : task.core).padStart(4)}  ${String(task.stackMinFreeBytes).padStart(12)}`);
        print(envelope({ tasks }), ['TASK                  ID  STATE      PRIO  CORE  MIN FREE (B)', ...rows,
          'MIN FREE = minimum unused stack since task creation, not current free space.'].join('\n'));
        break;
      }
      case 'open': {
        const result = await device.open(args[0]);
        const message = 'Page request accepted; loading, rendering and physical refresh may still be in progress.';
        print(envelope({ result, message }), `${JSON.stringify(result)}\n${message}`);
        break;
      }
      case 'key': {
        const result = await device.key(args[0] as DeviceButton, (flags.event ?? 'click') as DeviceKeyEvent);
        print(envelope({ result }), JSON.stringify(result));
        break;
      }
      case 'text': {
        const result = await device.text(args[0]);
        const message = 'Voice input submitted with replacement ASR text; this does not wait for the app or assistant reply.';
        print(envelope({ result, message }), `${JSON.stringify(result)}\n${message}`);
        break;
      }
      case 'snapshot': {
        const snapshot = await device.snapshot();
        const encoded = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
        const output = flags.output ? await saveDeviceFile(flags.output, encoded) : undefined;
        print(envelope({ snapshot, ...(output ? { output } : {}) }), output ? `Saved ${output}` : encoded.toString('utf8').trimEnd());
        break;
      }
      case 'screenshot': {
        const frame = await device.capture({ format: flags.format as CaptureFormat | undefined });
        const output = await saveDeviceFile(flags.output!, frame.png());
        const { width, height, source, frameId, completedFrameId, refreshing, grayscale } = frame;
        const metadata = { width, height, source, frameId, completedFrameId, refreshing, grayscale };
        print(envelope({ output, frame: metadata }), `Saved ${output}\n${JSON.stringify(metadata)}`);
        break;
      }
    }
    return 0;
  } finally { await device.close(); }
}
