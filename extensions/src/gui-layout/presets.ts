import {GuiElement} from '@haiyue/engine/gui';
import type {LayoutStyle} from '../layout.js';
import type {GuiContainerPreset, GuiLayoutStyle} from './types.js';
import {captureGuiLayoutStyle} from './style.js';

const presets = new WeakMap<GuiElement, GuiLayoutStyle>();
const frames = new WeakMap<GuiElement, GuiLayoutStyle>();
const styles: Readonly<Record<GuiContainerPreset, LayoutStyle>> = Object.freeze({
  row: {direction: 'row'}, column: {direction: 'column'}, flow: {direction: 'row', wrap: 'wrap'},
  grid: {display: 'grid'}, margin: {direction: 'column'}, center: {justifyContent: 'center', alignItems: 'center'},
});
export function presetStyle(element: GuiElement): GuiLayoutStyle | undefined {return presets.get(element);}
/** Private composite metadata; the public binding still owns the single layout delegate. */
export function setContainerStyle(element: GuiElement, style: GuiLayoutStyle): void {
  presets.set(element, captureGuiLayoutStyle(style));
}
export function frameStyle(element: GuiElement): GuiLayoutStyle | undefined {return frames.get(element);}
export function ownContentFrame(element: GuiElement): () => void {
  if (frames.has(element)) throw new Error('GUI content already belongs to a composite frame.');
  const style = Object.freeze({width: 'auto', height: 'auto', grow: 1, basis: 0, minWidth: 0, minHeight: 0} as const);
  frames.set(element, style);
  return () => {if (frames.get(element) === style) frames.delete(element);};
}
export function createGuiContainer(preset: GuiContainerPreset, options: {readonly id?: string; readonly style?: GuiLayoutStyle} = {}): GuiElement {
  if (!Object.hasOwn(styles, preset)) throw new Error('Unsupported GUI container preset.');
  const element = new GuiElement({id: options.id, width: '100%'});
  presets.set(element, captureGuiLayoutStyle({height: 'auto', ...styles[preset], ...options.style}));
  return element;
}
