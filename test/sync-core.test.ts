import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

function fixture(t: TestContext) {
  const workspace = mkdtempSync(join(tmpdir(), 'moben-sdk-sync-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'packages/sdk');
  const core = join(root, 'src/core');
  const source = join(workspace, 'api/src/app-sdk');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(core, { recursive: true });
  mkdirSync(source, { recursive: true });
  copyFileSync(resolve(__dirname, '../scripts/sync-core.mjs'), join(root, 'scripts/sync-core.mjs'));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/sync-core.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  return { core, source, run };
}

test('ordinary builds use the snapshot even with a Cloud checkout nearby', t => {
  const { core, source, run } = fixture(t);
  writeFileSync(join(core, 'index.ts'), 'export const snapshot = true;');
  writeFileSync(join(source, 'index.ts'), 'export const upstream = true;');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(core, 'index.ts'), 'utf8'), 'export const snapshot = true;');
});

test('explicit import refreshes helpers, removes stale files and ignores metadata', t => {
  const { core, source, run } = fixture(t);
  writeFileSync(join(core, 'stale.ts'), 'old');
  writeFileSync(join(source, 'index.ts'), 'export * from "./types";');
  writeFileSync(join(source, 'types.ts'), 'export type Value = string;');
  writeFileSync(join(source, '._types.ts'), 'filesystem metadata');
  writeFileSync(join(source, 'notes.md'), 'not a helper');
  const result = run('--source', source);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(core).sort(), ['index.ts', 'types.ts']);
  assert.equal(readFileSync(join(core, 'types.ts'), 'utf8'), '// Generated from api/src/app-sdk/types.ts. Do not edit here.\nexport type Value = string;');
});

test('bad import sources leave the existing snapshot intact', t => {
  const { core, source, run } = fixture(t);
  writeFileSync(join(core, 'index.ts'), 'keep this snapshot');
  for (const args of [['--source', join(source, 'missing')], ['--source', source], ['--source', core], ['--wrong', source]]) {
    assert.notEqual(run(...args).status, 0);
    assert.equal(readFileSync(join(core, 'index.ts'), 'utf8'), 'keep this snapshot');
  }
});

test('a missing checked-in snapshot fails without importing implicitly', t => {
  const { core, source, run } = fixture(t);
  writeFileSync(join(source, 'index.ts'), 'upstream');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /snapshot is missing/);
  assert.equal(existsSync(join(core, 'index.ts')), false);
});
