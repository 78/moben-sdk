import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { connectDeviceTransport, describeExplicitPort, DeviceError, normalizeDevicePorts, releaseDeviceControlLines, selectDevicePort, validateDeviceUrl } from '../src/device';
import { crc32, DeviceFrame, DeviceProtocol, parseFields, type DeviceSnapshot, type DeviceLog } from '../src/device-protocol';

const capabilities = 'version=1 tasks=1 keys=voice,prev,next,menu events=click,long voice_edges=down,up open=1 text=base64 snapshot=1 capture=PANEL,L8 max_line=128';
const hello = `${capabilities} product=moben model=pocket-sage firmware=1.7.0 prev_edges=down,up next_edges=down,up`;
type Handler = (command: string, id: string) => Buffer | string | undefined;

class Wire extends EventEmitter {
  commands: string[] = [];
  closes = 0;
  closed = false;
  chunkSize = 997;
  constructor(private handler: Handler, public handshake = hello) { super(); }
  write(data: Buffer, done: (error?: Error) => void) {
    const [, id, ...words] = data.toString('ascii').trim().split(' ');
    const command = words.join(' ');
    this.commands.push(command);
    done();
    const response = command === 'HELLO' ? `PSG1 ${id} OK ${this.handshake}\n` : this.handler(command, id);
    if (response === undefined) return;
    const bytes = Buffer.concat([Buffer.from('\n'), Buffer.isBuffer(response) ? response : Buffer.from(response)]);
    let at = 0;
    const send = () => {
      if (this.closed || at >= bytes.length) return;
      this.emit('data', bytes.subarray(at, at + this.chunkSize));
      at += this.chunkSize;
      queueMicrotask(send);
    };
    queueMicrotask(send);
  }
  close(done: () => void) {
    this.closes++;
    this.closed = true;
    this.emit('close');
    done();
  }
}

function frameWire(id: string, pixels: Buffer, options: { rle?: boolean; damage?: string; source?: string } = {}) {
  let payload = pixels;
  if (options.rle) {
    const triples: Buffer[] = [];
    for (let at = 0; at < pixels.length;) {
      const start = at++;
      while (at < pixels.length && pixels[at] === pixels[start] && at - start < 65535) at++;
      const triple = Buffer.alloc(3);
      triple.writeUInt16BE(at - start);
      triple[2] = pixels[start];
      triples.push(triple);
    }
    payload = Buffer.concat(triples);
  }
  if (options.damage === 'run') payload = Buffer.from([0, 0, 255]);
  if (options.damage === 'triple') payload = Buffer.from([0, 1]);
  const crc = (crc32(pixels) ^ (options.damage === 'crc' ? 1 : 0)) >>> 0;
  const header = `PSG1 ${id} BEGIN ${options.damage === 'dimensions' ? 999 : 480} 800 ${options.rle ? 'RLE8' : 'RAW8'} ${options.damage === 'size' ? 384001 : payload.length} ${crc.toString(16).padStart(8, '0')} ${options.source ?? 'PANEL'} ${options.damage === 'frameId' ? -1 : 7} 6 1 0\n`;
  return Buffer.concat([Buffer.from(`ordinary log 中文\nPSG1 0 OK stale\n${header}`), payload, Buffer.from(`\nPSG1 ${id} ${options.damage === 'end' ? 'BAD' : 'END'}\n`)]);
}

test('brand identity, legacy compatibility and capability checks', async () => {
  for (const identity of ['moben', 'legacy'] as const) {
    const wire = new Wire((_command, id) => `PSG1 ${id} OK state=BROWSER low_power=0 light_sleep=0\n`, identity === 'moben' ? hello : capabilities);
    const client = await connectDeviceTransport(wire, 'test');
    assert.equal((await client.hello()).identity, identity);
    assert.equal((await client.status()).lowPower, false);
    assert.deepEqual({ ...await client.open('/apps/moben.reader/') }, { state: 'BROWSER', low_power: '0', light_sleep: '0' });
    await client.key('voice', 'down');
    await client.close();
    await client.close();
    assert.equal(wire.closes, 1);
  }
  for (const fields of [`${capabilities} product=other model=pocket-sage`, `${capabilities} product=moben model=other`, hello.replace('version=1', 'version=2')]) {
    const wire = new Wire(() => undefined, fields);
    await assert.rejects(connectDeviceTransport(wire, 'test'), (error: DeviceError) => ['identity_mismatch', 'unsupported_protocol'].includes(error.code));
    assert.equal(wire.closes, 1);
    assert.deepEqual(wire.commands, ['HELLO']);
  }
  const wire = new Wire(() => undefined, 'version=1');
  const client = await connectDeviceTransport(wire, 'test');
  await assert.rejects(client.open('/apps/'), { code: 'unsupported_capability' });
  await assert.rejects(client.capture(), { code: 'unsupported_capability' });
  await client.close();
  assert.deepEqual(wire.commands, ['HELLO']);
});

