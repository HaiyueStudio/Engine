import {GuiButton, GuiElement, GuiInput, GuiLabel, GuiSlider} from '@haiyue/engine/gui';
import type {GuiRoot, GuiSystem} from '@haiyue/engine/gui';
import {createGuiContainer, GuiSplitPanel, GuiTabContainer} from '@haiyue/extensions/gui-layout';
import type {GuiLayoutBinding} from '@haiyue/extensions/gui-layout';
import type {HaiyueEngine} from '@haiyue/engine';

/** One production UI composed entirely through the planned public domain entry. */
export function attachPanelsTabs(engine: HaiyueEngine, gui: GuiSystem, root: GuiRoot, binding: GuiLayoutBinding): () => void {
  const canvas = engine.canvas!;
  const summary = createGuiContainer('column', {id: 'panel-summary', style: {padding: {left: 16, top: 12}, rowGap: 12}});
  summary.setStyle({backgroundColor: '#15243b', radius: 0});
  summary.add(new GuiLabel({text: 'Workspace', fontSize: 20, height: 30, width: 180}));
  summary.add(new GuiLabel({text: 'Drag a divider, or focus it\nand use arrow keys.', width: 185, height: 56}));
  const name = summary.add(new GuiInput({id: 'workspace-name', value: 'Untitled project', width: 180, height: 34}));

  const settings = createGuiContainer('column', {id: 'settings-content', style: {padding: {left: 16, top: 14}, rowGap: 12}});
  settings.setStyle({backgroundColor: '#1b3047', radius: 0});
  settings.add(new GuiLabel({text: 'Settings', fontSize: 20, width: 220, height: 28}));
  const input = settings.add(new GuiInput({id: 'panel-name', value: 'Retained page state', width: 240, height: 34}));
  const gain = settings.add(new GuiSlider({id: 'panel-gain', width: 240, height: 32, value: 5, min: 0, max: 10}));

  const preview = createGuiContainer('column', {id: 'preview-content', style: {padding: {left: 16, top: 14}, rowGap: 12}});
  preview.setStyle({backgroundColor: '#173d38', radius: 0});
  const previewText = preview.add(new GuiLabel({id: 'preview-text', text: 'Preview revision 0', width: 260, height: 30}));
  let revision = 0;
  summary.add(new GuiButton({id: 'update-hidden-preview', text: 'Update preview', width: 180, height: 34,
    onClick: () => {previewText.setText(`Preview revision ${++revision}`); publish();}}));
  const help = new GuiElement({id: 'help-content', width: '100%', height: '100%'});
  help.add(new GuiLabel({x: 16, y: 14, text: 'Pages keep their objects, values\nand pending changes.', width: 320, height: 60}));
  const tabs = new GuiTabContainer({id: 'workspace-tabs', focus: gui.focus, activeId: 'settings',
    pages: [{id: 'settings', title: 'Settings', content: settings}, {id: 'preview', title: 'Preview', content: preview, closable: true}, {id: 'help', title: 'Help', content: help}],
    onActiveChange: () => publish()});
  const log = createGuiContainer('column', {id: 'panel-log', style: {padding: {left: 16, top: 10}}});
  log.add(new GuiLabel({text: 'Keyboard: Tab to divider, then arrows.\nTab headers: Left / Right. Close: focus x, Enter.', width: 520, height: 48}));
  const nested = new GuiSplitPanel({id: 'workspace-vertical', axis: 'vertical', ratio: .72, minimumFirst: 120, minimumSecond: 56,
    first: tabs.element, second: log, onRatioChange: () => publish()});
  const split = new GuiSplitPanel({id: 'workspace-horizontal', axis: 'horizontal', ratio: .28, minimumFirst: 220, minimumSecond: 300,
    first: summary, second: nested.element, onRatioChange: () => publish()});
  root.add(split.element);
  const resize = (): void => {
    binding.setStyle(split.element, {width: engine.displayWidth, height: engine.displayHeight});
    publish();
  };
  function publish(): void {
    const ids = ['workspace-horizontal:divider', 'workspace-vertical:divider', 'update-hidden-preview', 'workspace-tabs:tab:settings:select', 'workspace-tabs:tab:preview:select', 'workspace-tabs:tab:preview:close', 'workspace-tabs:tab:help:select'];
    const targets = Object.fromEntries(ids.flatMap(id => {const node = root.findById(id); return node ? [[id, {...node.rect}]] : [];}));
    canvas.dataset.panelState = JSON.stringify({activeId: tabs.activeId, pages: tabs.pages.map(p => p.id), ratio: split.ratio,
      verticalRatio: nested.ratio, value: input.value, gain: gain.value, revision, previewText: previewText.text, name: name.value,
      width: engine.displayWidth, height: engine.displayHeight, targets});
  }
  const off = root.onInvalidation(publish);
  window.addEventListener('resize', resize);
  resize();
  return () => {
    window.removeEventListener('resize', resize); off();
    split.dispose(); nested.dispose(); tabs.dispose(); delete canvas.dataset.panelState;
  };
}
