import { Entity, HaiyueEngine } from '@haiyue/engine';
import {
  GuiButton, GuiColorPicker, GuiElement, GuiInput, GuiLabel, GuiModal, GuiRoot, GuiScrollView,
  GuiSelect, GuiSlider, GuiSwitch,
} from '@haiyue/engine/gui';
import { createCatalog, defaults, normalize, previewStyle, type Parameter, type Value } from './catalog';

const colors = { panel: '#111c30', border: '#26354d', muted: '#91a3bd', accent: '#7dd3fc' };
const label = (parent: GuiElement, text: string, x: number, y: number, width: number, fontSize = 14, color = colors.muted) =>
  parent.add(new GuiLabel({ x, y, width, height: 28, text, fontSize, style: { color } }));

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const status = document.getElementById('status')!;
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0.025, g: 0.045, b: 0.085, a: 1 } });
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', cleanup);
    engine.destroy();
  };
  window.addEventListener('pagehide', cleanup);
  try {
    await engine.init();
    if (disposed) return;
    const scene = engine.createScene({ name: 'gui-runtime', render3D: false, gui: { loadOp: 'clear' }, pipelineLabel: 'GuiPlaygroundRenderPipeline' });
    const root = new GuiRoot();
    const entity = new Entity('gui-playground');
    entity.addComponent(root);
    scene.add(entity);
    engine.switchScene(scene);

    const catalog = createCatalog();
    const states = new Map(catalog.map(demo => [demo.name, defaults(demo)]));
    let selected = catalog[0]!;
    let values = states.get(selected.name)!;
    let stage: GuiScrollView;
    let inspector: GuiScrollView;
    let eventLabel: GuiLabel;
    let stageWidth = 0;
    let stageHeight = 0;
    let modal: GuiModal | null = null;
    let lastEvent = 'Ready. Interact with the preview.';
    let events = 0;
    const syncControls = new Map<string, (value: Value) => void>();
    let pendingRefresh: 'layout' | 'inspector' | 'preview' | null = null;
    function requestRefresh(kind: 'layout' | 'inspector' | 'preview'): void {
      if (pendingRefresh === 'layout' || (pendingRefresh === 'inspector' && kind === 'preview')) return;
      pendingRefresh = kind;
    }

    function record(key: string, value: Value): void {
      lastEvent = `${++events}  /  ${key}: ${String(value)}`;
      eventLabel.setText(lastEvent);
    }

    function previewChanged(key: string, value: Value): void {
      values[key] = value;
      syncControls.get(key)?.(value);
      record(key, value);
    }

    function clearChildren(parent: GuiElement): void {
      // Removed inputs must not remain keyboard targets after switching/resetting.
      const focused = scene.guiSystem!.focus.focused;
      if (focused && parent.findById(focused.id)) scene.guiSystem!.focus.blur();
      for (const child of [...parent.children]) parent.remove(child);
    }

    function renderPreview(): void {
      clearChildren(stage);
      if (modal) { root.remove(modal); modal = null; }
      const dialog = selected.name === 'GuiModal' || selected.name === 'GuiHelpDialog';
      const width = Number(values.width);
      const height = Number(values.height);
      const displayWidth = selected.name === 'GuiTooltip' ? 160 : width;
      const displayHeight = selected.name === 'GuiRadio' ? height * 3 : selected.name === 'GuiTooltip' ? 36 : height;
      stage.setContentHeight(Math.max(stageHeight, displayHeight + 80));
      const options = {
        id: 'preview-component', x: Math.max(16, (stageWidth - displayWidth) / 2),
        y: Math.max(40, (stageHeight - displayHeight) / 2), width, height,
        disabled: values.disabled === true, style: previewStyle(selected, values),
      };
      const component = selected.create(values, options, previewChanged);
      if (component instanceof GuiModal) {
        modal = root.add(component);
        stage.setContentHeight(stageHeight);
        stage.add(new GuiButton({
          id: 'open-dialog', x: Math.max(16, (stageWidth - 200) / 2), y: Math.max(24, stageHeight / 2 - 20), width: 200, height: 40,
          text: 'Open dialog', variant: 'primary', onClick: () => { component.show(); record('open', selected.name); },
        }));
      } else {
        stage.add(component);
      }
      if (!dialog) stage.scrollTo(Math.min(stage.scrollY, stage.maxScrollY));
    }

    function edit(key: string, value: Value): void {
      values[key] = value;
      if (key.startsWith('style.')) values.customColors = true;
      normalize(selected, values, key);
      for (const [name, sync] of syncControls) sync(values[name]!);
      requestRefresh('preview');
      record(key, values[key]!);
    }

    function renderInspector(): void {
      clearChildren(inspector);
      syncControls.clear();
      const parameters: Parameter[] = [...selected.parameters];
      if (!['GuiModal', 'GuiHelpDialog', 'GuiProgress', 'GuiLabel', 'GuiImage', 'GuiTooltip'].includes(selected.name)) {
        parameters.push({ key: 'disabled', kind: 'boolean', initial: false });
      }
      const width = inspector.getLayoutOptions().width as number;
      let y = 8;
      for (const param of parameters) {
        const caption = label(inspector, param.key, 8, y, width - 24, 13);
        const base = { id: `param-${param.key}`, x: 8, y: y + 28, width: width - 28, height: 30 };
        const change = (value: Value) => edit(param.key, value);
        if (param.kind === 'number') {
          const control = inspector.add(new GuiSlider({ ...base, value: Number(values[param.key]), min: param.min, max: param.max, step: param.step, onChange: change }));
          const sync = (value: Value) => {
            control.setValue(Number(value));
            caption.setText(`${param.key}    ${Number(value).toFixed(param.step < 1 ? 2 : 0)}`);
          };
          syncControls.set(param.key, sync);
          sync(values[param.key]!);
        } else if (param.kind === 'boolean') {
          const control = inspector.add(new GuiSwitch({ ...base, width: 48, height: 26, checked: values[param.key] === true, thumbTransitionMs: 120, colorTransitionMs: 120, onChange: change }));
          const stateLabel = label(inspector, String(values[param.key]), 68, y + 28, 100, 13);
          syncControls.set(param.key, value => { control.setChecked(value === true); stateLabel.setText(String(value)); });
        } else if (param.kind === 'color') {
          const control = inspector.add(new GuiColorPicker({ ...base, height: 144, value: String(values[param.key]), onChange: change }));
          syncControls.set(param.key, value => control.setValue(String(value)));
        } else if (param.kind === 'choice') {
          const control = inspector.add(new GuiSelect({ ...base, value: String(values[param.key]), options: param.options.map(value => ({ label: value, value })), maxVisibleOptions: 4, onChange: change }));
          syncControls.set(param.key, value => control.setValue(String(value)));
        } else {
          const control = inspector.add(new GuiInput({ ...base, value: String(values[param.key]), onChange: change }));
          syncControls.set(param.key, value => control.setValue(String(value)));
        }
        y += param.kind === 'color' ? 192 : 76;
      }
      inspector.setContentHeight(y + 8);
      inspector.scrollTo(0);
    }

    function layout(): void {
      scene.guiSystem!.focus.blur();
      clearChildren(root.root);
      modal = null;
      const w = engine.displayWidth;
      const h = engine.displayHeight;
      const margin = w < 600 ? 12 : 24;
      const stacked = w < 860;
      const contentWidth = w - margin * 2;
      label(root.root, 'GUI / COMPONENT PLAYGROUND', margin, 12, contentWidth, 18, '#e2e8f0');
      root.add(new GuiSelect({
        id: 'component-selector', x: margin, y: 52, width: Math.min(340, contentWidth), height: 38,
        value: selected.name, maxVisibleOptions: 8, optionHeight: 30,
        options: catalog.map(demo => ({ label: demo.name, value: demo.name })),
        onChange: name => {
          selected = catalog.find(demo => demo.name === name)!;
          values = states.get(name)!;
          events = 0; lastEvent = 'Ready. Interact with the preview.';
          requestRefresh('layout');
        },
      }));
      if (w >= 860) label(root.root, 'Choose a component. Edit its properties. See it live.', margin + 360, 58, w - margin - 384, 13);
      const availableHeight = Math.max(180, h - 126);
      const body = root.add(new GuiScrollView({ id: 'workbench', x: margin, y: 110, width: contentWidth, height: availableHeight, contentHeight: stacked ? 950 : Math.max(500, availableHeight), showScrollbar: true }));
      const previewWidth = stacked ? contentWidth - 12 : contentWidth - 336;
      const previewHeight = stacked ? 390 : Math.max(500, availableHeight);
      const preview = body.add(new GuiElement({ id: 'preview-panel', width: previewWidth, height: previewHeight, style: { backgroundColor: colors.panel, borderColor: colors.border, radius: 12 } }));
      label(preview, 'LIVE PREVIEW', 20, 14, previewWidth - 40, 12, colors.accent);
      label(preview, selected.name, 20, 43, previewWidth - 40, 24, '#f1f5f9');
      // Give long hints two predictable rows without relying on implicit text wrapping.
      const words = selected.hint.split(' ');
      const maxChars = Math.max(22, Math.floor((previewWidth - 40) / 7));
      const lines = [''];
      for (const word of words) {
        if (lines[lines.length - 1]!.length + word.length > maxChars) lines.push('');
        lines[lines.length - 1] += `${word} `;
      }
      lines.forEach((line, i) => label(preview, line.trim(), 20, 79 + i * 20, previewWidth - 40, 13));
      const stageTop = 92 + lines.length * 20;
      stageWidth = previewWidth - 24;
      stageHeight = previewHeight - stageTop - 76;
      stage = preview.add(new GuiScrollView({ id: 'preview-stage', x: 12, y: stageTop, width: stageWidth, height: stageHeight, contentHeight: stageHeight, style: { backgroundColor: '#0b1425', radius: 8 } }));
      label(preview, 'LAST EVENT', 20, previewHeight - 65, previewWidth - 40, 11, colors.accent);
      eventLabel = label(preview, lastEvent, 20, previewHeight - 40, previewWidth - 40, 13, '#cbd5e1');
      const inspectorWidth = stacked ? contentWidth - 12 : 320;
      const inspectorHeight = stacked ? 540 : previewHeight;
      const panel = body.add(new GuiElement({ id: 'inspector-panel', x: stacked ? 0 : previewWidth + 16, y: stacked ? previewHeight + 16 : 0, width: inspectorWidth, height: inspectorHeight, style: { backgroundColor: colors.panel, borderColor: colors.border, radius: 12 } }));
      label(panel, 'PROPERTIES', 20, 14, 160, 12, colors.accent);
      panel.add(new GuiButton({ id: 'reset', x: inspectorWidth - 96, y: 14, width: 76, height: 28, text: 'Reset', variant: 'outline', onClick: () => {
        values = defaults(selected); states.set(selected.name, values);
        requestRefresh('inspector'); record('reset', selected.name);
      } }));
      label(panel, 'Changes apply immediately', 20, 47, inspectorWidth - 40, 13);
      inspector = panel.add(new GuiScrollView({ id: 'inspector', x: 12, y: 86, width: inspectorWidth - 24, height: inspectorHeight - 102, showScrollbar: true }));
      renderInspector();
      renderPreview();
    }

    engine.on('resize', () => requestRefresh('layout'));
    // GUI dispatch runs after layout. Rebuild at the start of the next frame so
    // new controls receive layout and radio-group registration before drawing.
    engine.on('update', () => {
      const refresh = pendingRefresh;
      pendingRefresh = null;
      if (refresh === 'layout') layout();
      else if (refresh) {
        if (refresh === 'inspector') renderInspector();
        renderPreview();
      }
    });
    layout();
    engine.run();
    status.hidden = true;
    canvas.dataset.ready = 'true';
  } catch (error) {
    cleanup();
    throw error;
  }
}

void main().catch(error => {
  console.error(error);
  const status = document.getElementById('status')!;
  status.hidden = false;
  status.textContent = `GUI playground could not start: ${error instanceof Error ? error.message : String(error)}`;
  status.dataset.state = 'error';
});
