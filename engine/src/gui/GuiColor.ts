import { requiredItemAt } from '../math/arrayAccess';

export type GuiRgba = [number, number, number, number];

const COLOR_CACHE_LIMIT = 256;
const colorCache = new Map<string, GuiRgba>();

const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
};

export function parseGuiColor(color: string | undefined, fallback: string): GuiRgba {
  const raw = (color ?? fallback).trim().toLowerCase();
  const key = `${raw}|${fallback}`;
  const cached = colorCache.get(key);
  if (cached) return cached;
  const parsed = parseColor(raw)
    ?? parseColor((NAMED_COLORS[fallback.toLowerCase()] ?? fallback).trim().toLowerCase())
    ?? [1, 1, 1, 1];
  if (colorCache.size >= COLOR_CACHE_LIMIT) {
    const oldestKey = colorCache.keys().next().value;
    if (oldestKey !== undefined) colorCache.delete(oldestKey);
  }
  colorCache.set(key, parsed);
  return parsed;
}

export function withGuiAlpha(color: GuiRgba, alpha: number): GuiRgba {
  return [color[0], color[1], color[2], color[3] * alpha];
}

function parseColor(raw: string): GuiRgba | null {
  const named = NAMED_COLORS[raw];
  if (named) return parseHex(named.slice(1));
  if (raw.startsWith('#')) return parseHex(raw.slice(1));
  if (raw.startsWith('rgb(') || raw.startsWith('rgba(')) return parseRgb(raw);
  if (raw.startsWith('hsl(') || raw.startsWith('hsla(')) return parseHsl(raw);
  return null;
}

function parseHex(hex: string): GuiRgba | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    return [
      Number.parseInt(hex.slice(0, 1).repeat(2), 16) / 255,
      Number.parseInt(hex.slice(1, 2).repeat(2), 16) / 255,
      Number.parseInt(hex.slice(2, 3).repeat(2), 16) / 255,
      hex.length === 4 ? Number.parseInt(hex.slice(3, 4).repeat(2), 16) / 255 : 1,
    ];
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255,
      hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    ];
  }
  return null;
}

function parseRgb(raw: string): GuiRgba | null {
  const values = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')).split(/[\s,\/]+/).filter(Boolean);
  if (values.length < 3) return null;
  return [
    parseColorChannel(requiredItemAt(values, 0, 'GUI rgb color')),
    parseColorChannel(requiredItemAt(values, 1, 'GUI rgb color')),
    parseColorChannel(requiredItemAt(values, 2, 'GUI rgb color')),
    values[3] !== undefined ? parseAlpha(values[3]) : 1,
  ];
}

function parseHsl(raw: string): GuiRgba | null {
  const values = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')).split(/[\s,\/]+/).filter(Boolean);
  if (values.length < 3) return null;
  const h = (((Number.parseFloat(requiredItemAt(values, 0, 'GUI hsl color')) % 360) + 360) % 360) / 360;
  const s = parsePercent(requiredItemAt(values, 1, 'GUI hsl color'));
  const l = parsePercent(requiredItemAt(values, 2, 'GUI hsl color'));
  const a = values[3] !== undefined ? parseAlpha(values[3]) : 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3), a];
}

function parseColorChannel(value: string): number {
  return clamp01(value.endsWith('%') ? Number.parseFloat(value) / 100 : Number.parseFloat(value) / 255);
}

function parseAlpha(value: string): number {
  return clamp01(value.endsWith('%') ? Number.parseFloat(value) / 100 : Number.parseFloat(value));
}

function parsePercent(value: string): number {
  return clamp01(Number.parseFloat(value) / 100);
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
