import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { connect, defineApp, page } from '../src';
import { writeCredentials } from '../src/credentials';

const root = resolve(__dirname, '..');
const tsx = require.resolve('tsx/cli');
const silent = { info() {}, warn() {}, error() {} };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function cleanEnv(configDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MOBEN_CONFIG_DIR: configDir };
  delete env.MOBEN_DEVELOPER_KEY;
  delete env.MOBEN_API_URL;
  delete env.MOBEN_APP_CONNECT_URL;
  return env;
}

// Async so the fake server in this process keeps answering while the CLI runs.
async function moben(configDir: string, ...args: string[]) {
  const child = spawn(process.execPath, [tsx, join(root, 'src/cli.ts'), ...args, '--json'], { env: cleanEnv(configDir), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, data: JSON.parse(stdout || 'null'), stderr };
}

async function fakeApi() {
  const logins = new Map<string, { keyHash: string; hostname: string; polls: number; outcome: 'approved' | 'denied' }>();
  const validKeys = new Set<string>();
  const revoked: string[] = [];
  let nextOutcome: 'approved' | 'denied' = 'approved';
  const keyHash = (request: IncomingMessage) => sha256(String(request.headers.authorization).replace(/^Bearer /, ''));
  const server = createServer(async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }));
    };
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/developer/cli-logins') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      assert.match(input.keyPrefix, /^mdk_[A-Za-z0-9_-]{8}$/);
      const code = ['BCDF-GHJK', 'LMNP-QRST', 'VWXZ-BCDF'][logins.size];
      logins.set(code, { keyHash: input.keyHash, hostname: input.hostname, polls: 0, outcome: nextOutcome });
      return send(200, { code, verificationUrl: `http://console.test/cli-login?code=${code}`, interval: 0.05, expiresIn: 30 });
    }
    const status = url.pathname.match(/^\/api\/developer\/cli-logins\/([A-Z-]+)\/status$/);
    if (request.method === 'GET' && status) {
      const login = logins.get(status[1]);
      if (!login || login.keyHash !== keyHash(request)) return send(404, 'Login request not found.');
      login.polls += 1;
      if (login.polls < 2) return send(200, { status: 'pending' });
      if (login.outcome === 'approved') validKeys.add(login.keyHash);
      return send(200, { status: login.outcome });
    }
    if (!validKeys.has(keyHash(request))) return send(401, 'The developer key is invalid or was revoked.');
    if (request.method === 'GET' && url.pathname === '/api/developer/whoami') {
      return send(200, { account: '138****5678', key: { prefix: 'mdk_test', label: 'CLI · test' }, apps: [{ id: 'notes', name: 'Notes', online: true }], limits: { apps: 10 } });
    }
    if (request.method === 'DELETE' && url.pathname === '/api/developer/keys/current') {
      validKeys.delete(keyHash(request));
      revoked.push(keyHash(request));
      return send(200, { revoked: true });
    }
    send(404, 'Not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server, revoked, validKeys,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    deny: () => { nextOutcome = 'denied'; }
  };
}

