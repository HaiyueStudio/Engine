import type {GuiStyle, GuiElementOptions} from './GuiTypes';
import type {GuiImageSource} from './components/GuiImage';

export type GuiThemeState = Readonly<{hover: boolean; focus: boolean; pressed: boolean; disabled: boolean}>;

export interface GuiNineSliceOptions extends GuiElementOptions {
  readonly source: GuiImageSource;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly cuts: readonly [number, number, number, number];
  readonly uv?: readonly [number, number, number, number];
  readonly contentInsets?: Readonly<{top: number; right: number; bottom: number; left: number}>;
  readonly pixelRatio?: number;
  readonly tint?: string;
}

export interface GuiSkin extends Readonly<GuiStyle> {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly icon?: GuiImageSource;
  readonly iconSize?: number;
  readonly contentInsets?: Readonly<{top: number; right: number; bottom: number; left: number}>;
  readonly nineSlice?: GuiNineSliceOptions;
}

/** Structural contract also supports application-owned resource providers. */
export interface GuiThemeResourceBinding {
  readonly version: number;
  resolve(controlType: string, state: GuiThemeState): GuiSkin;
  subscribe(changed: () => void): () => void;
}
