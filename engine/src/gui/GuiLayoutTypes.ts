import type {GuiElement} from './components/GuiElement';
import type {GuiRect} from './GuiTypes';

export interface GuiMeasureConstraint {readonly mode: 'exact' | 'at-most' | 'unbounded'; readonly value?: number;}
export interface GuiLayoutDelegate {
  measure(element: GuiElement, width: GuiMeasureConstraint, height: GuiMeasureConstraint): {readonly width: number; readonly height: number};
  arrange(root: GuiElement, viewport: GuiRect, commit: (element: GuiElement, rect: GuiRect, options?: {readonly display?: 'none'; readonly contentHeight?: number}) => void): void;
  dispose(): void;
  /** Drop transient measurement/resource caches while preserving logical attachment. */
  suspend?(): void;
}
export type GuiInvalidationReason = 'layout' | 'paint' | 'input' | 'animation' | 'resource';
export interface GuiInvalidation {
  readonly generation: number;
  readonly reasons: readonly GuiInvalidationReason[];
  readonly previousBounds?: GuiRect;
  readonly nextBounds?: GuiRect;
  readonly activeAnimation: boolean;
}
