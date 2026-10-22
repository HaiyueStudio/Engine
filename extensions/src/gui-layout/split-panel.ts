import {GuiButton, GuiDirtyFlags, GuiElement} from '@haiyue/engine/gui';
import type {GuiPointerEvent} from '@haiyue/engine/gui';
import type {LayoutTrack} from '../layout.js';
import {LayoutError} from '../layout.js';
import {createGuiContainer, ownContentFrame, setContainerStyle} from './presets.js';
import {finiteNonnegative, ratioValue, stateRecord} from './panel-state.js';
import type {GuiSplitPanelOptions} from './panel-types.js';

/** Composite geometry is expressed as Grid tracks, using the same core as ordinary GUI/HYA. */
export class GuiSplitPanel {
  readonly element: GuiElement;
  readonly divider: GuiButton;
  readonly firstPane: GuiElement;
  readonly secondPane: GuiElement;
  readonly axis: 'horizontal' | 'vertical';
  private value: number;
  private readonly minimumFirst: number;
  private readonly minimumSecond: number;
  private readonly dividerSize: number;
  private readonly keyboardStep: number;
  private callback: ((ratio: number) => void) | undefined;
  private drag: {pointer: number; offset: number; initial: number; start: number; moved: boolean} | null = null;
  private readonly releaseFrames: readonly (() => void)[];
  private disposed = false;

  constructor(options: GuiSplitPanelOptions) {
    if (!options || !['horizontal', 'vertical'].includes(options.axis)) throw new LayoutError('invalid-input', 'Invalid split axis.');
    if (!(options.first instanceof GuiElement) || !(options.second instanceof GuiElement) || options.first === options.second ||
        options.first.parent || options.second.parent) throw new LayoutError('invalid-input', 'Split contents must be distinct unattached GUI elements.');
    this.axis = options.axis;
    this.value = ratioValue(options.ratio);
    this.minimumFirst = finiteNonnegative(options.minimumFirst ?? 0, 'First minimum');
    this.minimumSecond = finiteNonnegative(options.minimumSecond ?? 0, 'Second minimum');
    this.dividerSize = finiteNonnegative(options.dividerSize ?? 10, 'Divider size');
    this.keyboardStep = finiteNonnegative(options.keyboardStep ?? 0.02, 'Keyboard step');
    if (!this.dividerSize || !this.keyboardStep || this.keyboardStep > 1) throw new LayoutError('invalid-input', 'Divider size and keyboard step must be positive; step cannot exceed one.');
    this.callback = options.onRatioChange;
    this.element = createGuiContainer('grid', {...(options.id === undefined ? {} : {id: options.id}), style: {width: 'auto', height: 'auto'}});
    if (options.style) this.element.setStyle(options.style);
    this.firstPane = this.element.add(createGuiContainer('grid', {id: `${this.element.id}:first`, style: {width: 'auto', height: 'auto', columns: [{fr: 1}], rows: [{fr: 1}]}}));
    this.divider = this.element.add(new GuiButton({id: `${this.element.id}:divider`, text: this.axis === 'horizontal' ? '|' : '-',
      themeControlType: 'GuiSplitDivider',
      onPointerDown: event => this.begin(event), onPointerMove: event => this.move(event),
      onPointerUp: event => {if (this.drag?.pointer === event.pointerId) {this.move(event); this.drag = null;}},
      onPointerCancel: event => {if (this.drag?.pointer === event.pointerId) {const value = this.drag.initial; this.drag = null; this.setRatio(value);}},
      onAction: event => {
        const negative = this.axis === 'horizontal' ? 'left' : 'up', positive = this.axis === 'horizontal' ? 'right' : 'down';
        if (!this.disposed && (event.action === negative || event.action === positive)) {
          this.setRatio(this.effectiveRatio + (event.action === negative ? -1 : 1) * this.keyboardStep); event.consume();
        }
      }}));
    this.secondPane = this.element.add(createGuiContainer('grid', {id: `${this.element.id}:second`, style: {width: 'auto', height: 'auto', columns: [{fr: 1}], rows: [{fr: 1}]}}));
    const firstRelease = ownContentFrame(options.first);
    try {this.releaseFrames = [firstRelease, ownContentFrame(options.second)];}
    catch (error) {firstRelease(); throw error;}
    this.firstPane.add(options.first); this.secondPane.add(options.second);
    setContainerStyle(this.divider, {width: 'auto', height: 'auto', minWidth: 0, minHeight: 0});
    this.updateTracks();
  }

