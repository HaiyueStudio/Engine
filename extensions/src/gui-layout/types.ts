import type {GuiElement} from '@haiyue/engine/gui';
import type {LayoutConstraints, LayoutLimits, LayoutMeasure, LayoutStyle} from '../layout.js';

export interface GuiLayoutOptions {readonly measure: LayoutMeasure; readonly limits?: Partial<LayoutLimits>;}
/** Adapter metadata is lowered before the source-independent core sees a style. */
export interface GuiLayoutStyle extends LayoutStyle {
  readonly anchors?: {readonly left: number; readonly top: number; readonly right: number; readonly bottom: number};
  readonly offsets?: {readonly left?: number; readonly top?: number; readonly right?: number; readonly bottom?: number};
  readonly contentMinimum?: boolean;
}
export interface GuiLayoutBinding {setStyle(element: GuiElement, style: GuiLayoutStyle): void; invalidate(element: GuiElement): void; dispose(): void;}
export type GuiContainerPreset = 'row' | 'column' | 'flow' | 'grid' | 'margin' | 'center';
export interface GuiLayoutMeasurement {readonly contentVersion: number; readonly metricsVersion: number; measure(constraints: LayoutConstraints): ReturnType<LayoutMeasure>;}
