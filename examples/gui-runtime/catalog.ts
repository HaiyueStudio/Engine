import {
  GuiButton, GuiCheckbox, GuiColorPicker, GuiElement, GuiHelpDialog, GuiImage, GuiInput, GuiLabel,
  GuiModal, GuiProgress, GuiRadio, GuiScrollView, GuiSelect, GuiSlider, GuiSwitch,
  GuiTooltip, GuiTree, type GuiElementOptions, type GuiStyle,
} from '@haiyue/engine/gui';

export type Value = string | number | boolean;
export type Values = Record<string, Value>;
export type Parameter =
  | { key: string; kind: 'number'; initial: number; min: number; max: number; step: number }
  | { key: string; kind: 'boolean'; initial: boolean }
  | { key: string; kind: 'text'; initial: string }
  | { key: string; kind: 'color'; initial: string }
  | { key: string; kind: 'choice'; initial: string; options: string[] };
export interface Demo {
  name: string;
  hint: string;
  parameters: Parameter[];
  create: (values: Values, options: GuiElementOptions, change: Change) => GuiElement;
}
type Change = (key: string, value: Value) => void;
const number = (key: string, initial: number, min: number, max: number, step = 1): Parameter =>
  ({ key, kind: 'number', initial, min, max, step });
const boolean = (key: string, initial: boolean): Parameter => ({ key, kind: 'boolean', initial });
const text = (key: string, initial: string): Parameter => ({ key, kind: 'text', initial });
const color = (key: string, initial: string): Parameter => ({ key, kind: 'color', initial });
const choice = (key: string, initial: string, options: string[]): Parameter => ({ key, kind: 'choice', initial, options });
const n = (p: Values, key: string): number => Number(p[key]);
const s = (p: Values, key: string): string => String(p[key]);
const b = (p: Values, key: string): boolean => p[key] === true;
const size = (width = 240, height = 36): Parameter[] => [number('width', width, 48, 320), number('height', height, 16, 260)];
const range = (): Parameter[] => [number('value', 40, 0, 100), number('min', 0, 0, 99), number('max', 100, 1, 100)];
const options = ['Ocean', 'Forest', 'Sunset', 'Midnight', 'Lavender', 'Amber', 'Rose', 'Slate'];

/** One reusable, local image source; parameter changes do not allocate GPU textures. */
function createImage(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, '#38bdf8');
  gradient.addColorStop(1, '#6366f1');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#e0f2fe';
  ctx.beginPath();
  ctx.arc(178, 70, 27, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#164e63';
  ctx.beginPath();
  ctx.moveTo(0, 230); ctx.lineTo(95, 94); ctx.lineTo(206, 256); ctx.lineTo(0, 256); ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.moveTo(115, 256); ctx.lineTo(204, 147); ctx.lineTo(256, 209); ctx.lineTo(256, 256); ctx.fill();
  return canvas;
}