  /** Preferred fraction, retained across a constrained or temporarily zero-sized viewport. */
  get ratio(): number {return this.value;}
  get effectiveRatio(): number {
    const first = this.axis === 'horizontal' ? this.firstPane.rect.width : this.firstPane.rect.height;
    const second = this.axis === 'horizontal' ? this.secondPane.rect.width : this.secondPane.rect.height;
    return first + second > 0 ? first / (first + second) : this.value;
  }
  setRatio(value: number): void {
    this.assertLive(); const next = ratioValue(value);
    if (next === this.value) return;
    this.value = next; this.updateTracks(); this.element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
    this.callback?.(next);
  }
  serialize(): {readonly version: 1; readonly type: 'gui-split-panel'; readonly axis: 'horizontal' | 'vertical'; readonly ratio: number} {
    this.assertLive(); return {version: 1, type: 'gui-split-panel', axis: this.axis, ratio: this.value};
  }
  restore(value: unknown): void {
    this.assertLive(); const state = stateRecord(value, 'gui-split-panel', ['version', 'type', 'axis', 'ratio']);
    if (state.axis !== this.axis || typeof state.ratio !== 'number' || state.ratio < 0 || state.ratio > 1) throw new LayoutError('invalid-input', 'Split state does not match this panel.');
    this.setRatio(state.ratio);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.drag = null; this.callback = undefined;
    this.element.parent?.remove(this.element);
    this.divider.setDisabled(true);
    for (const host of [this.firstPane, this.secondPane]) for (const child of [...host.children]) host.remove(child);
    for (const release of this.releaseFrames) release();
  }
  private updateTracks(): void {
    // Every nonzero weight is at least one. Fractional CSS fr totals below one
    // intentionally leave space unused after another track hits its minimum.
    const unit = Math.min(this.value || 1, (1 - this.value) || 1);
    const track = (min: number, fraction: number): LayoutTrack => fraction === 0 ? min : {min, max: {fr: Math.min(Number.MAX_VALUE / 4, fraction / unit)}};
    const tracks = [track(this.minimumFirst, this.value), this.dividerSize, track(this.minimumSecond, 1 - this.value)];
    setContainerStyle(this.element, {display: 'grid', width: 'auto', height: 'auto',
      columns: this.axis === 'horizontal' ? tracks : [{fr: 1}], rows: this.axis === 'vertical' ? tracks : [{fr: 1}]});
  }
  private coordinate(event: GuiPointerEvent): number {return this.axis === 'horizontal' ? event.x : event.y;}
  private begin(event: GuiPointerEvent): void {
    if (this.disposed || this.drag || event.button !== 0) return;
    this.drag = {pointer: event.pointerId, initial: this.value, start: this.coordinate(event), moved: false,
      offset: this.coordinate(event) - (this.axis === 'horizontal' ? this.divider.rect.x : this.divider.rect.y)};
    event.preventDefault();
  }
  private move(event: GuiPointerEvent): void {
    if (this.disposed || this.drag?.pointer !== event.pointerId) return;
    if (!this.drag.moved && this.coordinate(event) === this.drag.start) return;
    this.drag.moved = true;
    const horizontal = this.axis === 'horizontal';
    const available = horizontal ? this.firstPane.rect.width + this.secondPane.rect.width : this.firstPane.rect.height + this.secondPane.rect.height;
    if (available <= 0 || available <= this.minimumFirst + this.minimumSecond) return;
    const start = horizontal ? this.firstPane.rect.x : this.firstPane.rect.y;
    const position = Math.max(this.minimumFirst, Math.min(available - this.minimumSecond, this.coordinate(event) - this.drag.offset - start));
    this.setRatio(position / available); event.preventDefault();
  }
  private assertLive(): void {if (this.disposed) throw new LayoutError('disposed', 'GUI split panel has been disposed.');}
}
