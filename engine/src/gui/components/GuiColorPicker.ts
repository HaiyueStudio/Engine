import { GuiElement } from './GuiElement';
import { GuiInput } from './GuiInput';
import { GuiLabel } from './GuiLabel';
import { GuiSlider } from './GuiSlider';
import { GuiDirtyFlags, type GuiElementOptions, type GuiRect, type GuiValueChangeHandler } from '../GuiTypes';

export interface GuiColorPickerOptions extends GuiElementOptions {
  /** Opaque RGB color, in #rgb or #rrggbb form. Defaults to #2563eb. */
  value?: string;
  onChange?: GuiValueChangeHandler<string>;
  onCommit?: GuiValueChangeHandler<string>;
}

/** Engine-rendered RGB editor. Its swatch, HEX input and sliders need no DOM color dialog. */
export class GuiColorPicker extends GuiElement {
  private currentValue = '#2563eb';
  private readonly swatch: GuiElement;
  private readonly hexInput: GuiInput;
  private readonly channelLabels: GuiLabel[];
  private readonly channelSliders: GuiSlider[];
  onChange: GuiValueChangeHandler<string> | null;
  onCommit: GuiValueChangeHandler<string> | null;

  constructor(options: GuiColorPickerOptions = {}) {
    super({ width: 240, height: 144, ...options });
    this.currentValue = normalizeHex(options.value ?? '') ?? this.currentValue;
    this.onChange = options.onChange ?? null;
    this.onCommit = options.onCommit ?? null;
    this.swatch = this.add(new GuiElement({ id: `${this.id}-swatch`, width: '100%', height: '100%', disabled: true, style: { radius: 6 } }));
    this.hexInput = this.add(new GuiInput({
      id: `${this.id}-hex`, width: '100%', height: '100%', value: this.currentValue,
      placeholder: '#rrggbb',
      onChange: value => {
        const normalized = normalizeHex(value);
        this.hexInput.setStyle({ borderColor: normalized ? '#475569' : '#ef4444' });
        if (normalized) this.updateValue(normalized, true, true);
      },
      onSubmit: value => {
        const normalized = normalizeHex(value);
        this.hexInput.setValue(this.currentValue);
        this.hexInput.setStyle({ borderColor: '#475569' });
        if (normalized) this.onCommit?.(this.currentValue);
      },
    }));
    this.channelLabels = ['R', 'G', 'B'].map(channel => this.add(new GuiLabel({
      id: `${this.id}-${channel}-label`, width: '100%', height: '100%', fontSize: 12,
    })));
    this.channelSliders = ['R', 'G', 'B'].map((channel, index) => this.add(new GuiSlider({
      id: `${this.id}-${channel}`, width: '100%', height: '100%', min: 0, max: 255, step: 1,
      onChange: value => {
        const channels = this.channels();
        channels[index] = value;
        this.setValue(`#${channels.map(v => v.toString(16).padStart(2, '0')).join('')}`, true);
      },
      onCommit: () => this.onCommit?.(this.currentValue),
    })));
    this.syncControls(false);
    this.setDisabled(this.disabled);
  }

  /** Canonical lowercase #rrggbb. Use setValue to change the color. */
  get value(): string { return this.currentValue; }

  /** Invalid input is ignored; programmatic changes are silent unless emit is true. */
  setValue(value: string, emit = false): void {
    const normalized = normalizeHex(value);
    if (normalized) this.updateValue(normalized, emit, false);
  }

  override setDisabled(disabled: boolean): void {
    super.setDisabled(disabled);
    this.hexInput.setDisabled(disabled);
    this.hexInput.readOnly = disabled;
    for (const slider of this.channelSliders) slider.setDisabled(disabled);
    this.swatch.setStyle({ opacity: disabled ? 0.45 : 1 });
  }

  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    const { x, y, width, height } = this.rect;
    const header = Math.min(32, height);
    const swatchWidth = Math.min(36, width * 0.25);
    this.swatch.layout({ x, y, width: swatchWidth, height: header });
    this.hexInput.layout({ x: x + swatchWidth + 8, y, width: Math.max(0, width - swatchWidth - 8), height: header });
    const rowHeight = Math.max(0, (height - header - 8) / 3);
    this.channelSliders.forEach((slider, index) => {
      const rowY = y + header + 8 + rowHeight * index;
      this.channelLabels[index]!.layout({ x, y: rowY, width: Math.min(50, width), height: rowHeight });
      slider.layout({ x: x + 60, y: rowY + Math.max(0, (rowHeight - 24) / 2), width: Math.max(0, width - 70), height: Math.min(24, rowHeight) });
    });
  }

  private channels(): number[] {
    return [1, 3, 5].map(offset => Number.parseInt(this.currentValue.slice(offset, offset + 2), 16));
  }

  private updateValue(value: string, emit: boolean, preserveInput: boolean): void {
    if (this.currentValue === value) return;
    this.currentValue = value;
    this.syncControls(preserveInput);
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(value);
  }

  private syncControls(preserveInput: boolean): void {
    this.swatch.setStyle({ backgroundColor: this.currentValue });
    if (!preserveInput) {
      this.hexInput.setValue(this.currentValue);
      this.hexInput.setStyle({ borderColor: '#475569' });
    }
    this.channels().forEach((value, index) => {
      this.channelLabels[index]!.setText(`${['R', 'G', 'B'][index]} ${value}`);
      this.channelSliders[index]!.setValue(value);
    });
  }
}

function normalizeHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map(char => char + char).join('')}`;
  return null;
}