export function createCatalog(): Demo[] {
  const source = createImage();
  const demos: Demo[] = [
    {
      name: 'GuiButton', hint: 'Click the button to see its event below.',
      parameters: [...size(200), text('text', 'Hello, Engine'), choice('variant', 'primary', ['default', 'primary', 'danger', 'outline'])],
      create: (p, o, change) => new GuiButton({ ...o, text: s(p, 'text'), variant: s(p, 'variant') as 'primary', onClick: () => change('clicks', n(p, 'clicks') + 1) }),
    },
    {
      name: 'GuiColorPicker', hint: 'Edit HEX or drag RGB channels. Enter confirms HEX.',
      parameters: [number('width', 280, 180, 320), number('height', 144, 128, 240), color('value', '#2563eb')],
      create: (p, o, change) => new GuiColorPicker({ ...o, value: s(p, 'value'), onChange: v => change('value', v), onCommit: v => change('commit', v) }),
    },
    {
      name: 'GuiCheckbox', hint: 'Toggle here or in the inspector. Both stay in sync.',
      parameters: [...size(), text('label', 'Enable shadows'), boolean('checked', true)],
      create: (p, o, change) => new GuiCheckbox({ ...o, label: s(p, 'label'), checked: b(p, 'checked'), onChange: v => change('checked', v) }),
    },
    {
      name: 'GuiSwitch', hint: 'Click the switch to preview the transition timing.',
      parameters: [...size(64, 32), boolean('checked', true), number('thumbTransitionMs', 220, 0, 1000, 20), number('colorTransitionMs', 220, 0, 1000, 20)],
      create: (p, o, change) => new GuiSwitch({ ...o, checked: b(p, 'checked'), thumbTransitionMs: n(p, 'thumbTransitionMs'), colorTransitionMs: n(p, 'colorTransitionMs'), onChange: v => change('checked', v) }),
    },
    {
      name: 'GuiSlider', hint: 'Drag the thumb. The inspector follows its value.',
      parameters: [...size(), ...range(), number('step', 1, 1, 20)],
      create: (p, o, change) => new GuiSlider({ ...o, value: n(p, 'value'), min: n(p, 'min'), max: n(p, 'max'), step: n(p, 'step'), onChange: v => change('value', v) }),
    },
    {
      name: 'GuiProgress', hint: 'Adjust value, range and text visibility in the inspector.',
      parameters: [...size(260, 24), ...range(), boolean('showText', true)],
      create: (p, o) => new GuiProgress({ ...o, value: n(p, 'value'), min: n(p, 'min'), max: n(p, 'max'), showText: b(p, 'showText') }),
    },
    {
      name: 'GuiInput', hint: 'Click to type; press Enter to submit.',
      parameters: [...size(), text('value', 'Hello, Engine'), text('placeholder', 'Type something...'), boolean('readOnly', false)],
      create: (p, o, change) => new GuiInput({ ...o, value: s(p, 'value'), placeholder: s(p, 'placeholder'), readOnly: b(p, 'readOnly'), onChange: v => change('value', v), onSubmit: v => change('submit', v) }),
    },
    {
      name: 'GuiRadio', hint: 'Three radio buttons share one group.',
      parameters: [...size(200, 32), choice('value', 'Medium', ['Small', 'Medium', 'Large'])],
      create: (p, o, change) => {
        const group = new GuiElement({ ...o, style: undefined, height: n(p, 'height') * 3 });
        ['Small', 'Medium', 'Large'].forEach((value, i) => group.add(new GuiRadio({
          ...o, x: 0, y: i * n(p, 'height'), id: `preview-radio-${value}`, label: value,
          group: 'preview-size', value, checked: p.value === value, onChange: v => change('value', v),
        })));
        return group;
      },
    },
    {
      name: 'GuiSelect', hint: 'Open the menu; scroll to see the remaining options.',
      parameters: [...size(), choice('value', 'Ocean', options), number('optionHeight', 30, 22, 44), number('maxVisibleOptions', 4, 2, 8)],
      create: (p, o, change) => new GuiSelect({ ...o, value: s(p, 'value'), options: options.map(value => ({ label: value, value })), optionHeight: n(p, 'optionHeight'), maxVisibleOptions: n(p, 'maxVisibleOptions'), onChange: v => change('value', v) }),
    },
    {
      name: 'GuiLabel', hint: 'Change text, font size and alignment.',
      parameters: [...size(280, 64), text('text', 'Made with Haiyue'), number('fontSize', 24, 12, 40), choice('textAlign', 'center', ['left', 'center', 'right'])],
      create: (p, o) => new GuiLabel({ ...o, text: s(p, 'text'), fontSize: n(p, 'fontSize'), textAlign: s(p, 'textAlign') as 'center' }),
    },
    {
      name: 'GuiImage', hint: 'A local canvas image with tint and UV cropping.',
      parameters: [...size(220, 220), color('tint', '#ffffff'), number('crop', 0, 0, 0.4, 0.05)],
      create: (p, o) => new GuiImage({ ...o, source, sourceKey: 'gui-playground-image', tint: s(p, 'tint'), uv: [n(p, 'crop'), n(p, 'crop'), 1 - n(p, 'crop'), 1 - n(p, 'crop')] }),
    },
    {
      name: 'GuiTree', hint: 'Expand branches and select a node.',
      parameters: [...size(280, 240), number('rowHeight', 30, 22, 40), number('indent', 20, 8, 36), boolean('expanded', true)],
      create: (p, o, change) => new GuiTree({
        ...o, rowHeight: n(p, 'rowHeight'), indent: n(p, 'indent'), selectedKey: s(p, 'selectedKey'),
        expandedKeys: b(p, 'expanded') ? ['scene', 'assets'] : [],
        nodes: [
          { key: 'scene', label: 'Scene', children: [{ key: 'camera', label: 'Camera' }, { key: 'light', label: 'Light' }, { key: 'mesh', label: 'Mesh' }] },
          { key: 'assets', label: 'Assets', children: [{ key: 'textures', label: 'Textures' }, { key: 'materials', label: 'Materials' }] },
        ],
        onSelect: node => change('selectedKey', node.key),
        onExpand: keys => change('expand', keys.join(', ') || 'none'),
      }),
    },
    {
      name: 'GuiTooltip', hint: 'Hover over the button to reveal the tooltip.',
      parameters: [...size(200, 36), text('content', 'Hello from GuiTooltip'), choice('placement', 'top', ['top', 'right', 'bottom', 'left']), number('delay', 200, 0, 1500, 50)],
      create: (p, o) => {
        const host = new GuiElement({ ...o, style: undefined, width: 160, height: 36 });
        const target = host.add(new GuiButton({ width: 160, height: 36, text: 'Hover over me', disabled: o.disabled }));
        host.add(new GuiTooltip({ ...o, target, content: s(p, 'content'), placement: s(p, 'placement') as 'top', delay: n(p, 'delay') }));
        return host;
      },
    },
    {
      name: 'GuiScrollView', hint: 'Scroll or drag the list; try inertia.',
      parameters: [...size(260, 230), number('items', 12, 4, 24), boolean('showScrollbar', true), boolean('inertia', true), number('inertiaStrength', 1, 0.2, 3, 0.1)],
      create: (p, o, change) => {
        const view = new GuiScrollView({ ...o, contentHeight: n(p, 'items') * 44 + 12, showScrollbar: b(p, 'showScrollbar'), inertia: b(p, 'inertia'), inertiaStrength: n(p, 'inertiaStrength') });
        for (let i = 0; i < n(p, 'items'); i++) view.add(new GuiButton({ x: 10, y: 10 + i * 44, width: n(p, 'width') - 34, height: 34, text: `Item ${String(i + 1).padStart(2, '0')}`, onClick: () => change('item', i + 1) }));
        return view;
      },
    },
    ...(['GuiModal', 'GuiHelpDialog'] as const).map(name => ({
      name, hint: 'Open the dialog after changing its settings.',
      parameters: [text('title', name === 'GuiModal' ? 'Confirm action' : 'Welcome to Engine GUI'), text('message', name === 'GuiModal' ? 'Your changes are ready to apply.' : 'Choose a component using the selector. Edit its properties in the inspector. Interact with the preview to see events. Each component keeps its settings when you switch. Reset restores the defaults. This help dialog wraps longer text and supports scrolling.'), number('width', 420, 260, 600), number('height', name === 'GuiModal' ? 230 : 320, 200, 460), boolean('closeOnBackdrop', true), ...(name === 'GuiModal' ? [text('confirmText', 'Apply'), text('cancelText', 'Cancel')] : [])],
      create: (p: Values, o: GuiElementOptions, change: Change) => {
        const dialogOptions = { ...o, title: s(p, 'title'), message: s(p, 'message'), closeOnBackdrop: b(p, 'closeOnBackdrop'), confirmText: s(p, 'confirmText'), cancelText: s(p, 'cancelText'), onClose: (reason: string) => change('close', reason) };
        return name === 'GuiModal' ? new GuiModal(dialogOptions) : new GuiHelpDialog(dialogOptions);
      },
    })),
  ];
  for (const demo of demos) {
    const styles = colorStyles[demo.name];
    if (styles) demo.parameters.push(boolean('customColors', false), ...Object.entries(styles).map(([key, value]) => color(`style.${key}`, value)));
  }
  return demos;
}

