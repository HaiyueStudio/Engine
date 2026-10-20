import type {BitmapFontData} from '../font/BitmapFontData';
import {GuiDirtyFlags} from './GuiTypes';
import type {GuiMeasureConstraint} from './GuiLayoutTypes';
import type {GuiRoot} from './components/GuiRoot';
import {GuiElement} from './components/GuiElement';
import {GuiLabel} from './components/GuiLabel';
import {GuiButton} from './components/GuiButton';
import {GuiImage} from './components/GuiImage';
import {measureGuiTextBlock} from './rendering/GuiTextBatch';

const fonts = new WeakMap<object, BitmapFontData>();
const owners = new WeakMap<GuiRoot, object>();
const observedFonts = new WeakMap<GuiRoot, BitmapFontData>();
const rootFonts = new WeakMap<GuiRoot, BitmapFontData>();
const observedThemes = new WeakMap<GuiRoot, string>();
const providers = new WeakMap<object, {get: (root: GuiRoot) => BitmapFontData; release: (root: GuiRoot) => void}>();
const refresh = new WeakSet<object>();
export function registerGuiFontProvider(owner: object, get: (root: GuiRoot) => BitmapFontData, release: (root: GuiRoot) => void): void {providers.set(owner, {get, release});}
export function requestGuiFontReload(owner: object): void {refresh.add(owner);}
export function consumeGuiFontReload(owner: object): boolean {const dirty = refresh.has(owner); refresh.delete(owner); return dirty;}
export function guiMeasureFontVersion(root: GuiRoot): number {return observedFonts.get(root)?.id ?? 0;}
export function setGuiMeasureFont(owner: object, font: BitmapFontData | null): void {if (font) fonts.set(owner, font); else fonts.delete(owner);}
export function bindGuiMeasureOwner(root: GuiRoot, owner: object): void {
  owners.set(root, owner);
  const font = providers.get(owner)?.get(root) ?? fonts.get(owner), theme = JSON.stringify([root.theme.fontSize, root.theme.fontFamily]);
  if (font) rootFonts.set(root, font);
  if (font && (observedFonts.get(root) !== font || observedThemes.get(root) !== theme)) {observedFonts.set(root, font); observedThemes.set(root, theme); root.root.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);}
}
export function releaseGuiMeasureOwner(root: GuiRoot): void {const owner = owners.get(root); if (owner) providers.get(owner)?.release(root); owners.delete(root); rootFonts.delete(root); observedFonts.delete(root); observedThemes.delete(root);}
function bounded(value: number, constraint: GuiMeasureConstraint): number {
  if (!constraint || !['exact', 'at-most', 'unbounded'].includes(constraint.mode) || (constraint.mode !== 'unbounded' && (typeof constraint.value !== 'number' || !Number.isFinite(constraint.value) || constraint.value < 0))) throw new Error('Invalid GUI measurement constraint.');
  return constraint.mode === 'exact' ? constraint.value! : constraint.mode === 'at-most' ? Math.min(value, constraint.value!) : value;
}
export function measureGuiElement(root: GuiRoot, element: GuiElement, width: GuiMeasureConstraint, height: GuiMeasureConstraint): {width: number; height: number; minWidth: number; minHeight: number} {
  bounded(0, width); bounded(0, height);
  let size = {width: 0, height: 0};
  let minimum = {width: 0, height: 0};
  if (element instanceof GuiLabel || element instanceof GuiButton) {
    const owner = owners.get(root), font = rootFonts.get(root) ?? (owner && fonts.get(owner));
    if (!font) throw new Error('GUI font metrics are not ready; prepare GuiSystem before measuring text.');
    const padding = element.style.padding ?? (element instanceof GuiButton ? element.variant === 'outline' ? 4 : 8 : 0);
    const measured = measureGuiTextBlock(element.text, font, element instanceof GuiLabel ? element.fontSize ?? root.theme.fontSize : root.theme.fontSize, width.mode === 'unbounded' ? Infinity : Math.max(0, width.value! - 2 * padding), element instanceof GuiLabel);
    size = {width: measured.width + 2 * padding, height: measured.height + 2 * padding};
    const min = measureGuiTextBlock(element.text, font, element instanceof GuiLabel ? element.fontSize ?? root.theme.fontSize : root.theme.fontSize, element instanceof GuiLabel ? 0 : Infinity, element instanceof GuiLabel);
    minimum = {width: min.width + padding * 2, height: element.text ? font.lineHeight * (element instanceof GuiLabel ? element.fontSize ?? root.theme.fontSize : root.theme.fontSize) / font.size + padding * 2 : padding * 2};
  } else if (element instanceof GuiImage && element.source) {
    const source = 'texture' in element.source ? element.source.texture : element.source;
    size = {width: 'naturalWidth' in source ? source.naturalWidth : 'width' in source ? source.width : 0, height: 'naturalHeight' in source ? source.naturalHeight : 'height' in source ? source.height : 0};
    minimum = size;
  } else if (element.constructor !== GuiElement) {
    const options = element.getLayoutOptions();
    size = {width: typeof options.width === 'number' ? options.width : 0, height: typeof options.height === 'number' ? options.height : 0};
    minimum = size;
  }
  if (![size.width, size.height].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid GUI intrinsic dimensions.');
  return {width: bounded(size.width, width), height: bounded(size.height, height), minWidth: minimum.width, minHeight: minimum.height};
}
