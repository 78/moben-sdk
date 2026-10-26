#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { JsonObject } from './core';
import type { AppDefinition } from './types';
import { LOCAL_APP_ID } from './core/remote-hello';
import { SDK_VERSION } from './connect';
import { apiBaseUrl, credentialsPath, readCredentials, removeCredentials, writeCredentials } from './credentials';
import { findEntry, loadApps, LocalApp, resolveFromApp, validateApp } from './local';
import { DEVICE_HELP, runDeviceCommand } from './device-cli';
import { DeviceError } from './device';

const HELP = `Usage: moben <command> [options]

Account:
  login                 Authorize this computer in the browser and save a developer key
  logout                Revoke the saved key and remove it from this computer
  whoami                Show the account, key and apps in use

Devices (local USB; run moben device --help):
  device list           List serial ports without opening them
  device doctor         Verify identity, connection and power settings
  device <command>      hello, status, tasks, open, key, text, snapshot, logs or screenshot

Apps:
  app init <dir>        Create a new app in <dir>
  app dev               Run the app and restart it when files change
  app validate          Check the manifest and render every page without parameters
  app page [path]       Render a page as a device receives it (default: the entry page)
  app action <path>     Run an action and print the page it returns
  app tool <name>       Call a tool and print its result
  app voice <path>      Record into a voice route (--file for audio, --text for text) and print the result

app page, app action, app tool, app voice and app validate run your code locally without connecting.

Options:
  --api <url>       Moben server for login and whoami (default: MOBEN_API_URL or https://moben.cn)
  --entry <file>    App entry (default: app.ts, src/app.ts, index.ts, app.js, index.js or package.json "main")
  --app <id>        Which app to use when the entry connects several
  --locale <tag>    Device language: en (default) or zh-CN
  --timezone <tz>   Device time zone, such as Asia/Shanghai (default: this computer's)
  --city <name>     Device city, for apps with the location permission
  --args <json>     Tool arguments as a JSON object; @file.json reads a file, - reads stdin
  --page <path>     Page the device is showing (action: where the link was; tool: the open page; voice: the recording page)
  --file <file>     voice: Ogg/Opus recording for an audio route
  --text <words>    voice: what the user said, for a text route
  --id <id>         App ID for init (default: derived from <dir>)
  --json            Print JSON for scripts and coding agents
  -h, --help        Show this help
  -v, --version     Show the SDK version
`;

type Flags = { api?: string; entry?: string; app?: string; locale?: string; timezone?: string; city?: string; args?: string; page?: string; id?: string; json?: boolean; file?: string; text?: string };

class UsageError extends Error {}
let streamingJson = false;

function print(flags: Flags, data: unknown, text: string) {
  process.stdout.write(flags.json ? `${JSON.stringify(data, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`);
}

function printIssues(issues: string[]) {
  for (const issue of issues) process.stderr.write(`warning: ${issue}\n`);
}

async function selectApp(flags: Flags): Promise<AppDefinition> {
  const apps = await loadApps(findEntry(flags.entry));
  if (flags.app) {
    const app = apps.find(item => item.manifest.id === flags.app);
    if (!app) throw new UsageError(`No app with id ${flags.app}. Found: ${apps.map(item => item.manifest.id).join(', ')}.`);
    return app;
  }
  if (apps.length > 1) throw new UsageError(`The entry defines several apps; pick one with --app: ${apps.map(item => item.manifest.id).join(', ')}.`);
  return apps[0];
}

function deviceOptions(flags: Flags) {
  if (flags.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: flags.timezone }); } catch { throw new UsageError(`Unknown time zone ${flags.timezone}; use an IANA name such as Asia/Shanghai.`); }
  }
  return { timezone: flags.timezone, city: flags.city };
}

const localApp = async (flags: Flags) => new LocalApp(await selectApp(flags), { locale: flags.locale, ...deviceOptions(flags) });