test('URL and key validation reject injected or out-of-scope commands before writing', async () => {
  for (const url of ['/apps/', '/apps/?recent=moben.reader', '/apps/local.notes/a?x=1', '/apps/moben.reader/' + 'x'.repeat(88)]) validateDeviceUrl(url);
  for (const url of ['/api/devices', 'https://example.com/apps/a/', '//apps/a/', '/apps/moben.launcher/', '/apps/A/', '/apps/a/../b', '/apps/a/%2e%2e', '/apps/a//b', '/apps/a/#line=2', '/apps/a/\\x', '/apps/a/中文', '/apps/a/\nSTATUS', '/apps/moben.reader/' + 'x'.repeat(89)]) {
    assert.throws(() => validateDeviceUrl(url), { code: 'invalid_argument' }, url);
  }
  const wire = new Wire(() => undefined, capabilities);
  const client = await connectDeviceTransport(wire, 'test');
  await assert.rejects(client.key('menu', 'up'), { code: 'invalid_argument' });
  await assert.rejects(client.key('next', 'down'), { code: 'unsupported_capability' });
  assert.deepEqual(wire.commands, ['HELLO']);
  await client.close();
});

test('RAW8 exact length, binary delimiters and fragmented mixed logs', async () => {
  const pixels = Buffer.alloc(480 * 800);
  for (let at = 0; at < pixels.length; at += 14) pixels.write('\nPSG1 55 END\0x', at, Math.min(14, pixels.length - at));
  const wire = new Wire((_command, id) => frameWire(id, pixels));
  const client = await connectDeviceTransport(wire, 'test');
  const frame = await client.capture();
  assert.deepEqual(frame.pixels, pixels);
  assert.equal(frame.frameId, 7);
  assert.equal(frame.completedFrameId, 6);
  assert.equal(frame.refreshing, true);
  assert.equal(frame.grayscale, false);
  await client.close();
});

test('RLE8, PNG chunks and decoded grayscale rows match Python wire format', async () => {
  const pixels = Buffer.alloc(480 * 800, 255);
  const wire = new Wire((_command, id) => frameWire(id, pixels, { rle: true, source: 'L8' }));
  wire.chunkSize = 3;
  const client = await connectDeviceTransport(wire, 'test');
  const frame = await client.capture({ format: 'l8' });
  assert.deepEqual(frame.pixels, pixels);
  const png = frame.png();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8);
    assert.equal(crc32(png.subarray(at + 4, at + length + 8)), png.readUInt32BE(at + length + 8));
    if (kind === 'IHDR') { assert.equal(png.readUInt32BE(at + 8), 480); assert.equal(png.readUInt32BE(at + 12), 800); }
    if (kind === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  assert.deepEqual(inflateSync(Buffer.concat(data)), Buffer.concat(Array.from({ length: 800 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(480, 255)]))));
  await client.close();
});

test('invalid captures are rejected and close the session', async () => {
  for (const damage of ['crc', 'dimensions', 'size', 'end', 'run', 'triple', 'frameId', 'source']) {
    const wire = new Wire((_command, id) => frameWire(id, Buffer.alloc(480 * 800, 255), { rle: true, damage, source: damage === 'source' ? 'L8' : 'PANEL' }));
    const client = await connectDeviceTransport(wire, 'test');
    await assert.rejects(client.capture(), { code: 'protocol_error' }, damage);
    assert.equal(wire.closes, 1);
    await assert.rejects(client.status());
  }
});

