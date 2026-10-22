import type {GuiElement} from './components/GuiElement';

/** Payloads and resources stay application-owned; all callbacks are synchronous. */
export interface GuiDragSource {
  getData(): unknown;
  createPreview?(): GuiElement;
  /** Release application-created preview bindings after Engine detaches the preview. */
  disposePreview?(preview: GuiElement): void;
  onEnd?(accepted: boolean): void;
  /** Auto preserves vertical touch scrolling; a dedicated handle can explicitly own touch dragging. */
  readonly touchGesture?: 'auto' | 'drag';
}

export interface GuiDropTarget {
  /** Position is in target-local logical pixels, independent of CSS scale and device pixel ratio. */
  canDrop(data: unknown, position: Readonly<{x: number; y: number}>): boolean;
  drop(data: unknown, position: Readonly<{x: number; y: number}>): void;
  onHoverChange?(hovered: boolean, accepted: boolean): void;
}

export interface GuiDragSession {
  readonly pointerId?: number;
  readonly sourceId: string;
  readonly targetId: string | null;
  cancel(): void;
}