async function commandPage(flags: Flags, path?: string) {
  const app = await localApp(flags);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Stopped following the page.'));
  process.once('SIGINT', stop);
  try {
    const page = await app.page(path, { signal: controller.signal, ...(flags.json ? {} : { onText: (text: string) => process.stdout.write(text) }) });
    if (flags.json) print(flags, page, page.markdown);
    else {
      if (!page.markdown.endsWith('\n')) process.stdout.write('\n');
      printIssues(page.issues);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (!flags.json) process.stdout.write('\n');
  } finally {
    process.off('SIGINT', stop);
  }
  return 0;
}

async function commandAction(flags: Flags, path?: string) {
  if (!path) throw new UsageError('Usage: moben app action <path> [--page <path>]');
  const page = await (await localApp(flags)).action(path, flags.page);
  if (!flags.json) printIssues(page.issues);
  print(flags, page, page.markdown);
  return 0;
}

async function commandTool(flags: Flags, name?: string) {
  if (!name) throw new UsageError('Usage: moben app tool <name> [--args <json>] [--page <path>]');
  let args: JsonObject = {};
  if (flags.args !== undefined) {
    // cmd.exe and Windows PowerShell 5.1 mangle quotes in JSON arguments; a file or stdin avoids quoting.
    const source = flags.args === '-' ? readFileSync(0, 'utf8') : flags.args.startsWith('@') ? readFileSync(resolve(flags.args.slice(1)), 'utf8') : flags.args;
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { parsed = undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError('--args must be a JSON object, such as \'{"text":"hello"}\'. If your shell changes the quotes, put the JSON in a file and pass --args @args.json, or pipe it with --args -.');
    }
    args = parsed as JsonObject;
  }
  const output = await (await localApp(flags)).tool(name, args, flags.page);
  if (!flags.json) printIssues(output.issues);
  const text = [JSON.stringify(output.result, null, 2), ...output.uiEffects.map(effect => `uiEffect: ${JSON.stringify(effect)}`)].join('\n');
  print(flags, output, text);
  return output.issues.some(issue => issue.includes('rejects')) ? 1 : 0;
}

async function commandVoice(flags: Flags, path?: string) {
  if (!path || (flags.file === undefined) === (flags.text === undefined)) throw new UsageError('Usage: moben app voice <path> (--file <recording.ogg> | --text <words>) [--page <path>]');
  const audio = flags.file === undefined ? undefined : readFileSync(resolve(flags.file));
  const result = await (await localApp(flags)).voice(path, { page: flags.page, audio, text: flags.text });
  if (!flags.json) printIssues([...result.issues, ...(result.page?.issues ?? [])]);
  print(flags, result, result.accepted ? `Accepted in ${result.elapsedMs} ms: the app shows the result on its page stream.` : result.page!.markdown);
  return 0;
}

async function commandValidate(flags: Flags) {
  let app: AppDefinition;
  try {
    app = await selectApp(flags);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const message = (error as Error).message;
    print(flags, { ok: false, errors: [message], warnings: [] }, `✖ ${message}`);
    return 1;
  }
  const report = await validateApp(app, deviceOptions(flags));
  const ok = report.errors.length === 0;
  const lines = [
    ...report.pages.map(page => `✓ page ${page.route} (${page.locale})${page.title ? ` "${page.title}"` : ''} ${page.bytes} B, ${page.elapsedMs} ms`),
    ...report.skipped.map(route => `skipped page ${route} (has parameters): render it with moben app page ${route.replace(/:([A-Za-z0-9_]+)/g, '<$1>')}`),
    ...report.warnings.map(warning => `⚠ ${warning}`),
    ...report.errors.map(error => `✖ ${error}`),
    ok ? `${report.app}: manifest valid${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ''}` : `${report.app}: ${report.errors.length} error(s)`
  ];
  print(flags, { ok, ...report }, lines.join('\n'));
  return ok ? 0 : 1;
}

function commandDev(flags: Flags) {
  const entry = findEntry(flags.entry);
  const tsx = resolveFromApp(entry, 'tsx/cli');
  const args = tsx ? [tsx, 'watch', '--clear-screen=false', entry] : ['--watch', entry];
  if (!tsx && /\.[cm]?tsx?$/.test(entry)) throw new UsageError('Running a TypeScript entry needs tsx in the app: run npm install --save-dev tsx');
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  return new Promise<number>(done => child.on('exit', code => done(code ?? 0)));
}

type ApiError = Error & { status?: number };

async function callApi(apiUrl: string, method: string, path: string, options: { key?: string; body?: unknown; locale?: string } = {}) {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'Accept-Language': options.locale ?? 'en',
        ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`Cannot reach ${apiUrl}: ${(error as Error).message}`);
  }
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: any; message?: string } | null;
  if (!response.ok || !payload?.success) throw Object.assign(new Error(payload?.message || `HTTP ${response.status}`), { status: response.status }) as ApiError;
  return payload.data;
}