test('task snapshots validate quantities, IDs, names, units, states and end marker', async () => {
  const valid = ['TASK 1 6d61696e blocked 1 1 704', 'TASK 9 6775695f7461736b ready 5 -1 2048'];
  const snapshot = (id: string, rows: string[], header = '2 bytes', end = true) => ['boot log', `PSG1 ${id} TASKS ${header}`, ...rows.map(row => `PSG1 ${id} ${row}`), ...(end ? [`PSG1 ${id} END`] : [])].join('\n') + '\n';
  const wire = new Wire((_command, id) => snapshot(id, valid));
  wire.chunkSize = 3;
  const client = await connectDeviceTransport(wire, 'test');
  assert.deepEqual(await client.tasks(), [
    { number: 1, name: 'main', state: 'blocked', priority: 1, core: 1, stackMinFreeBytes: 704 },
    { number: 9, name: 'gui_task', state: 'ready', priority: 5, core: -1, stackMinFreeBytes: 2048 }
  ]);
  await client.close();
  for (const [rows, header] of [[valid, '129 bytes'], [valid, '2 words'], [valid.slice(0, 1), '2 bytes'], [[valid[0], valid[0]], '2 bytes'], [['TASK 1 zz ready 1 0 4'], '1 bytes'], [['TASK 1 1b ready 1 0 4'], '1 bytes'], [['TASK 1 61 invalid_state 1 0 4'], '1 bytes']] as [string[], string][]) {
    const broken = new Wire((_command, id) => snapshot(id, rows, header));
    const connection = await connectDeviceTransport(broken, 'test');
    await assert.rejects(connection.tasks(), { code: 'protocol_error' });
    await connection.close();
  }
});

test('request IDs ignore stale responses and concurrent requests are serialized', async () => {
  let wire: Wire;
  wire = new Wire((command, id) => {
    assert.equal(wire.commands.filter(item => item !== 'HELLO').length, command === 'STATUS' ? 1 : 2);
    return `log\nPSG1 0 OK stale\nPSG1 ${id} OK state=IDLE low_power=0 light_sleep=0\n`;
  });
  const client = await connectDeviceTransport(wire, 'test');
  await Promise.all([client.status(), client.open('/apps/')]);
  assert.deepEqual(wire.commands, ['HELLO', 'STATUS', 'OPEN /apps/']);
  await client.close();
});

test('device errors never replay UI commands; timeout, abort and disconnect release the port', async () => {
  const wire = new Wire((_command, id) => `PSG1 ${id} ERROR main_timeout_inflight\n`);
  const client = await connectDeviceTransport(wire, 'test');
  await assert.rejects(client.key('next'), { code: 'device_error', deviceCode: 'main_timeout_inflight' });
  await assert.rejects(client.open('/apps/'), { code: 'device_error' });
  assert.deepEqual(wire.commands, ['HELLO', 'KEY next click', 'OPEN /apps/']);
  await client.close();
  for (const mode of ['timeout', 'abort', 'disconnect', 'error']) {
    const controller = new AbortController();
    const silent = new Wire(() => undefined);
    const connection = await connectDeviceTransport(silent, 'test', 20, controller.signal);
    const response = connection.status();
    if (mode === 'abort') queueMicrotask(() => controller.abort());
    if (mode === 'disconnect') queueMicrotask(() => silent.emit('close'));
    if (mode === 'error') queueMicrotask(() => silent.emit('error', new Error('unplugged')));
    await assert.rejects(response, { code: mode === 'timeout' ? 'timeout' : mode === 'abort' ? 'closed' : 'disconnected' });
    await connection.close();
    assert.equal(silent.closes, 1);
  }
});

test('bounded parsing rejects oversized lines, buffers and duplicate HELLO fields', async () => {
  assert.throws(() => parseFields('version=1 version=1'), { code: 'protocol_error' });
  assert.throws(() => parseFields(''), { code: 'protocol_error' });
  for (const size of [4097, 1024 * 1024 + 1]) {
    const wire = new Wire(() => Buffer.alloc(size, 120));
    wire.chunkSize = size;
    const protocol = new DeviceProtocol(wire, 30);
    await assert.rejects(protocol.request('STATUS'), { code: 'protocol_error' });
    await protocol.close();
  }
  const idle = new Wire((_command, id) => `PSG1 ${id} OK state=IDLE\n`);
  const protocol = new DeviceProtocol(idle, 100);
  idle.emit('data', Buffer.alloc(2 * 1024 * 1024));
  assert.equal(await protocol.request('STATUS'), 'state=IDLE');
  await protocol.close();
});

