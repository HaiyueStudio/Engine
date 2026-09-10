import { GuiElement, GuiDirtyFlags, type GuiRoot, type GuiStyle } from '@haiyue/engine/gui';
import type { VirtualJoystickState } from './contracts';

class Disc extends GuiElement {
  constructor(style: GuiStyle) { super({ disabled: true, style }); }
  override layout(): void { /* Bounds are already in full-surface logical coordinates. */ }
  place(x: number, y: number, radius: number): void {
    if (this.rect.x === x - radius && this.rect.y === y - radius && this.rect.width === radius * 2) return;
    this.rect = { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
    this.markDirty(GuiDirtyFlags.Visual);
  }
}

/** Presentation only: never intercepts pointers or creates another render loop. */
export class JoystickView {
  private readonly base: Disc;
  private readonly knob: Disc;
  constructor(root: GuiRoot, baseStyle: GuiStyle, knobStyle: GuiStyle) {
    this.base = root.add(new Disc({ backgroundColor: '#18334b99', borderColor: '#6aadd5aa', ...baseStyle }));
    this.knob = root.add(new Disc({ backgroundColor: '#82d9f4dd', borderColor: '#d9f6ff', ...knobStyle }));
  }
  update(state: VirtualJoystickState, maxDistance: number, knobRadius: number, visible: boolean): void {
    this.base.setVisible(visible);
    this.knob.setVisible(visible);
    this.base.style.radius = maxDistance + knobRadius;
    this.knob.style.radius = knobRadius;
    this.base.place(state.center.x, state.center.y, maxDistance + knobRadius);
    this.knob.place(state.center.x + state.offset.x, state.center.y + state.offset.y, knobRadius);
  }
  destroy(): void {
    this.base.parent?.remove(this.base);
    this.knob.parent?.remove(this.knob);
  }
}
