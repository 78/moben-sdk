// Shared helpers are owned by Moben Cloud and imported explicitly.
// Ordinary SDK tests/builds use the checked-in snapshot without another checkout.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'src/core');
const args = process.argv.slice(2);
const usage = 'Usage: npm run sync -- --source /path/to/moben-cloud/api/src/app-sdk';

if (!args.length) {
  if (!existsSync(join(target, 'index.ts'))) throw new Error(`Shared helper snapshot is missing. Restore src/core or run: ${usage}`);
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--source' || !args[1].trim()) throw new Error(usage);
const source = resolve(args[1]);
if (source === target || source.startsWith(target + sep)) throw new Error('Source must be the Cloud helper directory, outside src/core.');
const names = readdirSync(source).filter(name => name.endsWith('.ts') && !name.startsWith('.')).sort();
if (!names.includes('index.ts')) throw new Error('Source must contain the shared helper index.ts; existing snapshot was kept.');
// Read everything before replacing the snapshot so a bad path/read cannot erase it.
const files = names.map(name => [name, readFileSync(join(source, name), 'utf8')]);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const [name, text] of files) {
  writeFileSync(join(target, name), `// Generated from api/src/app-sdk/${name}. Do not edit here.\n${text}`);
}