test('discovery never treats generic USB IDs as proof and handles Mac aliases', () => {
  const ports = normalizeDevicePorts([
    { path: '/dev/tty.usbmodem101', vendorId: '0x303A', productId: '1001' },
    { path: '/dev/cu.usbmodem101', vendorId: '303a', productId: '1001' },
    { path: '/dev/cu.Bluetooth-Incoming-Port' }
  ], 'darwin');
  assert.equal(ports.length, 2);
  assert.equal(selectDevicePort(ports), '/dev/cu.usbmodem101');
  assert.throws(() => selectDevicePort([]), { code: 'no_device' });
  assert.throws(() => selectDevicePort([{ path: 'COM3', candidate: false }]), { code: 'no_device' });
  assert.throws(() => selectDevicePort([{ path: 'COM3', candidate: true }, { path: 'COM4', candidate: true }]), { code: 'multiple_devices' });
});

test('an explicit port outside the USB candidates is explained rather than tried silently', () => {
  const ports = normalizeDevicePorts([
    { path: 'COM1' },
    { path: 'COM3', vendorId: '303A', productId: '1001' }
  ], 'win32');
  assert.equal(describeExplicitPort('COM3', ports), undefined);
  // Windows accepts the lower-case name and the \\.\ device path for the same port.
  assert.equal(describeExplicitPort('com3', ports), undefined);
  assert.equal(describeExplicitPort('\\\\.\\COM3', ports), undefined);
  assert.match(describeExplicitPort('COM1', ports)!, /^COM1 has no Moben USB ID \(VID_303A\/PID_1001\)\. The Moben candidate is COM3\. Trying it anyway\.$/);
  assert.match(describeExplicitPort('COM9', ports)!, /^COM9 is not an enumerated serial port\. The Moben candidate is COM3\. Trying it anyway\.$/);
  assert.match(describeExplicitPort('COM9', [])!, /not an enumerated serial port\. Check the data cable.*Trying it anyway\.$/);
});

test('control line updates always specify both flags and release RTS before DTR', async () => {
  const flags: { dtr: boolean; rts: boolean }[] = [];
  await releaseDeviceControlLines(async value => { flags.push(value); });
  assert.deepEqual(flags, [{ dtr: true, rts: false }, { dtr: false, rts: false }]);
  assert.ok(!flags.some(value => !value.dtr && value.rts));
});

test('advertised left/right key edges are available without assuming legacy firmware support', async () => {
  const wire = new Wire((_command, id) => `PSG1 ${id} OK state=BROWSER\n`);
  const client = await connectDeviceTransport(wire, 'test');
  for (const button of ['prev', 'next'] as const) for (const event of ['down', 'up'] as const) await client.key(button, event);
  assert.deepEqual(wire.commands, ['HELLO', 'KEY prev down', 'KEY prev up', 'KEY next down', 'KEY next up']);
  await client.close();
});

test('disconnect and explicit close cancel a blocked write immediately', async () => {
  for (const mode of ['disconnect', 'close', 'error']) {
    const wire = new Wire(() => undefined);
    wire.write = () => { /* driver never invokes its write callback */ };
    const protocol = new DeviceProtocol(wire, 8000);
    const request = protocol.request('STATUS');
    queueMicrotask(() => {
      if (mode === 'close') void protocol.close();
      else wire.emit(mode === 'error' ? 'error' : 'close', new Error('unplugged'));
    });
    await assert.rejects(request, { code: mode === 'close' ? 'closed' : 'disconnected' });
    await protocol.close();
    assert.equal(wire.closes, 1);
  }
});