// Over SSH or on a headless Linux server the browser would open on the wrong machine, or not at all.
function canOpenBrowser() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function openBrowser(url: string) {
  // rundll32 avoids cmd.exe, which would treat & in the URL as a command separator.
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => process.stderr.write('Could not open a browser; open the link manually.\n'))
    .unref();
}

async function commandLogin(flags: Flags) {
  const apiUrl = (flags.api ?? apiBaseUrl()).replace(/\/+$/, '');
  // The key never leaves this computer: the cloud stores its digest once the
  // account owner approves, and polling proves we hold it.
  const key = `mdk_${randomBytes(32).toString('base64url')}`;
  const host = hostname().replace(/\.local$/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'computer';
  const login = await callApi(apiUrl, 'POST', '/api/developer/cli-logins', {
    body: { keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 12), hostname: host }
  });
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !flags.json && canOpenBrowser());
  process.stderr.write(`Open this link to let Moben CLI on "${host}" use your developer account:\n\n  ${login.verificationUrl}\n\n` +
    `Check that the page shows the code ${login.code}. ` +
    (interactive ? 'Press ENTER to open it in the browser.\n' : 'You can open it on any computer or phone signed in to Moben.\nWaiting for approval…\n'));
  const input = interactive ? createInterface({ input: process.stdin }) : null;
  input?.once('line', () => openBrowser(login.verificationUrl));
  try {
    const deadline = Date.now() + login.expiresIn * 1000;
    for (;;) {
      await sleep(login.interval * 1000);
      if (Date.now() > deadline) throw new Error('The login link expired. Run moben login again.');
      let status: string;
      try {
        ({ status } = await callApi(apiUrl, 'GET', `/api/developer/cli-logins/${login.code}/status`, { key }));
      } catch (error) {
        // Keep waiting through network hiccups; the server answers with a status otherwise.
        if ((error as ApiError).status === undefined) continue;
        throw error;
      }
      if (status === 'approved') break;
      if (status === 'denied') throw new Error('The login was denied in the browser.');
      if (status === 'expired') throw new Error('The login link expired. Run moben login again.');
    }
  } finally {
    input?.close();
  }
  const previous = readCredentials();
  if (previous && previous.apiUrl === apiUrl && previous.key !== key) {
    // One key per computer: revoke the one this login replaces.
    await callApi(apiUrl, 'DELETE', '/api/developer/keys/current', { key: previous.key }).catch(() => {});
  }
  writeCredentials({ key, apiUrl, label: `CLI · ${host}`, savedAt: new Date().toISOString() });
  if (process.env.MOBEN_DEVELOPER_KEY) process.stderr.write('note: MOBEN_DEVELOPER_KEY is set and takes precedence over the saved key.\n');
  print(flags, { ok: true, apiUrl, keyPrefix: key.slice(0, 12), credentials: credentialsPath() },
    `Logged in. Apps on this computer now use the key ${key.slice(0, 12)}… saved in ${credentialsPath()}.`);
  return 0;
}