test('login saves an approved key, replaces it on the next login, and logout revokes it', async t => {
  const api = await fakeApi();
  const configDir = mkdtempSync(join(tmpdir(), 'moben-login-'));
  t.after(() => { api.server.close(); rmSync(configDir, { recursive: true, force: true }); });
  const credentials = join(configDir, 'credentials.json');

  assert.equal((await moben(configDir, 'whoami')).data.error, 'Not logged in. Run moben login, or set MOBEN_DEVELOPER_KEY.');

  const first = await moben(configDir, 'login', '--api', `${api.url}/`);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /http:\/\/console\.test\/cli-login\?code=BCDF-GHJK/);
  assert.match(first.stderr, /shows the code BCDF-GHJK/);
  assert.match(first.stderr, /any computer or phone/);
  assert.doesNotMatch(first.stderr, /Press ENTER/, 'only prints the link when it cannot open a browser here');
  const saved = JSON.parse(readFileSync(credentials, 'utf8'));
  assert.match(saved.key, /^mdk_[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.apiUrl, api.url);
  assert.equal(first.data.keyPrefix, saved.key.slice(0, 12));
  assert.ok(!first.stderr.includes(saved.key) && !JSON.stringify(first.data).includes(saved.key), 'never prints the full key');
  assert.ok(api.validKeys.has(sha256(saved.key)));
  if (process.platform !== 'win32') assert.equal(statSync(credentials).mode & 0o777, 0o600);

  const who = await moben(configDir, 'whoami');
  assert.equal(who.code, 0, who.stderr);
  assert.equal(who.data.account, '138****5678');
  assert.equal(who.data.apiUrl, api.url);
  assert.deepEqual(who.data.apps, [{ id: 'notes', name: 'Notes', online: true }]);

  const second = await moben(configDir, 'login', '--api', api.url);
  assert.equal(second.code, 0, second.stderr);
  const replaced = JSON.parse(readFileSync(credentials, 'utf8'));
  assert.notEqual(replaced.key, saved.key);
  assert.deepEqual(api.revoked, [sha256(saved.key)], 'revokes the key this login replaces');

  api.deny();
  const denied = await moben(configDir, 'login', '--api', api.url);
  assert.equal(denied.code, 1);
  assert.equal(denied.data.error, 'The login was denied in the browser.');
  assert.equal(JSON.parse(readFileSync(credentials, 'utf8')).key, replaced.key, 'a denied login keeps the saved key');

  const out = await moben(configDir, 'logout');
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(api.revoked, [sha256(saved.key), sha256(replaced.key)]);
  assert.equal(existsSync(credentials), false);
  assert.equal((await moben(configDir, 'logout')).data.loggedIn, false);
});

test('connect uses the saved login and switches to the key of a newer login', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const configDir = mkdtempSync(join(tmpdir(), 'moben-connect-'));
  const previous = { config: process.env.MOBEN_CONFIG_DIR, key: process.env.MOBEN_DEVELOPER_KEY, url: process.env.MOBEN_APP_CONNECT_URL };
  process.env.MOBEN_CONFIG_DIR = configDir;
  delete process.env.MOBEN_DEVELOPER_KEY;
  delete process.env.MOBEN_APP_CONNECT_URL;
  t.after(() => {
    server.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const [name, value] of [['MOBEN_CONFIG_DIR', previous.config], ['MOBEN_DEVELOPER_KEY', previous.key], ['MOBEN_APP_CONNECT_URL', previous.url]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const app = defineApp({
    manifest: { manifestVersion: 1, id: 'hello', name: 'Hello', version: '0.1.0', entry: '/', permissions: [], agent: { instructions: 'Say hello.', tools: [] } },
    pages: { '/': ctx => page(ctx).paragraph('Hello').toString() }
  });
  assert.throws(() => connect(app, { logger: silent }), /run npx moben login/);

  writeCredentials({ key: 'mdk_first', apiUrl, savedAt: new Date().toISOString() });
  const auths: string[] = [];
  server.on('connection', (ws, request) => {
    auths.push(String(request.headers.authorization));
    ws.once('message', raw => {
      const message = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { appId: 'k7m3xq.hello', mountPath: '/apps/k7m3xq.hello', heartbeatSeconds: 30, limits: {} } }));
      if (auths.length === 1) {
        writeCredentials({ key: 'mdk_second', apiUrl, savedAt: new Date().toISOString() });
        ws.close(4001, 'revoked');
      }
    });
  });
  const connection = connect(app, { logger: silent });
  t.after(() => connection.close());
  await once(server, 'connection');
  await once(server, 'connection');
  assert.deepEqual(auths, ['Bearer mdk_first', 'Bearer mdk_second']);
  assert.notEqual(connection.status, 'stopped');
});
