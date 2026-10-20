import {GuiElement} from '@haiyue/engine/gui';
import type {LayoutStyle} from '../layout.js';
import type {GuiContainerPreset, GuiLayoutStyle} from './types.js';
import {captureGuiLayoutStyle} from './style.js';

const presets = new WeakMap<GuiElement, GuiLayoutStyle>();
const styles: Readonly<Record<GuiContainerPreset, LayoutStyle>> = Object.freeze({
  row: {direction: 'row'}, column: {direction: 'column'}, flow: {direction: 'row', wrap: 'wrap'},
  grid: {display: 'grid'}, margin: {direction: 'column'}, center: {justifyContent: 'center', alignItems: 'center'},
});
export function presetStyle(element: GuiElement): GuiLayoutStyle | undefined {return presets.get(element);}
export function createGuiContainer(preset: GuiContainerPreset, options: {readonly id?: string; readonly style?: GuiLayoutStyle} = {}): GuiElement {
  if (!Object.hasOwn(styles, preset)) throw new Error('Unsupported GUI container preset.');
  const element = new GuiElement({id: options.id, width: '100%'});
  presets.set(element, captureGuiLayoutStyle({height: 'auto', ...styles[preset], ...options.style}));
  return element;
}
