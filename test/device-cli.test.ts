import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runDeviceCommand } from '../src/device-cli';
import { connectDevice, DeviceClient, DeviceError, type DeviceHello, type DeviceStatus } from '../src/device';
import { DeviceFrame } from '../src/device-protocol';

const root = resolve(__dirname, '..');
const tsx = require.resolve('tsx/cli');
function cli(...args: string[]) {
  return spawnSync(process.execPath, [tsx, join(root, 'src/cli.ts'), ...args], { cwd: root, encoding: 'utf8' });
}

function fixture(identity: 'moben' | 'legacy' = 'moben', power: boolean | null = false) {
  const hello: DeviceHello = { identity, fields: { version: '1' }, ...(identity === 'moben' ? { product: 'moben', model: 'pocket-sage', firmware: 'test' } : {}) };
  const status: DeviceStatus = { state: 'IDLE', lowPower: power, lightSleep: power, fields: {} };
  const calls: string[] = [];
  const device = {
    port: 'COM3',
    hello: async () => { calls.push('hello'); return hello; },
    status: async () => { calls.push('status'); return status; },
    tasks: async () => { calls.push('tasks'); return [{ number: 1, name: 'main', state: 'ready', priority: 1, core: -1, stackMinFreeBytes: 704 }]; },
    open: async (url: string) => { calls.push(`open ${url}`); return { state: 'BROWSER' }; },
    key: async (button: string, event: string) => { calls.push(`key ${button} ${event}`); return { state: 'BROWSER' }; },
    text: async (message: string) => { calls.push(`text ${message}`); return { state: 'REQUESTING' }; },
    snapshot: async () => { calls.push('snapshot'); return { version: 1, state: 'IDLE', messageVisible: false, assistantVisible: false, frame: { frameId: 7, completedFrameId: 7, refreshing: false, grayscale: false }, browser: null }; },
    capture: async () => { calls.push('capture'); return new DeviceFrame(480, 800, Buffer.alloc(480 * 800, 255), 'PANEL', 7, 6, true, false); },
    close: async () => { calls.push('close'); }
  } as unknown as DeviceClient;
  const dependencies = {
    listDevices: async () => [{ path: 'COM3', candidate: true }],
    connectDevice: (async () => { calls.push('connect'); return device; }) as typeof connectDevice
  };
  return { dependencies, calls, device };
}

