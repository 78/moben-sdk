// Generated from api/src/app-sdk/action-sheet.ts. Do not edit here.
export type ActionSheetItem = { text: string; url: string; confirm?: string; selected?: boolean };
export type ActionSheet = { id: string; title: string; items: ActionSheetItem[] };
// The device enforces the same bounds; pages paginate before reaching them.
export const ACTION_SHEET_LIMITS = { declarationBytes: 4096, pageBytes: 128 * 1024, pageSheets: 200, items: 10 } as const;
const idPattern = /^[a-z0-9_-]{1,64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const plain = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(value) && !/[\uD800-\uDFFF]/u.test(value);
const exact = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function fail(): never { throw new Error('Invalid Action Sheet declaration'); }
const declarationOverhead = '<!-- moben:action-sheet  -->'.length;

export function serializeActionSheet(value: ActionSheet): string {
  const json = JSON.stringify(value).replace(/[<>]/g, c => c === '<' ? '\\u003c' : '\\u003e');
  if (Buffer.byteLength(json) > ACTION_SHEET_LIMITS.declarationBytes) fail();
  return `<!-- moben:action-sheet ${json} -->`;
}
export function actionSheetBytes(line: string): number { return Buffer.byteLength(line) - declarationOverhead; }

export function validateActionSheet(value: unknown, mountPath?: string): ActionSheet {
  if (!object(value) || !exact(value, ['id', 'title', 'items']) || typeof value.id !== 'string' || !idPattern.test(value.id) ||
      !plain(value.title) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > ACTION_SHEET_LIMITS.items) fail();
  const items = (value.items as unknown[]).map(item => {
    if (!object(item) || !exact(item, ['text', 'url', 'confirm', 'selected']) || !plain(item.text) || !item.text ||
        !plain(item.url) || item.confirm !== undefined && !plain(item.confirm) ||
        item.selected !== undefined && typeof item.selected !== 'boolean') return fail();
    const prefix = item.url.match(/^action:(\/apps\/[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)(?=\/|\?|$)/)?.[1];
    if (!prefix || mountPath && prefix !== mountPath || item.url.includes('#') || /[\s\\]/.test(item.url)) fail();
    return { text: item.text, url: item.url, ...(item.confirm !== undefined ? { confirm: item.confirm } : {}),
      ...(item.selected !== undefined ? { selected: item.selected } : {}) };
  });
  if (items.filter(item => item.selected).length > 1) fail();
  const sheet: ActionSheet = { id: value.id as string, title: value.title as string, items };
  serializeActionSheet(sheet);
  return sheet;
}

// Each declaration is a complete, self-contained menu registered in source order.
export class ActionSheetRegistry {
  private ids = new Set<string>();
  private bytes = 0;
  constructor(private mountPath: string, private validateUrl: (url: string) => void) {}
  register(json: string): string {
    if (Buffer.byteLength(json) > ACTION_SHEET_LIMITS.declarationBytes) fail();
    const sheet = validateActionSheet(JSON.parse(json), this.mountPath);
    if (this.ids.has(sheet.id) || this.ids.size >= ACTION_SHEET_LIMITS.pageSheets) fail();
    for (const item of sheet.items) this.validateUrl(item.url);
    const line = serializeActionSheet(sheet);
    const bytes = actionSheetBytes(line);
    if (this.bytes + bytes > ACTION_SHEET_LIMITS.pageBytes) fail();
    this.ids.add(sheet.id); this.bytes += bytes;
    return line;
  }
  has(id: string): boolean { return this.ids.has(id); }
}
