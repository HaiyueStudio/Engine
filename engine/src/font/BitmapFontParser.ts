import { BitmapFontChar, BitmapFontData, bitmapKerningKey, createBitmapFontData } from './BitmapFontData';
import { requiredItemAt } from '../math/arrayAccess';

// ── AngelCode .fnt text-format parser ────────────────────────────────────────

function tokenize(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Split on spaces but keep quoted strings intact
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    result[requiredItemAt(m, 1, 'bitmap font token')] = requiredItemAt(m, 2, 'bitmap font token').replace(/^"|"$/g, '');
  }
  return result;
}

export function parseFnt(text: string): BitmapFontData {
  const lines = text.split(/\r?\n/);

  let face = '';
  let size = 16;
  let bold = false;
  let italic = false;
  let lineHeight = 16;
  let base = 16;
  let scaleW = 256;
  let scaleH = 256;
  const pages: string[] = [];
  const chars = new Map<number, BitmapFontChar>();
  const kernings = new Map<number, number>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const spaceIdx = line.indexOf(' ');
    const tag = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
    const kv = tokenize(rest);

    switch (tag) {
      case 'info':
        face = kv['face'] ?? '';
        size = parseInt(kv['size'] ?? '16', 10);
        bold = kv['bold'] === '1';
        italic = kv['italic'] === '1';
        break;
      case 'common':
        lineHeight = parseInt(kv['lineHeight'] ?? '16', 10);
        base = parseInt(kv['base'] ?? '16', 10);
        scaleW = parseInt(kv['scaleW'] ?? '256', 10);
        scaleH = parseInt(kv['scaleH'] ?? '256', 10);
        break;
      case 'page': {
        const pageId = parseInt(kv['id'] ?? '0', 10);
        pages[pageId] = kv['file'] ?? '';
        break;
      }
      case 'char': {
        const id = parseInt(kv['id'] ?? '0', 10);
        chars.set(id, {
          id,
          x:        parseInt(kv['x']        ?? '0', 10),
          y:        parseInt(kv['y']        ?? '0', 10),
          width:    parseInt(kv['width']    ?? '0', 10),
          height:   parseInt(kv['height']   ?? '0', 10),
          xoffset:  parseInt(kv['xoffset']  ?? '0', 10),
          yoffset:  parseInt(kv['yoffset']  ?? '0', 10),
          xadvance: parseInt(kv['xadvance'] ?? '0', 10),
          page:     parseInt(kv['page']     ?? '0', 10),
        });
        break;
      }
      case 'kerning': {
        const first  = parseInt(kv['first']  ?? '0', 10);
        const second = parseInt(kv['second'] ?? '0', 10);
        const amount = parseInt(kv['amount'] ?? '0', 10);
        kernings.set(bitmapKerningKey(first, second), amount);
        break;
      }
    }
  }

  return createBitmapFontData({ face, size, bold, italic, lineHeight, base, scaleW, scaleH, pages, chars, kernings });
}

// ── JSON font format parser ───────────────────────────────────────────────────
// Supports both the raw AngelCode JSON export and a compact hand-written format.
//
// AngelCode JSON export (via BMFont tools):
//   { "info": {...}, "common": {...}, "pages": [...], "chars": [...], "kernings": [...] }
//
// Compact format (hand-written):
//   { "face": "...", "size": 32, "lineHeight": 40, "base": 32, "scaleW": 512, "scaleH": 512,
//     "pages": ["atlas.png"], "chars": [...], "kernings": [...] }

export function parseFntJson(json: unknown): BitmapFontData {
  const obj = json as Record<string, unknown>;

  // Detect AngelCode JSON export format
  const isAngelCode = typeof obj['info'] === 'object' && obj['info'] !== null;

  let face = '';
  let size = 16;
  let bold = false;
  let italic = false;
  let lineHeight = 16;
  let base = 16;
  let scaleW = 256;
  let scaleH = 256;
  const pages: string[] = [];
  const chars = new Map<number, BitmapFontChar>();
  const kernings = new Map<number, number>();

  if (isAngelCode) {
    const info   = obj['info']   as Record<string, unknown>;
    const common = obj['common'] as Record<string, unknown>;

    face       = String(info['face'] ?? '');
    size       = Number(info['size'] ?? 16);
    bold       = Boolean(info['bold']);
    italic     = Boolean(info['italic']);
    lineHeight = Number(common['lineHeight'] ?? 16);
    base       = Number(common['base'] ?? 16);
    scaleW     = Number(common['scaleW'] ?? 256);
    scaleH     = Number(common['scaleH'] ?? 256);

    for (const p of (obj['pages'] as Record<string, unknown>[]) ?? []) {
      pages[Number(p['id'] ?? 0)] = String(p['file'] ?? '');
    }
  } else {
    face       = String(obj['face'] ?? '');
    size       = Number(obj['size'] ?? 16);
    bold       = Boolean(obj['bold'] ?? false);
    italic     = Boolean(obj['italic'] ?? false);
    lineHeight = Number(obj['lineHeight'] ?? 16);
    base       = Number(obj['base'] ?? 16);
    scaleW     = Number(obj['scaleW'] ?? 256);
    scaleH     = Number(obj['scaleH'] ?? 256);

    for (const p of (obj['pages'] as string[]) ?? []) {
      pages.push(p);
    }
  }

  for (const c of (obj['chars'] as Record<string, unknown>[]) ?? []) {
    const id = Number(c['id'] ?? 0);
    chars.set(id, {
      id,
      x:        Number(c['x']        ?? 0),
      y:        Number(c['y']        ?? 0),
      width:    Number(c['width']    ?? 0),
      height:   Number(c['height']   ?? 0),
      xoffset:  Number(c['xoffset']  ?? 0),
      yoffset:  Number(c['yoffset']  ?? 0),
      xadvance: Number(c['xadvance'] ?? 0),
      page:     Number(c['page']     ?? 0),
    });
  }

  for (const k of (obj['kernings'] as Record<string, unknown>[]) ?? []) {
    const first  = Number(k['first']  ?? 0);
    const second = Number(k['second'] ?? 0);
    const amount = Number(k['amount'] ?? 0);
    kernings.set(bitmapKerningKey(first, second), amount);
  }

  return createBitmapFontData({ face, size, bold, italic, lineHeight, base, scaleW, scaleH, pages, chars, kernings });
}