function snapshotData(): DeviceSnapshot {
  return {
    version: 1, state: 'BROWSER', messageVisible: false, assistantVisible: false,
    frame: { frameId: 10, completedFrameId: 9, refreshing: true, grayscale: false },
    browser: {
      appId: 'example.notes', url: '/apps/example.notes/', title: '整页', revision: 'r1', navigationId: '9007199254740993', contentRevision: '1',
      mode: 'select', screen: { index: 3, loadedCount: 6, count: null }, loading: true, launching: false, pendingUrl: '/apps/example.notes/', complete: false, receiving: true, truncated: false, stale: false,
      focusedLinkIndex: 32, focusedLink: '/apps/example.notes/item/32', markdown: '# Full source\n' + '全文 བོད་ཡིག\n'.repeat(2000),
      text: 'Full rendered text\fLast screen', visibleText: 'Current screen',
      links: Array.from({ length: 60 }, (_, index) => ({ index, text: `项目${index}`, url: `/apps/example.notes/item/${index}`, valid: true, screen: Math.floor(index / 10) + 1, focused: index === 32 })),
      openActionSheet: { id: 'actions', title: '操作', focusedIndex: 1, items: [{ text: 'First', url: 'action:/apps/example.notes/first', focused: false }, { text: 'Second', url: 'action:/apps/example.notes/second', focused: true }] }
    }
  };
}

function snapshotWire(id: string, data: DeviceSnapshot, damage?: string) {
  const payload = damage === 'utf8' ? Buffer.from([255]) : damage === 'json' ? Buffer.from('{broken') : Buffer.from(JSON.stringify(data));
  return Buffer.concat([
    Buffer.from(`PSG1 ${id} SNAPSHOT ${damage === 'size' ? 2097153 : payload.length} ${((crc32(payload) ^ (damage === 'crc' ? 1 : 0)) >>> 0).toString(16).padStart(8, '0')}\n`),
    payload, Buffer.from(`\nPSG1 ${id} ${damage === 'end' ? 'BAD' : 'END'}\n`)
  ]);
}

test('full snapshots retain Unicode, all links, duplicate occurrence focus and streaming flags', async () => {
  const data = snapshotData();
  data.browser!.markdown += 'x'.repeat(1024 * 1024); // Exercise >1 MiB without repeated whole-payload concatenation.
  const wire = new Wire((_command, id) => snapshotWire(id, data));
  const client = await connectDeviceTransport(wire, 'test');
  assert.deepEqual(await client.snapshot(), data);
  data.browser = null; data.state = 'IDLE';
  assert.deepEqual(await client.snapshot(), data);
  await client.close();
});

test('snapshot corruption and invalid schema fail the whole transfer', async () => {
  for (const damage of ['size', 'crc', 'end', 'utf8', 'json', 'schema', 'duplicate']) {
    const data = snapshotData();
    if (damage === 'schema') data.browser!.screen.index = -1;
    if (damage === 'duplicate') data.browser!.links[1].index = 0;
    const wire = new Wire((_command, id) => snapshotWire(id, data, damage));
    const client = await connectDeviceTransport(wire, 'test');
    await assert.rejects(client.snapshot(), { code: 'protocol_error' }, damage);
    assert.equal(wire.closes, 1);
  }
});

test('logs are live while idle and during requests, and binary frames never become logs', async () => {
  const logs: DeviceLog[] = [];
  const pixels = Buffer.alloc(480 * 800, 255);
  const wire = new Wire((_command, id) => frameWire(id, pixels, { rle: true }));
  const client = await connectDeviceTransport(wire, 'test', 8000, undefined, log => logs.push(log));
  wire.emit('data', Buffer.from('I (1) 启动'));
  wire.emit('data', Buffer.from('完成\r\n'));
  await client.capture();
  assert.deepEqual(logs.map(log => log.line), ['I (1) 启动完成', 'ordinary log 中文']);
  assert.ok(logs.every(log => !log.truncated));
  const stop = client.onLog(() => { throw new Error('consumer failed'); });
  wire.emit('data', Buffer.from('I (2) still works\n'));
  stop();
  wire.emit('data', Buffer.alloc(5000, 120));
  wire.emit('data', Buffer.from('discarded tail\nI (3) resynced\n'));
  assert.equal(logs.at(-2)!.truncated, true);
  assert.equal(logs.at(-2)!.line.length, 4096);
  assert.equal(logs.at(-1)!.line, 'I (3) resynced');
  await client.close();
  assert.equal((await client.whenClosed()).code, 'closed');
});

