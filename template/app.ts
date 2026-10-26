import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, createAppTranslator, defineApp, md, page } from '@moben-ai/app-sdk';

// Read MOBEN_DEVELOPER_KEY from .env when present (servers and CI; `moben login`
// needs no .env), so starting the app is the same command on every system.
try { process.loadEnvFile(join(__dirname, '.env')); } catch { /* use the shell environment */ }

// Notes stay on this computer, next to this file wherever the app is started from.
// Each device has its own notes, kept under its openId. For structured or
// growing data, use a local database such as SQLite with an open_id column.
type Note = { id: string; text: string; createdAt: string };
const DATA_DIR = join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'notes.json');

function loadAllNotes(): Record<string, Note[]> {
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function loadNotes(openId: string): Note[] {
  return loadAllNotes()[openId] ?? [];
}

function saveNotes(openId: string, notes: Note[]) {
  const all = loadAllNotes();
  all[openId] = notes;
  mkdirSync(DATA_DIR, { recursive: true });
  // Write a temporary file first so a crash never leaves half a file behind.
  writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(all, null, 2));
  renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
}

// English is required and is the fallback; devices set to Chinese get zh-CN.
const text = createAppTranslator({
  en: {
    title: 'Notes',
    empty: 'No notes yet. Hold the voice key and say "Add a note: buy milk".',
    count: 'Notes: {count}, newest first',
    delete: 'Delete',
    deleteConfirm: 'Delete this note?'
  },
  'zh-CN': {
    title: '笔记',
    empty: '还没有笔记。按住语音键说“记一下：买牛奶”。',
    count: '共 {count} 条，最新的在前',
    delete: '删除',
    deleteConfirm: '删除这条笔记？'
  }
});

const app = defineApp({
  manifest: {
    manifestVersion: 1,
    id: '__APP_ID__',
    name: 'Notes',
    description: 'Short notes kept on your computer.',
    version: '0.1.0',
    entry: '/',
    permissions: [],
    locales: {
      'zh-CN': { name: '笔记', description: '保存在你电脑上的简短笔记', tools: { add_note: '添加笔记', list_notes: '查看笔记' } }
    },
    agent: {
      instructions: 'Help the user keep short notes. Save notes with add_note and read them with list_notes.',
      tools: [
        {
          name: 'add_note',
          title: 'Add note',
          description: 'Save a short note for the user. Returns the saved note.',
          mutates: true,
          inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note text' } }, required: ['text'], additionalProperties: false }
        },
        {
          name: 'list_notes',
          title: 'List notes',
          description: 'Return all saved notes, newest first. Use it to answer questions about the notes.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    }
  },
  pages: {
    '/': ctx => {
      const notes = loadNotes(ctx.openId);
      const body = page(ctx, { title: text(ctx, 'title') }).heading(text(ctx, 'title'));
      if (!notes.length) return body.paragraph(text(ctx, 'empty')).toString();
      // list() inserts items verbatim, so escape the note text.
      return body
        .paragraph(text(ctx, 'count', { count: notes.length }))
        .list(notes.map(note => `${md.text(note.text)} ${md.action(text(ctx, 'delete'), ctx.url(`/notes/${note.id}/delete`), { confirm: text(ctx, 'deleteConfirm') })}`))
        .toString();
    }
  },
  actions: {
    '/notes/:id/delete': ctx => {
      saveNotes(ctx.openId, loadNotes(ctx.openId).filter(note => note.id !== ctx.params.id));
      return ctx.renderCurrentPage();
    }
  },
  tools: {
    add_note: (ctx, args) => {
      const note = { id: randomUUID().slice(0, 8), text: String(args.text).trim().slice(0, 500), createdAt: new Date().toISOString() };
      saveNotes(ctx.openId, [note, ...loadNotes(ctx.openId)]);
      return { result: note, uiEffects: [{ type: 'reload' }] };
    },
    list_notes: ctx => ({ result: { notes: loadNotes(ctx.openId) } })
  }
});

const connection = connect(app, { onStatus: status => console.log(`[app] ${status}`) });
process.once('SIGINT', () => { void connection.close().then(() => process.exit(0)); });