async function output(run: () => Promise<number>) {
  let stdout = '', stderr = '';
  const writeOut = process.stdout.write, writeErr = process.stderr.write;
  process.stdout.write = ((text: string) => { stdout += text; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => { stderr += text; return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: () => stdout, stderr: () => stderr }; }
  finally { process.stdout.write = writeOut; process.stderr.write = writeErr; }
}

test('actual CLI help and invalid USB arguments need no hardware', () => {
  const help = cli('device', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Low power mode OFF/);
  assert.match(help.stdout, /screenshot/);
  for (const args of [
    ['open', '/api/devices'], ['open', '/apps/', 'extra'], ['key', 'menu', '--event', 'down'],
    ['key', 'next', '--event', 'repeat'], ['screenshot'], ['screenshot', '--output', 'x.png', '--format', 'raw'],
    ['status', '--timeout', '0'], ['status', '--timeout', 'Infinity'], ['status', '--timeout', '121'],
    ['status', '--port', ''], ['status', '--event', 'click'], ['status', '--entry', 'app.ts'], ['unknown'],
    ['status', '--unknown'], ['status', '--timeout'], ['text'], ['text', '中'.repeat(25)], ['text', 'line\nbreak'],
    ['snapshot', '--output', ''], ['logs', '--format', 'l8'], ['logs', 'extra']
  ]) {
    const run = cli('device', ...args, '--json');
    assert.equal(run.status, 2, run.stderr + run.stdout);
    const data = JSON.parse(run.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.code, 'invalid_argument');
    if (args[0] === 'logs') { assert.equal(run.stdout.trim().split('\n').length, 1); assert.equal(data.type, 'error'); }
  }
});

test('an explicit --port outside the USB candidates warns first and is still attempted', async () => {
  const f = fixture();
  f.dependencies.listDevices = async () => [{ path: 'COM1', candidate: false }, { path: 'COM3', candidate: true }];

  const text = await output(() => runDeviceCommand('status', [], { port: 'COM1' }, f.dependencies));
  assert.equal(text.code, 0);
  assert.match(text.stderr(), /warning: COM1 has no Moben USB ID .*COM3\. Trying it anyway\./);
  assert.ok(f.calls.includes('connect'), 'an explicit port is attempted, not rejected');

  const json = await output(() => runDeviceCommand('status', [], { json: true, port: 'COM1' }, f.dependencies));
  assert.equal(json.code, 0);
  assert.match(JSON.parse(json.stdout()).warnings[0], /COM1 has no Moben USB ID/);
  assert.match(json.stderr(), /warning: COM1 has no Moben USB ID/, 'a failed JSON run has no envelope, so stderr still carries it');

  const candidate = await output(() => runDeviceCommand('status', [], { json: true, port: 'COM3' }, f.dependencies));
  assert.deepEqual(JSON.parse(candidate.stdout()).warnings, []);

  // The warning must survive the very failure it explains: COM1 opens, then
  // never answers, and hello() is where the generic timeout is raised.
  const failing = fixture();
  failing.dependencies.listDevices = async () => [{ path: 'COM1', candidate: false }, { path: 'COM3', candidate: true }];
  failing.dependencies.connectDevice = async () => { throw new DeviceError('timeout', 'USB response timed out.'); };
  const failed = await output(async () => {
    await assert.rejects(runDeviceCommand('status', [], { port: 'COM1' }, failing.dependencies), { code: 'timeout' });
    return 0;
  });
  assert.match(failed.stderr(), /warning: COM1 has no Moben USB ID .*COM3/);
});

test('list enumerates without connecting and all device commands emit JSON', async () => {
  const work = await mkdtemp(join(tmpdir(), 'moben-usb-cli-'));
  try {
    for (const command of ['list', 'hello', 'status', 'tasks', 'open', 'key', 'text', 'snapshot', 'screenshot']) {
      const fixture_ = fixture();
      const args = command === 'open' ? ['/apps/'] : command === 'key' ? ['next'] : command === 'text' ? ['测试文字'] : [];
      const flags = { json: true, port: 'COM3', ...(command === 'screenshot' ? { output: join(work, 'screen.png') } : command === 'snapshot' ? { output: join(work, 'snapshot.json') } : {}) };
      const result = await output(() => runDeviceCommand(command, args, flags, fixture_.dependencies));
      assert.equal(result.code, 0);
      const data = JSON.parse(result.stdout());
      if (command === 'list') { assert.equal(data.ports[0].candidate, true); assert.deepEqual(fixture_.calls, []); }
      else {
        assert.equal(data.port, 'COM3');
        assert.equal(data.identity, 'moben');
        assert.equal(fixture_.calls.at(-1), 'close');
      }
      if (command === 'open') assert.match(data.message, /may still be in progress/);
      if (command === 'snapshot') assert.equal(JSON.parse(await readFile(data.output, 'utf8')).state, 'IDLE');
      if (command === 'screenshot') {
        assert.equal(data.frame.frameId, 7);
        assert.equal(data.frame.refreshing, true);
        assert.equal((await readFile(data.output)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      }
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('logs emit NDJSON and append on the host; cancellation closes the same connection', async () => {
  const work = await mkdtemp(join(tmpdir(), 'moben-usb-logs-'));
  const path = join(work, 'serial.log');
  const controller = new AbortController();
  const f = fixture();
  let connections = 0;
  f.dependencies.connectDevice = async options => {
    connections++;
    options!.onLog!({ line: 'I (1) connected 中文', truncated: false });
    controller.abort();
    return f.device;
  };
  f.device.whenClosed = async () => new DeviceError('closed', 'Cancelled');
  try {
    await writeFile(path, 'previous\n');
    const run = await output(() => runDeviceCommand('logs', [], { json: true, output: path }, f.dependencies, controller.signal));
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(run.stdout()), { type: 'log', line: 'I (1) connected 中文', truncated: false });
    assert.equal(await readFile(path, 'utf8'), `previous\n${run.stdout()}`);
    assert.equal(connections, 1);
    assert.equal(f.calls.at(-1), 'close');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('logs report an actual disconnection instead of silently completing', async () => {
  const f = fixture();
  f.device.whenClosed = async () => new DeviceError('disconnected', 'Unplugged');
  await assert.rejects(runDeviceCommand('logs', [], { json: true }, f.dependencies), { code: 'disconnected' });
  assert.equal(f.calls.at(-1), 'close');
});

test('doctor only confirms ready after brand and both power settings are verified', async () => {
  for (const identity of ['moben', 'legacy'] as const) for (const power of [false, true, null]) {
    const f = fixture(identity, power);
    const run = await output(() => runDeviceCommand('doctor', [], { json: true }, f.dependencies));
    const data = JSON.parse(run.stdout());
    const ready = identity === 'moben' && power === false;
    assert.equal(data.ready, ready);
    assert.equal(run.code, ready ? 0 : 1);
    assert.equal(data.warnings.length, identity === 'legacy' ? 1 : 0);
    assert.deepEqual(f.calls, ['connect', 'hello', 'status', 'close']);
  }
});

test('legacy commands remain usable, warnings go to stderr in text mode', async () => {
  const f = fixture('legacy');
  const run = await output(() => runDeviceCommand('key', ['next'], {}, f.dependencies));
  assert.equal(run.code, 0);
  assert.match(run.stderr(), /identity is unconfirmed/);
  assert.deepEqual(f.calls, ['connect', 'hello', 'key next click', 'close']);
});

test('failed capture does not overwrite an existing PNG and always closes the port', async () => {
  const work = await mkdtemp(join(tmpdir(), 'moben-usb-cli-'));
  const path = join(work, 'screen.png');
  try {
    await writeFile(path, 'previous image');
    const f = fixture();
    f.device.capture = async () => { throw new DeviceError('protocol_error', 'CRC mismatch'); };
    await assert.rejects(runDeviceCommand('screenshot', [], { json: true, output: path }, f.dependencies), { code: 'protocol_error' });
    assert.equal(await readFile(path, 'utf8'), 'previous image');
    assert.deepEqual(await readdir(work), ['screen.png']);
    assert.equal(f.calls.at(-1), 'close');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('existing SDK imports and local commands do not load optional serialport', () => {
  const hook = `
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'serialport' || name.startsWith('@serialport/')) throw new Error('native serial addon deliberately unavailable');
  return load.call(this, name, ...args);
};
require(${JSON.stringify(join(root, 'src/index.ts'))});
process.stdout.write('sdk imported');
`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', hook], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'sdk imported');
  const dependencyFailure = spawnSync(process.execPath, ['--import', 'tsx', '-e', hook.replace("process.stdout.write('sdk imported');", `process.argv = ['node', 'moben', 'device', 'list', '--json']; require(${JSON.stringify(join(root, 'src/cli.ts'))});`)], { cwd: root, encoding: 'utf8' });
  assert.equal(dependencyFailure.status, 1, dependencyFailure.stderr);
  assert.equal(JSON.parse(dependencyFailure.stdout).code, 'serial_dependency_missing');
});

test('native adapter lifecycle: safe flags, late open cleanup and diagnostic codes', t => {
  try { require.resolve('serialport'); } catch { t.skip('Optional serialport package is not installed.'); return; }
  for (const scenario of ['ready', 'open_error', 'timeout', 'wrong_brand', 'late_open', 'early_error', 'abort']) {
    const hook = `
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const load = Module._load;
const events = [];
const scenario = ${JSON.stringify(scenario)};
let stream;
class SerialPort extends EventEmitter {
  constructor(options) { super(); this.isOpen = false; stream = this; events.push(options); }
  open(done) {
    if (scenario === 'early_error') queueMicrotask(() => this.emit('error', new Error('USB failed during open')));
    setTimeout(() => {
      if (scenario === 'open_error') return done(new Error('permission denied'));
      this.isOpen = true; done();
    }, scenario === 'late_open' ? 60 : scenario === 'early_error' ? 10 : 0);
  }
  set(flags, done) { events.push(flags); done(); }
  write(bytes, done) {
    done();
    if (scenario === 'timeout') return;
    const id = bytes.toString().split(' ')[1];
    queueMicrotask(() => this.emit('data', Buffer.from('PSG1 ' + id + ' OK version=1 product=' + (scenario === 'wrong_brand' ? 'other' : 'moben') + ' model=pocket-sage\\n')));
  }
  close(done) {
    events.push('close');
    if (!this.isOpen) return done(new Error('not open'));
    this.isOpen = false; this.emit('close'); done();
  }
}
Module._load = function(name, ...args) { return name === 'serialport' ? { SerialPort } : load.call(this, name, ...args); };
const serialPath = require.resolve('serialport');
require.cache[serialPath] = { id: serialPath, filename: serialPath, loaded: true, exports: { SerialPort } };
const { connectDevice } = require(${JSON.stringify(join(root, 'src/device.ts'))});
const controller = new AbortController();
let result;
const pending = connectDevice({ port: 'COM3', timeoutMs: scenario === 'late_open' ? 10 : scenario === 'timeout' ? 20 : 500, signal: controller.signal })
  .then(async device => { result = { identity: (await device.hello()).identity }; await device.close(); })
  .catch(error => { result = { code: error.code, message: error.message }; });
if (scenario === 'abort') setTimeout(() => controller.abort(), 1);
process.once('beforeExit', () => process.stdout.write(JSON.stringify({ result, events, open: stream?.isOpen })));
`;
    const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', hook], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(run.stdout);
    assert.equal(data.open, false, `${scenario}: leaked serial handle`);
    if (scenario === 'ready') {
      assert.equal(data.result.identity, 'moben');
      assert.equal(data.events[0].hupcl, false);
      assert.equal(data.events[0].lock, true);
      assert.deepEqual(data.events.slice(1, 3), [{ dtr: true, rts: false }, { dtr: false, rts: false }]);
    } else {
      const expected: Record<string, string> = { open_error: 'port_open_failed', timeout: 'timeout', wrong_brand: 'identity_mismatch', late_open: 'port_open_failed', early_error: 'closed', abort: 'closed' };
      assert.equal(data.result.code, expected[scenario], run.stdout);
    }
  }
});
