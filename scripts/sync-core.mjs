// The page/manifest helpers are shared with built-in apps: api/src/app-sdk is
// the single source, copied here before every build so the two never drift.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '../../api/src/app-sdk');
const target = join(root, 'src/core');

// The standalone public SDK keeps a checked-in snapshot of the shared helpers.
// In the product monorepo the upstream source is present and remains authoritative.
if (!existsSync(source)) {
  if (!existsSync(join(target, 'index.ts'))) throw new Error('Shared SDK helpers are missing. Restore src/core from the repository.');
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter(file => file.endsWith('.ts') && !file.startsWith('.'))) {
  const text = readFileSync(join(source, name), 'utf8');
  writeFileSync(join(target, name), `// Generated from api/src/app-sdk/${name}. Do not edit here.\n${text}`);
}
