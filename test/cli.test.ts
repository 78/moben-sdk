import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(__dirname, '..');
const tsx = require.resolve('tsx/cli');

function moben(cwd: string, ...args: string[]) {
  return mobenWith({}, cwd, ...args);
}

function mobenWith(options: SpawnSyncOptions, cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [tsx, join(root, 'src/cli.ts'), ...args, '--json'], { ...options, cwd, encoding: 'utf8' });
  return { code: run.status, data: JSON.parse(run.stdout || 'null'), stderr: run.stderr };
}

test('init creates an app that validates and runs pages, actions and tools locally', t => {
  // Inside the package so the generated app resolves tsx from its node_modules.
  const work = mkdtempSync(join(root, 'test/.tmp-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const created = moben(work, 'app', 'init', 'My Notes');
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.data.id, 'my-notes');
  const dir = created.data.dir;
  const entry = join(dir, 'app.ts');
  writeFileSync(entry, readFileSync(entry, 'utf8').replace("'@moben-ai/app-sdk'", JSON.stringify(join(root, 'src/index.ts'))));
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['@moben-ai/app-sdk'], `^${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`);
  assert.equal(moben(work, 'app', 'init', 'My Notes').code, 2, 'refuses a non-empty directory');

  const report = moben(dir, 'app', 'validate');
  assert.equal(report.code, 0, JSON.stringify(report.data));
  assert.equal(report.data.ok, true);
  assert.deepEqual(report.data.pages.map((page: any) => `${page.route} ${page.locale}`), ['/ en', '/ zh-CN']);
  assert.deepEqual(report.data.warnings, []);

  const added = moben(dir, 'app', 'tool', 'add_note', '--args', '{"text":"Buy <milk>"}');
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.data.result.text, 'Buy <milk>');
  assert.deepEqual(added.data.uiEffects, [{ type: 'reload' }]);
  assert.equal(moben(dir, 'app', 'tool', 'add_note', '--args', '{}').data.error, 'Invalid tool arguments: missing text');

  const home = moben(dir, 'app', 'page', '/', '--locale', 'zh-CN');
  assert.equal(home.code, 0, home.stderr);
  assert.match(home.data.markdown, /^<!-- moben:page \{"version":1,"app":\{"id":"local\.my-notes","name":"笔记"\}/);
  assert.match(home.data.markdown, /Buy \\<milk\\>/);
  const deleteUrl = home.data.markdown.match(/\(action:(\S+\/delete)/)[1];

  const after = moben(dir, 'app', 'action', deleteUrl, '--page', '/');
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.data.markdown, /No notes yet/);
  assert.deepEqual(after.data.issues, []);

  writeFileSync(join(dir, 'args.json'), '{"text":"From a file"}');
  assert.equal(moben(dir, 'app', 'tool', 'add_note', '--args', '@args.json').data.result.text, 'From a file');
  assert.equal(mobenWith({ input: '{"text":"From stdin"}' }, dir, 'app', 'tool', 'add_note', '--args', '-').data.result.text, 'From stdin');
  const mangled = moben(dir, 'app', 'tool', 'add_note', '--args', '{text:Buy milk}');
  assert.equal(mangled.code, 2);
  assert.match(mangled.data.error, /--args @args\.json/);
});

