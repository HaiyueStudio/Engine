import {GuiButton, GuiElement, GuiLabel, GuiModal} from '@haiyue/engine/gui';
import type {GuiRoot, GuiSystem} from '@haiyue/engine/gui';
import {createGuiContainer, GuiSplitPanel, GuiTabContainer} from '@haiyue/extensions/gui-layout';
import type {GuiLayoutBinding} from '@haiyue/extensions/gui-layout';

/** Business-owned payload and acceptance rules; input/capture/preview remain Engine responsibilities. */
export function attachDragDrop(gui: GuiSystem, root: GuiRoot, binding: GuiLayoutBinding, canvas: HTMLCanvasElement): () => void {
  const counts = {payloads: 0, previews: 0, disposedPreviews: 0, drops: 0, sourceClicks: 0, ended: [] as boolean[]};
  const payload = {kind: 'example-resource', id: 'sample-asset'};
  let allow = true, hover = false;
  let disposed = false;
  const library = createGuiContainer('column', {id: 'drag-library', style: {padding: {left: 16, top: 16}, rowGap: 12}});
  library.setStyle({backgroundColor: '#15243b', radius: 0});
  library.add(new GuiLabel({text: 'Resource library', fontSize: 20, width: 220, height: 30}));
  library.add(new GuiLabel({text: 'Drag Sample, or focus it and\npress Enter, Tab, then Enter.\nEscape cancels.', width: 240, height: 72}));
  const sample = library.add(new GuiButton({id: 'drag-sample', text: 'Sample asset', width: 190, height: 44,
    onClick: () => {counts.sourceClicks++; publish();},
    dragSource: {
      getData: () => {counts.payloads++; publish(); return payload;},
      createPreview: () => {
        counts.previews++;
        const preview = new GuiElement({width: 160, height: 42, pointerFilter: 'stop', style: {backgroundColor: '#f59e0b', radius: 4}});
        preview.add(new GuiLabel({text: 'Sample asset', x: 12, width: 135, height: 42, style: {color: '#111827'}}));
        publish(); return preview;
      },
      disposePreview: () => {counts.disposedPreviews++; publish();},
      onEnd: accepted => {counts.ended.push(accepted); publish();},
    }}));
  const toggle = library.add(new GuiButton({id: 'drag-allow', text: 'Acceptance: ON', width: 190, height: 34,
    onClick: () => {allow = !allow; toggle.setText(`Acceptance: ${allow ? 'ON' : 'OFF'}`); zone.markDirty(); publish();}}));
  const count = library.add(new GuiLabel({id: 'drag-count', text: 'Received: 0', width: 220, height: 28}));
  const workspace = createGuiContainer('column', {id: 'drag-workspace', style: {padding: {left: 20, top: 20}, rowGap: 14}});
  workspace.add(new GuiLabel({text: 'Workspace drop area', fontSize: 20, width: 280, height: 30}));
  const zone = workspace.add(new GuiElement({id: 'drag-zone', width: 300, height: 150, style: {backgroundColor: '#1b3a52', radius: 6},
    dropTarget: {
      canDrop: data => allow && data === payload,
      drop: data => {if (data !== payload) throw new TypeError('Unexpected example payload.'); counts.drops++; count.setText(`Received: ${counts.drops}`); publish();},
      onHoverChange: (active, accepted) => {hover = active; zone.setStyle({backgroundColor: active ? accepted ? '#186d45' : '#7f2533' : '#1b3a52'}); publish();},
    }}));
  zone.add(new GuiLabel({x: 16, y: 16, width: 260, height: 64, text: 'Drop here\nThe payload stays application-owned.'}));
  const hidden = createGuiContainer('column', {id: 'drag-history', style: {padding: {left: 20, top: 20}}});
  hidden.add(new GuiLabel({text: 'Inactive pages do not accept drops.\nSwitch back to Workspace to receive.', width: 350, height: 70}));
  const tabs = new GuiTabContainer({id: 'drag-tabs', focus: gui.focus,
    pages: [{id: 'workspace', title: 'Workspace', content: workspace}, {id: 'history', title: 'History', content: hidden}],
    activeId: 'workspace', onActiveChange: () => publish()});
  const split = new GuiSplitPanel({id: 'drag-panels', axis: 'horizontal', ratio: .34, minimumFirst: 275, minimumSecond: 360,
    first: library, second: tabs.element});
  root.add(split.element); binding.setStyle(split.element, {width: {percent: 100}, height: {percent: 100}});
  const modal = root.add(new GuiModal({id: 'drag-modal', title: 'Modal cancels drag', message: 'The current semantic gesture has ended.', width: '100%', height: '100%'}));
  library.add(new GuiButton({id: 'drag-modal-open', text: 'Show modal', width: 190, height: 34, onClick: () => modal.show()}));
  function publish(): void {
    if (disposed) return;
    const ids = [sample.id, zone.id, toggle.id, 'drag-tabs:tab:workspace:select', 'drag-tabs:tab:history:select'];
    const targets = Object.fromEntries(ids.flatMap(id => {const element = root.findById(id); return element ? [[id, {...element.rect}]] : [];}));
    canvas.dataset.dragState = JSON.stringify({...counts, allow, hover, activePage: tabs.activeId,
      session: gui.dragSession ? {sourceId: gui.dragSession.sourceId, targetId: gui.dragSession.targetId, pointerId: gui.dragSession.pointerId ?? null} : null,
      focus: gui.focus.focused?.id ?? null, width: root.viewport.width, height: root.viewport.height, targets});
  }
  const off = root.onInvalidation(publish); publish();
  return () => {disposed = true; if (gui.dragSession?.sourceId === sample.id) gui.dragSession.cancel(); off(); split.dispose(); tabs.dispose(); root.remove(modal); delete canvas.dataset.dragState;};
}