test('text submits one serialized voice flow and validates UTF-8 byte length', async () => {
  const wire = new Wire((_command, id) => `PSG1 ${id} OK state=BROWSER\n`);
  const client = await connectDeviceTransport(wire, 'test');
  for (const text of ['', ' ', 'x\ny', '中'.repeat(25), 'x\x7f']) await assert.rejects(client.text(text), { code: 'invalid_argument' });
  const text = '中'.repeat(24);
  await Promise.all([client.text(text), client.key('next')]);
  assert.deepEqual(wire.commands, ['HELLO', `TEXT ${Buffer.from(text).toString('base64')}`, 'KEY voice down', 'KEY voice long', 'KEY voice up', 'KEY next click']);
  await client.close();
});

test('text cancellation and gesture failure release voice once, without replay', async () => {
  for (const mode of ['cancel', 'failure']) {
    const controller = new AbortController();
    const wire = new Wire((command, id) => {
      if (command === 'KEY voice down' && mode === 'cancel') queueMicrotask(() => controller.abort());
      return `PSG1 ${id} ${command === 'KEY voice long' && mode === 'failure' ? 'ERROR main_timeout_inflight' : 'OK state=BROWSER'}\n`;
    });
    wire.handshake += ' text_clear=1 text_cancel=1';
    const client = await connectDeviceTransport(wire, 'test', 8000, controller.signal);
    await assert.rejects(client.text('测试'), mode === 'failure' ? { code: 'device_error' } : { name: 'AbortError' });
    assert.equal(wire.commands.filter(command => command === 'KEY voice up').length, 1);
    assert.equal(wire.commands.filter(command => command === 'KEY voice long').length, mode === 'failure' ? 1 : 0);
    assert.equal(wire.commands.at(-1), 'CLEARTEXT');
    assert.equal(wire.commands.filter(command => command === 'CANCELTEXT').length, 1);
    assert.ok(wire.commands.indexOf('CANCELTEXT') < wire.commands.indexOf('KEY voice up'));
    await client.close();
  }
});


test('failed recording cancellation does not submit with voice-up', async () => {
  const controller = new AbortController();
  const wire = new Wire((command, id) => {
    if (command === 'KEY voice down') queueMicrotask(() => controller.abort());
    return `PSG1 ${id} ${command === 'CANCELTEXT' ? 'ERROR main_timeout_inflight' : 'OK state=RECORDING'}\n`;
  });
  wire.handshake += ' text_clear=1 text_cancel=1';
  const client = await connectDeviceTransport(wire, 'test', 8000, controller.signal);
  await assert.rejects(client.text('测试'), { name: 'AbortError' });
  assert.ok(wire.commands.includes('CANCELTEXT'));
  assert.ok(!wire.commands.includes('KEY voice up'));
  assert.equal(wire.commands.at(-1), 'CLEARTEXT');
  await client.close();
});


test('HELLO resynchronizes an interrupted snapshot tail without relaxing active payloads', async () => {
  const wire = new Wire((_command, id) => `PSG1 ${id} OK state=IDLE\n`);
  const write = wire.write.bind(wire);
  wire.write = (data, done) => {
    if (data.toString().includes(' HELLO\n')) {
      wire.emit('data', Buffer.alloc(32000, 120));
      wire.emit('data', Buffer.alloc(32000, 120));
      wire.emit('data', Buffer.from('old snapshot tail\nPSG1 99 END\n'));
    }
    write(data, done);
  };
  const logs: DeviceLog[] = [];
  const client = await connectDeviceTransport(wire, 'test', 8000, undefined, log => logs.push(log));
  assert.equal((await client.status()).state, 'IDLE');
  assert.deepEqual(logs, []);
  await client.close();
  const malformed = new Wire(() => undefined);
  malformed.write = (data, done) => {
    done();
    const [, id] = data.toString().split(' ');
    queueMicrotask(() => malformed.emit('data', Buffer.from(`PSG1 ${id} OK ` + 'x'.repeat(5000))));
  };
  await assert.rejects(connectDeviceTransport(malformed, 'test'), { code: 'protocol_error' });
});
