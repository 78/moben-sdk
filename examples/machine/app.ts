import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { connect, createAppTranslator, defineApp, lineIcon, md, page, resolveAppLocale, type AppContext } from '@moben-ai/app-sdk';

// Read MOBEN_DEVELOPER_KEY from .env when present (servers and CI; `moben login`
// needs no .env), so starting the app is the same command on every system.
try { process.loadEnvFile(join(__dirname, '.env')); } catch { /* use the shell environment */ }

const HOSTNAME = os.hostname().replace(/\.local$/, '');

// English is required and is the fallback; devices set to Chinese get zh-CN.
const text = createAppTranslator({
  en: {
    title: 'Computer Status',
    system: 'System: {name} · {arch}',
    cpu: 'Processor: {model} · {cores} cores',
    memory: 'Memory: {size} GB',
    disk: 'Disk: {free} GB free of {total} GB',
    diskUnknown: 'Disk: unavailable',
    cpuUsage: 'CPU usage: {percent}%',
    cpuSampling: 'CPU usage: sampling…',
    uptime: 'Uptime: {duration}',
    lan: 'LAN IP: {address}',
    lanNone: 'LAN IP: not connected',
    updated: 'Updated at {time}, refreshes every minute',
    days: '{days} d {hours} h',
    hours: '{hours} h {minutes} min',
    minutes: '{minutes} min'
  },
  'zh-CN': {
    title: '电脑状态',
    system: '系统：{name} · {arch}',
    cpu: '处理器：{model} · {cores} 核',
    memory: '内存：{size} GB',
    disk: '磁盘：可用 {free} GB / 共 {total} GB',
    diskUnknown: '磁盘：无法读取',
    cpuUsage: 'CPU 占用：{percent}%',
    cpuSampling: 'CPU 占用：采样中',
    uptime: '已运行：{duration}',
    lan: '局域网 IP：{address}',
    lanNone: '局域网 IP：未连接',
    updated: '更新于 {time}，每分钟自动刷新',
    days: '{days} 天 {hours} 小时',
    hours: '{hours} 小时 {minutes} 分钟',
    minutes: '{minutes} 分钟'
  }
});

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { idle: sum.idle + idle, total: sum.total + user + nice + sys + idle + irq };
  }, { idle: 0, total: 0 });
}

// CPU usage is the busy share between two samples, so keep a rolling sample.
let lastCpu = cpuTimes();
let cpuPercent: number | null = null;
setInterval(() => {
  const now = cpuTimes();
  const total = now.total - lastCpu.total;
  if (total > 0) cpuPercent = Math.round(100 * (1 - (now.idle - lastCpu.idle) / total));
  lastCpu = now;
}, 5000).unref();

// Friendly OS names come from files every install has; fall back to the kernel version.
function systemName() {
  try {
    if (process.platform === 'darwin') {
      const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
      const version = plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (version) return `macOS ${version}`;
    }
    if (process.platform === 'linux') {
      const name = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1];
      if (name) return name;
    }
  } catch { /* use the kernel version below */ }
  return process.platform === 'win32' ? os.version() : `${os.type()} ${os.release()}`;
}

// One decimal for small sizes, whole numbers from 100 GB so lines fit the screen.
function toGb(bytes: number) {
  const value = bytes / 1024 ** 3;
  return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

// The home directory sits on the disk that holds the user's files on every platform.
function homeDisk() {
  try {
    const stats = statfsSync(os.homedir());
    return { freeGb: toGb(stats.bavail * stats.bsize), totalGb: toGb(stats.blocks * stats.bsize) };
  } catch {
    return null;
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .flatMap(item => item && item.family === 'IPv4' && !item.internal ? [item.address] : []);
}

// Tool results stay language-neutral; the assistant answers in the user's language.
function machineInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    system: systemName(),
    arch: os.arch(),
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length, usagePercent: cpuPercent },
    memoryGb: toGb(os.totalmem()),
    disk: homeDisk(),
    uptimeSeconds: Math.round(os.uptime()),
    lanAddresses: lanAddresses()
  };
}

function duration(ctx: AppContext, seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (days) return text(ctx, 'days', { days, hours });
  return hours ? text(ctx, 'hours', { hours, minutes }) : text(ctx, 'minutes', { minutes });
}

// Show the time in the device's language and time zone, not the computer's.
function clock(ctx: AppContext) {
  const options = { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const;
  const locale = resolveAppLocale(ctx) === 'zh-CN' ? 'zh-CN' : 'en-GB';
  try { return new Date().toLocaleTimeString(locale, options); }
  catch { return new Date().toLocaleTimeString(locale, { ...options, timeZone: undefined }); }
}

const app = defineApp({
  manifest: {
    manifestVersion: 1,
    // Unique within your account; the cloud adds your developer namespace.
    id: 'computer-status',
    name: 'Computer Status',
    version: '0.1.0',
    description: `Configuration and status of ${HOSTNAME}`,
    icon: lineIcon('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
    entry: '/',
    permissions: [],
    // Launcher name, welcome text and tool titles follow the device language.
    locales: {
      'zh-CN': {
        name: '电脑状态',
        description: `${HOSTNAME} 的配置和运行状态`,
        welcome: '可以问“我的电脑是什么配置”“磁盘还剩多少空间”。',
        tools: { get_computer_status: '查看电脑状态' }
      }
    },
    agent: {
      instructions: `This is the user's own computer, ${HOSTNAME}. Call get_computer_status for fresh data before answering any question about its configuration or status.`,
      externalInstructions: `Look up the configuration (OS, processor, memory, disk) and live status of the user's computer ${HOSTNAME}.`,
      welcome: 'Ask "What are my computer\'s specs?" or "How much disk space is left?"',
      tools: [
        {
          name: 'get_computer_status',
          title: 'Check computer status',
          description: `Get the current configuration and live status of the user's computer ${HOSTNAME}: OS, processor, memory, free disk space, CPU usage, uptime and LAN IP.`,
          external: true,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    }
  },
  pages: {
    '/': ctx => {
      const info = machineInfo();
      const lines = [
        text(ctx, 'system', { name: info.system, arch: info.arch }),
        text(ctx, 'cpu', { model: info.cpu.model, cores: info.cpu.cores }),
        text(ctx, 'memory', { size: info.memoryGb }),
        info.disk ? text(ctx, 'disk', { free: info.disk.freeGb, total: info.disk.totalGb }) : text(ctx, 'diskUnknown'),
        info.cpu.usagePercent === null ? text(ctx, 'cpuSampling') : text(ctx, 'cpuUsage', { percent: info.cpu.usagePercent }),
        text(ctx, 'uptime', { duration: duration(ctx, info.uptimeSeconds) }),
        info.lanAddresses[0] ? text(ctx, 'lan', { address: info.lanAddresses[0] }) : text(ctx, 'lanNone')
      ];
      // list() inserts items verbatim, so escape each translated line.
      return page(ctx, { title: text(ctx, 'title'), refresh: { intervalSeconds: 60 } })
        .heading(HOSTNAME)
        .list(lines.map(line => md.text(line)))
        .paragraph(text(ctx, 'updated', { time: clock(ctx) }))
        .toString();
    }
  },
  tools: {
    get_computer_status: () => ({ result: machineInfo() })
  }
});

const connection = connect(app, { onStatus: status => console.log(`[machine] ${status}`) });
process.once('SIGINT', () => { void connection.close().then(() => process.exit(0)); });
