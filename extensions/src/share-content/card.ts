import { captureShareImage, checkSize, imageSettings } from './capture';
import { createChallengeLink } from './challenge';
import type { ShareCard, ShareCardOptions, ShareCardSurface, ShareText, ShareImage, ShareContentRequest, PreparedShareContent } from './types';

type Context = NonNullable<ReturnType<ShareCardSurface['getContext']>>;
function message(value: ShareText, options: ShareCardOptions): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    if (!value || !options.i18n || typeof value.key !== 'string') throw new TypeError('Localized share text requires i18n and a message key');
    text = options.i18n.text(value.key, value.params);
  }
  if (typeof text !== 'string' || text.length > 4096) throw new RangeError('Share text exceeds 4096 characters');
  return text;
}
function surface(width: number, height: number, options: ShareCardOptions): ShareCardSurface {
  if (options.createCanvas) return options.createCanvas(width, height);
  if (typeof document === 'undefined') throw new Error('This host must provide createCanvas for share cards');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
function wrap(context: Context, text: string, width: number): string[] {
  const segments = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
    : Array.from(text);
  const lines: string[] = [];
  let line = '';
  for (const character of segments) {
    if (character === '\n') { lines.push(line); line = ''; continue; }
    if (context.measureText(character).width > width) return Array(10000).fill('');
    if (line && context.measureText(line + character).width > width) {
      // Prefer a word boundary for Latin text; unspaced text/long tokens fall back to graphemes.
      const space = line.lastIndexOf(' ');
      if (space > 0 && character !== ' ') { lines.push(line.slice(0, space)); line = line.slice(space + 1); }
      else { lines.push(line.trimEnd()); line = ''; }
    }
    if (!line && character === ' ') continue;
    line += character;
  }
  lines.push(line.trimEnd()); return lines;
}
function textBox(context: Context, text: string, x: number, y: number, width: number, height: number, font: number, family: string, color: string, bold = false): void {
  if (!text) return;
  context.fillStyle = color; context.textBaseline = 'top';
  const minimum = Math.max(10, Math.floor(font * 0.5));
  for (let size = Math.floor(font); size >= minimum; size--) {
    context.font = `${bold ? 'bold ' : ''}${size}px ${family}`;
    const lines = wrap(context, text, width), step = size * 1.3;
    if (lines.length * step > height) continue;
    lines.forEach((line, index) => context.fillText(line, x, y + index * step)); return;
  }
  throw new RangeError('Share card text does not fit; shorten it or increase card dimensions');
}

/** One-shot Canvas2D compositor. No per-frame work, persistent listeners or shared GUI mutations. */
export async function renderShareCard(card: ShareCard, options: ShareCardOptions = {}): Promise<ShareImage> {
  options.signal?.throwIfAborted(); imageSettings(options);
  const width = card.width ?? 1200, height = card.height ?? 630;
  checkSize(width, height);
  if (width < 420 || height < 320 || width / height > 2.5 || height / width > 2.5) throw new RangeError('Card requires at least 420 × 320 pixels and an aspect ratio within 2.5:1');
  const stats = card.stats ?? [];
  if (stats.length > 4) throw new RangeError('Share cards support at most four statistics');
  // Resolve all language-dependent content before any asynchronous encoding.
  const title = message(card.title, options), subtitle = message(card.subtitle ?? '', options);
  const badge = message(card.badge ?? '', options), footer = message(card.footer ?? '', options);
  const values = stats.map(stat => ({ label: message(stat.label, options), value: message(stat.value, options) }));
  const colors = { background: '#101d32', panel: '#1e3450', text: '#eef6ff', muted: '#afc4d9', accent: '#80d4ff', ...card.colors };
  for (const color of Object.values(colors)) if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new TypeError('Card colors must be #RRGGBB');
  const family = card.fontFamily ?? 'sans-serif';
  if (!family.trim() || family.length > 256 || /[\n\r\x00]/.test(family)) throw new TypeError('Invalid card font family');
  if (card.image) {
    if (!Number.isFinite(card.image.width) || !Number.isFinite(card.image.height) || card.image.width <= 0 || card.image.height <= 0) throw new RangeError('Invalid source image dimensions');
    if (card.image.fit !== undefined && card.image.fit !== 'cover' && card.image.fit !== 'contain') throw new TypeError('Invalid card image fit');
  }
  const canvas = surface(width, height, options);
  try {
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas2D is unavailable for share cards');
    const scale = Math.min(width, height) / 630, margin = 44 * scale, gap = 22 * scale;
    const innerWidth = width - margin * 2, landscape = width >= height;
    context.fillStyle = colors.background; context.fillRect(0, 0, width, height);
    context.fillStyle = colors.accent; context.fillRect(margin, margin, 64 * scale, 5 * scale);
    let textWidth = innerWidth, top = margin + 25 * scale;
    const image = card.image;
    const drawImage = (x: number, y: number, w: number, h: number) => {
      if (!image) return;
      context.fillStyle = colors.panel; context.fillRect(x, y, w, h);
      const ratio = (image.fit === 'contain' ? Math.min : Math.max)(w / image.width, h / image.height);
      const dw = image.width * ratio, dh = image.height * ratio;
      // Crop explicitly instead of leaking drawing outside the artwork slot.
      if (image.fit === 'contain') context.drawImage(image.source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      else {
        const sw = w / ratio, sh = h / ratio;
        context.drawImage(image.source, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
      }
    };
    if (image && landscape) {
      textWidth = (innerWidth - gap) * 0.52;
      drawImage(margin + textWidth + gap, top, innerWidth - textWidth - gap, height - top - margin - 65 * scale);
    }
    textBox(context, badge, margin, top, textWidth, 36 * scale, 21 * scale, family, colors.accent);
    top += 42 * scale;
    textBox(context, title, margin, top, textWidth, 104 * scale, 48 * scale, family, colors.text, true);
    top += 110 * scale;
    textBox(context, subtitle, margin, top, textWidth, 66 * scale, 23 * scale, family, colors.muted);
    top += 74 * scale;
    if (image && !landscape) {
      const imageHeight = Math.min(height * 0.25, height - top - 280 * scale);
      if (imageHeight < 40 * scale) throw new RangeError('Portrait card has insufficient space for artwork');
      drawImage(margin, top, innerWidth, imageHeight); top += imageHeight + gap;
    }
    const available = height - margin - 60 * scale - top;
    if (values.length) {
      const columns = values.length === 1 ? 1 : 2, rows = Math.ceil(values.length / columns);
      const cellW = (textWidth - gap * (columns - 1)) / columns, cellH = (available - gap * (rows - 1)) / rows;
      if (cellH < 70 * scale) throw new RangeError('Insufficient card space for statistics');
      values.forEach((stat, index) => {
        const x = margin + (index % columns) * (cellW + gap), y = top + Math.floor(index / columns) * (cellH + gap), pad = 14 * scale;
        context.fillStyle = colors.panel; context.fillRect(x, y, cellW, cellH);
        textBox(context, stat.value, x + pad, y + pad, cellW - 2 * pad, cellH * 0.56 - pad, 45 * scale, family, colors.text, true);
        textBox(context, stat.label, x + pad, y + cellH * 0.58, cellW - 2 * pad, cellH * 0.42 - pad, 20 * scale, family, colors.muted);
      });
    }
    textBox(context, footer, margin, height - margin - 35 * scale, innerWidth, 45 * scale, 19 * scale, family, colors.muted);
    return await captureShareImage(canvas, options);
  } finally { canvas.width = 0; canvas.height = 0; }
}
export async function prepareShareContent(request: ShareContentRequest, options: ShareCardOptions = {}): Promise<PreparedShareContent> {
  const title = message(request.title, options), text = message(request.text, options);
  const url = request.challenge ? createChallengeLink(request.challenge.baseUrl, request.challenge.data) : undefined;
  const image = await renderShareCard(request.card, options);
  return Object.freeze({ title, text, ...(url === undefined ? {} : { url }), image });
}
