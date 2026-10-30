import {GuiRoot} from '../components/GuiRoot';
import {GuiElement} from '../components/GuiElement';
import {GuiDirtyFlags} from '../GuiTypes';
import {markGuiOverlayRoot} from '../rendering/GuiOverlayRoots';

class PreviewFrame extends GuiElement {
  place(x: number, y: number): void {
    if (this.x === x && this.y === y) return;
    this.x = x; this.y = y; this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }
}

/** Only the ephemeral GUI attachment is owned here; source images/textures remain borrowed. */
export class GuiDragPreview {
  private current: {root: GuiRoot; frame: PreviewFrame; preview: GuiElement; off: () => void} | null = null;
  constructor(private readonly changed: () => void,
      private readonly local: (point: Readonly<{x: number; y: number}>) => {x: number; y: number} | null = point => point) {}
  get root(): GuiRoot | null {return this.current?.root ?? null;}
  show(preview: GuiElement, sourceRoot: GuiRoot | null, point: Readonly<{x: number; y: number}>): void {
    if (this.current || !(preview instanceof GuiElement) || preview.parent) throw new TypeError('A GUI drag preview must be an unattached element.');
    const root = new GuiRoot({theme: sourceRoot?.theme, pointerFilter: 'ignore', themeResource: sourceRoot?.root.themeResource ?? null});
    markGuiOverlayRoot(root);
    const frame = root.add(new PreviewFrame({width: '100%', height: '100%', pointerFilter: 'ignore'}));
    const off = root.onInvalidation(() => this.changed());
    this.current = {root, frame, preview, off};
    try {frame.add(preview); this.move(point); this.changed();}
    catch (error) {this.hide(preview); throw error;}
  }
  move(point: Readonly<{x: number; y: number}>): void {
    const local = this.local({x: point.x + 12, y: point.y + 12});
    if (local) this.current?.frame.place(local.x, local.y);
  }
  hide(preview?: GuiElement): void {
    const current = this.current;
    if (!current || (preview && current.preview !== preview)) return;
    this.current = null;
    try {current.frame.remove(current.preview);}
    finally {try {current.off(); current.root.destroy();} finally {this.changed();}}
  }
}
