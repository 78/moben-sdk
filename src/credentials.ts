import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://moben.cn';
const CONNECT_PATH = '/api/app-connect/ws';

/** Saved by `moben login`; apps on this computer use it when no key is configured. */
export type Credentials = { key: string; apiUrl: string; label?: string; savedAt: string };

export function configDir() {
  if (process.env.MOBEN_CONFIG_DIR) return process.env.MOBEN_CONFIG_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'moben');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'moben');
}

export const credentialsPath = () => join(configDir(), 'credentials.json');

export function readCredentials(): Credentials | null {
  try {
    const saved = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    return typeof saved?.key === 'string' && typeof saved?.apiUrl === 'string' ? saved : null;
  } catch {
    return null;
  }
}

export function writeCredentials(credentials: Credentials) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync keeps the mode of an existing file.
  chmodSync(path, 0o600);
}

export function removeCredentials() {
  rmSync(credentialsPath(), { force: true });
}

/** The cloud's HTTPS origin: MOBEN_API_URL, else derived from MOBEN_APP_CONNECT_URL, else moben.cn. */
export function apiBaseUrl() {
  if (process.env.MOBEN_API_URL) return process.env.MOBEN_API_URL.replace(/\/+$/, '');
  const connectUrl = process.env.MOBEN_APP_CONNECT_URL;
  if (connectUrl) return connectUrl.replace(/^ws/, 'http').replace(CONNECT_PATH, '').replace(/\/+$/, '');
  return DEFAULT_API_URL;
}

export const connectUrlFor = (apiUrl: string) => `${apiUrl.replace(/^http/, 'ws')}${CONNECT_PATH}`;