test('page reports links and images the gateway removes', t => {
  const work = mkdtempSync(join(root, 'test/.tmp-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, 'app.ts'), `
import { defineApp, page } from ${JSON.stringify(join(root, 'src/index.ts'))};
export default defineApp({
  manifest: { manifestVersion: 1, id: 'links', name: 'Links', version: '0.1.0', entry: '/', permissions: [], agent: { instructions: 'Links.', tools: [] } },
  pages: { '/': ctx => page(ctx).raw('[Web](https://example.com) [Gone](action:' + ctx.url('/missing') + ') ![logo](https://example.com/logo.png)').toString() },
  tools: {}
});
`);
  const result = moben(work, 'app', 'page');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.data.markdown, /\nWeb Gone logo\n/);
  assert.equal(result.data.issues.length, 3);
  assert.match(result.data.issues[0], /https:\/\/example\.com is shown as plain text: Apps cannot open external URLs/);
  assert.match(result.data.issues[1], /does not match a registered action/);
  assert.match(result.data.issues[2], /Image https:\/\/example\.com\/logo\.png was removed/);

  const broken = moben(work, 'app', 'validate', '--entry', 'missing.ts');
  assert.equal(broken.code, 1);
  assert.equal(broken.data.ok, false);
  assert.match(broken.data.errors[0], /missing\.ts does not exist/);
});

test('voice records text or a file into a voice route from the given page', t => {
  const work = mkdtempSync(join(root, 'test/.tmp-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, 'recording.ogg'), Buffer.alloc(10000, 1));
  writeFileSync(join(work, 'app.ts'), `
import { defineApp, page } from ${JSON.stringify(join(root, 'src/index.ts'))};
const said: string[] = [];
export default defineApp({
  manifest: { manifestVersion: 1, id: 'memo', name: 'Memo', version: '0.1.0', entry: '/', permissions: [], agent: { instructions: 'Memo.', tools: [] } },
  pages: {
    '/': ctx => page(ctx, { voice: { mode: 'capture', url: ctx.url('/say') } }).list(said).toString(),
    '/plain': ctx => page(ctx).paragraph('No voice').toString()
  },
  voice: {
    '/say': { input: 'text', handler: async (ctx, speech) => { said.push((await speech.done).transcript); return ctx.renderCurrentPage(); } },
    '/memo': { input: 'audio', handler: async (_ctx, recording) => { let bytes = 0; for await (const chunk of recording.chunks) bytes += chunk.length; if (bytes !== 10000) throw new Error('lost audio'); } }
  },
  tools: {}
});
`);
  const spoken = moben(work, 'app', 'voice', '/say', '--text', 'Buy milk', '--page', '/');
  assert.equal(spoken.code, 0, spoken.stderr);
  assert.equal(spoken.data.accepted, false);
  assert.match(spoken.data.page.markdown, /\n- Buy milk\n/);
  assert.deepEqual(spoken.data.issues, []);

  const memo = moben(work, 'app', 'voice', '/memo', '--file', 'recording.ogg', '--page', '/plain');
  assert.equal(memo.code, 0, memo.stderr);
  assert.equal(memo.data.accepted, true);
  assert.match(memo.data.issues[0], /\/plain does not declare voice/);

  assert.equal(moben(work, 'app', 'voice', '/say').code, 2, 'needs --text or --file');
  assert.match(moben(work, 'app', 'voice', '/memo', '--text', 'hi').data.error, /audio route; pass a recording with --file/);
});

test('action checks the source page link and initialFocus; pages get the device time zone', t => {
  const work = mkdtempSync(join(root, 'test/.tmp-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, 'app.ts'), `
import { defineApp, md, page } from ${JSON.stringify(join(root, 'src/index.ts'))};
export default defineApp({
  manifest: { manifestVersion: 1, id: 'items', name: 'Items', version: '0.1.0', entry: '/', permissions: [], agent: { instructions: 'Items.', tools: [] } },
  pages: {
    '/': ctx => page(ctx).paragraph(ctx.timezone).list(['a', 'b'].map(id => md.action('Done ' + id, ctx.url('/items/' + id + '/done')))).toString(),
    '/other': ctx => page(ctx).paragraph('No links').toString(),
    '/items/:id': ctx => page(ctx).paragraph(ctx.params.id).toString()
  },
  actions: {
    '/items/:id/done': ctx => ctx.renderPage('/', { initialFocus: 'action:' + ctx.url('/items/b/done') }),
    '/items/:id/lost': ctx => ctx.renderPage('/', { initialFocus: ctx.url('/nowhere') })
  }
});
`);
  const linked = moben(work, 'app', 'action', '/items/a/done', '--page', '/');
  assert.equal(linked.code, 0, linked.stderr);
  assert.deepEqual(linked.data.issues, []);

  const unlinked = moben(work, 'app', 'action', '/items/a/done', '--page', '/other');
  assert.match(unlinked.data.issues[0], /\/other has no link to action:\/apps\/local\.items\/items\/a\/done/);

  const lost = moben(work, 'app', 'action', '/items/a/lost', '--page', '/other');
  assert.match(lost.data.issues.at(-1), /initialFocus \/apps\/local\.items\/nowhere matches no link/);

  assert.match(moben(work, 'app', 'page', '--timezone', 'Asia/Tokyo').data.markdown, /Asia\/Tokyo/);
  assert.equal(moben(work, 'app', 'page', '--timezone', 'Mars/Base').code, 2);

  const text = spawnSync(process.execPath, [tsx, join(root, 'src/cli.ts'), 'app', 'validate'], { cwd: work, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /skipped page \/items\/:id \(has parameters\): render it with moben app page \/items\/<id>/);

  // The pre-0.5 top-level form still works and points to the new one.
  const legacy = moben(work, 'page', '--timezone', 'Asia/Tokyo');
  assert.equal(legacy.code, 0);
  assert.match(legacy.data.markdown, /Asia\/Tokyo/);
  assert.match(legacy.stderr, /"moben page" is now "moben app page"/);
  assert.equal(moben(work, 'app', 'nope').code, 2);
});


test('CLI --version matches the installable package version', () => {
  const run = spawnSync(process.execPath, [tsx, join(root, 'src/cli.ts'), '--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
});

test('loads a CommonJS TypeScript entry that imports the SDK', t => {
  const work = mkdtempSync(join(root, 'test/.tmp-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  // Without "type": "module", Node and tsx compile the entry as CommonJS. Its
  // own import of the SDK must not be evaluated through require() as well, or
  // Node fails with ERR_REQUIRE_CYCLE_MODULE before any page is rendered.
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'commonjs-app', private: true }));
  writeFileSync(join(work, 'app.ts'), `
import { defineApp, page } from ${JSON.stringify(join(root, 'src/index.ts'))};
export const app = defineApp({
  manifest: { manifestVersion: 1, id: 'commonjs-app', name: 'CommonJS', version: '0.1.0', entry: '/', permissions: [], agent: { instructions: 'CommonJS entry.', tools: [] } },
  pages: { '/': ctx => page(ctx).paragraph('CommonJS entry').toString() }
});
`);
  const result = moben(work, 'app', 'page');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.data.issues, []);
  assert.match(result.data.markdown, /CommonJS entry/);
});
