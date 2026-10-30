import type {GuiRoot} from '../components/GuiRoot';

const overlays = new WeakSet<GuiRoot>();
/** Private rendering ownership; these roots never join the input/focus tree. */
export function markGuiOverlayRoot(root: GuiRoot): void {overlays.add(root);}
export function isGuiOverlayRoot(root: GuiRoot): boolean {return overlays.has(root);}
