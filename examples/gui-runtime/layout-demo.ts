import {GuiButton, type GuiElement} from '@haiyue/engine/gui';
import type {GuiLayoutBinding} from '@haiyue/extensions/gui-layout';

/** The same four controls demonstrate exclusive manual/Flex/Grid position ownership. */
export function populateLayoutDemo(parent: GuiElement, mode: string, binding: GuiLayoutBinding, changed: (value: string) => void): void {
  const children = ['Inventory', 'Settings', 'Help', 'Continue'].map((text, i) => parent.add(new GuiButton({
    id: `layout-${i}`, text, x: 10 + i % 2 * 112, y: 10 + Math.floor(i / 2) * 52, width: 104, height: 44,
    style: {backgroundColor: '#164e63', borderColor: '#0e7490', color: '#ffffff'}, onClick: () => changed(text),
  })));
  if (mode === 'Manual') return;
  const size = parent.getLayoutOptions();
  binding.setStyle(parent, {width: size.width as number, height: size.height as number, padding: {top: 10, left: 10, right: 10, bottom: 10}, columnGap: 8, rowGap: 8,
    ...(mode === 'Grid' ? {display: 'grid', columns: [{fr: 1}, {fr: 1}], rows: [{fr: 1}, {fr: 1}]} : {display: 'flex', direction: 'row', wrap: 'wrap', alignContent: 'start'}),
  });
  for (const child of children) binding.setStyle(child, mode === 'Grid' ? {width: 'auto', height: 'auto'} : {basis: 90, grow: 1, height: 44});
}