async function commandLogout(flags: Flags) {
  const saved = readCredentials();
  if (!saved) {
    print(flags, { ok: true, loggedIn: false }, 'Not logged in.');
    return 0;
  }
  try {
    await callApi(saved.apiUrl, 'DELETE', '/api/developer/keys/current', { key: saved.key });
  } catch (error) {
    // A key revoked in Console is already unusable; anything else keeps the file.
    if ((error as ApiError).status !== 401) throw new Error(`Could not revoke the key: ${(error as Error).message}. Nothing was removed; try again or revoke it in Console.`);
  }
  removeCredentials();
  print(flags, { ok: true, keyPrefix: saved.key.slice(0, 12) }, `Logged out. The key ${saved.key.slice(0, 12)}… was revoked and removed from this computer.`);
  return 0;
}

async function commandWhoami(flags: Flags) {
  const envKey = process.env.MOBEN_DEVELOPER_KEY;
  const saved = envKey ? null : readCredentials();
  const key = envKey || saved?.key;
  if (!key) throw new Error('Not logged in. Run moben login, or set MOBEN_DEVELOPER_KEY.');
  const apiUrl = (flags.api ?? saved?.apiUrl ?? apiBaseUrl()).replace(/\/+$/, '');
  const who = await callApi(apiUrl, 'GET', '/api/developer/whoami', { key, locale: flags.locale });
  const source = envKey ? 'MOBEN_DEVELOPER_KEY' : credentialsPath();
  const apps = who.apps.map((app: { id: string; name: string; online: boolean }) => `  ${app.id}  ${app.name}  ${app.online ? 'online' : 'offline'}`);
  print(flags, { ok: true, apiUrl, source, ...who }, [
    `Account: ${who.account ?? 'unknown'} on ${apiUrl}`,
    `Key: ${who.key.prefix}…${who.key.label ? ` (${who.key.label})` : ''} from ${source}`,
    `Apps (${who.apps.length}/${who.limits.apps}):${apps.length ? `\n${apps.join('\n')}` : ' none yet; they appear when they first connect.'}`
  ].join('\n'));
  return 0;
}