// Only expose style channels currently consumed by each component's renderer.
const colorStyles: Record<string, Record<string, string>> = {
  GuiButton: { backgroundColor: '#2563eb', color: '#ffffff', borderColor: '#475569', hoverBackgroundColor: '#3b82f6' },
  GuiCheckbox: { backgroundColor: '#2563eb', borderColor: '#475569' },
  GuiSwitch: { backgroundColor: '#2563eb' },
  GuiSlider: { backgroundColor: '#475569' },
  GuiProgress: { backgroundColor: '#475569' },
  GuiInput: { backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiRadio: { backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiSelect: { backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiLabel: { color: '#f8fafc', backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiTree: { backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiTooltip: { backgroundColor: '#020617' },
  GuiScrollView: { backgroundColor: '#1e293b', borderColor: '#475569' },
  GuiModal: { backgroundColor: '#f8fafc', borderColor: '#cbd5e1' },
  GuiHelpDialog: { backgroundColor: '#f8fafc', borderColor: '#cbd5e1' },
};

export function previewStyle(demo: Demo, values: Values): GuiStyle | undefined {
  if (!values.customColors) return undefined;
  return Object.fromEntries(Object.keys(colorStyles[demo.name] ?? {}).map(key => [key, String(values[`style.${key}`])])) as GuiStyle;
}

export function defaults(demo: Demo): Values {
  return Object.fromEntries([['clicks', 0], ['selectedKey', 'mesh'], ...demo.parameters.map(p => [p.key, p.initial]), ['disabled', false]]);
}

/** Keep a valid range even while its endpoints are being edited. */
export function normalize(demo: Demo, values: Values, key: string): void {
  if (demo.name !== 'GuiSlider' && demo.name !== 'GuiProgress') return;
  if (n(values, 'min') >= n(values, 'max')) {
    if (key === 'min') values.max = n(values, 'min') + 1;
    else values.min = n(values, 'max') - 1;
  }
  const value = n(values, 'value');
  const step = demo.name === 'GuiSlider' ? n(values, 'step') : 0;
  values.value = Math.min(n(values, 'max'), Math.max(n(values, 'min'), step ? Math.round(value / step) * step : value));
}