function commandInit(flags: Flags, dir?: string) {
  if (!dir) throw new UsageError('Usage: moben app init <dir> [--id <id>]');
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new UsageError(`${dir} is not empty.`);
  const id = flags.id ?? basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 31);
  if (!LOCAL_APP_ID.test(id)) throw new UsageError(`Cannot use "${id}" as the app ID; pass --id with 2-31 lowercase letters, digits or hyphens, starting with a letter.`);
  const template = join(__dirname, '..', 'template');
  const files: Record<string, string> = {
    'app.ts': readFileSync(join(template, 'app.ts'), 'utf8').replace(/__APP_ID__/g, id),
    'AGENTS.md': readFileSync(join(template, 'AGENTS.md'), 'utf8'),
    '.env.example': '# Not needed where you ran `npx moben login`.\n# In containers or CI, securely set MOBEN_DEVELOPER_KEY from the saved credentials key field.\n# Default: %APPDATA%\\moben\\credentials.json (Windows), ~/.config/moben/credentials.json (macOS/Linux).\n# MOBEN_CONFIG_DIR overrides the directory; macOS/Linux also respect XDG_CONFIG_HOME.\n# Use the path reported by moben login/whoami. Never print or commit credentials.\n# MOBEN_DEVELOPER_KEY=mdk_...\n',
    // npm drops .gitignore files from packages, so this one is written here.
    '.gitignore': 'node_modules/\n.env\ndata/\n',
    'package.json': `${JSON.stringify({
      name: id, version: '0.1.0', private: true, engines: { node: '>=20.12' },
      scripts: { start: 'tsx app.ts', dev: 'moben app dev', check: 'moben app validate' },
      dependencies: { '@moben-ai/app-sdk': `^${SDK_VERSION}` },
      devDependencies: { tsx: '^4.19.0' }
    }, null, 2)}\n`
  };
  mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(target, name), content);
  const shown = relative(process.cwd(), target) || '.';
  print(flags, { dir: target, id, files: Object.keys(files) }, `Created app "${id}" in ${shown}

Next steps:
  cd ${shown}
  npm install
  npx moben login         # authorize this computer in the browser
  npm run check           # moben app validate: render pages locally
  npm run dev             # connect and restart on changes`);
  return 0;
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      api: { type: 'string' }, entry: { type: 'string' }, app: { type: 'string' }, locale: { type: 'string' }, timezone: { type: 'string' }, city: { type: 'string' },
      args: { type: 'string' }, page: { type: 'string' }, id: { type: 'string' }, json: { type: 'boolean' }, file: { type: 'string' }, text: { type: 'string' },
      port: { type: 'string' }, timeout: { type: 'string' }, event: { type: 'string' }, output: { type: 'string' }, format: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
    }
  });
  if (values.version) {
    process.stdout.write(`${SDK_VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (command === 'device') {
    streamingJson = rest[0] === 'logs';
    if (values.help || !rest[0]) {
      process.stdout.write(DEVICE_HELP);
      return values.help ? 0 : 1;
    }
    const allowed = new Set(['port', 'timeout', 'event', 'output', 'format', 'json', 'help', 'version']);
    if (Object.keys(values).some(key => !allowed.has(key))) throw new DeviceError('invalid_argument', 'Unexpected option for a device command. Run moben device --help.');
    const controller = new AbortController();
    let stopped = 0;
    const interrupt = () => { stopped = 130; controller.abort(); };
    const terminate = () => { stopped = 143; controller.abort(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
      const code = await runDeviceCommand(rest[0], rest.slice(1), values, undefined, controller.signal);
      return stopped || code;
    }
    catch (error) { if (stopped) return stopped; throw error; }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
  if (values.help || !command || (command === 'app' && !rest[0])) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const flags = values as Flags;
  switch (command) {
    case 'login': return commandLogin(flags);
    case 'logout': return commandLogout(flags);
    case 'whoami': return commandWhoami(flags);
    case 'app': return appCommand(flags, rest[0], rest[1]);
  }
  // Releases before 0.5 had the app commands at the top level.
  if (APP_COMMANDS.has(command)) {
    process.stderr.write(`note: "moben ${command}" is now "moben app ${command}"; the short form will be removed in a future release.\n`);
    return appCommand(flags, command, rest[0]);
  }
  throw new UsageError(`Unknown command ${command}. Run moben --help.`);
}

const APP_COMMANDS = new Set(['init', 'dev', 'validate', 'page', 'action', 'tool']);

function appCommand(flags: Flags, command: string, target?: string) {
  switch (command) {
    case 'init': return commandInit(flags, target);
    case 'dev': return commandDev(flags);
    case 'validate': return commandValidate(flags);
    case 'page': return commandPage(flags, target);
    case 'action': return commandAction(flags, target);
    case 'tool': return commandTool(flags, target);
    case 'voice': return commandVoice(flags, target);
    default: throw new UsageError(`Unknown command app ${command}. Run moben --help.`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  const json = process.argv.includes('--json');
  const message = error instanceof Error ? error.message : String(error);
  const parseError = typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  if (json) process.stdout.write(`${JSON.stringify({ ...(streamingJson ? { type: 'error' } : {}), ok: false, error: message, ...(error instanceof DeviceError ? { code: error.code, ...(error.deviceCode ? { deviceCode: error.deviceCode } : {}) } : parseError ? { code: 'invalid_argument' } : {}) }, null, streamingJson ? undefined : 2)}\n`);
  else process.stderr.write(`${error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? '' : 'error: '}${message}\n`);
  process.exitCode = error instanceof UsageError || parseError || error instanceof DeviceError && error.code === 'invalid_argument' ? 2 : 1;
});
