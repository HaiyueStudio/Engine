import type { CompiledFontMetrics, TextBlockDefinition, TextShapingContract, TextStyleDefinition } from '../../text2d/parameterized/types.js';

export const LAYOUT_EXTENSION_ID = 'org.haiyue.layout-2d@1' as const;
export const LAYOUT_FORMAT = 'haiyue-responsive-layout-2d' as const;
export const LAYOUT_VERSION = 1 as const;

export type LayoutLength = { readonly unit: 'point' | 'percent' | 'fraction'; readonly value: number } | { readonly unit: 'hug' | 'fill' };
export type LayoutEdge = readonly [LayoutLength, LayoutLength, LayoutLength, LayoutLength];
export type LayoutColor = readonly [number, number, number, number];

export interface LayoutLimits { readonly maxInputBytes: number; readonly maxMetadataBytes: number; readonly maxAssets: number; readonly maxAssetBytes: number; readonly maxTotalAssetBytes: number; readonly maxArtboards: number; readonly maxNodes: number; readonly maxTextBytes: number; readonly maxGlyphs: number; readonly maxLines: number; readonly maxLayoutPasses: number; readonly maxNestedDepth: number; readonly maxComponentInstances: number; readonly maxListItems: number; readonly maxVirtualizedWindow: number; readonly maxNslicePatches: number; readonly maxGpuBytes: number; }

export type LayoutAssetSource =
  | { readonly kind: 'embedded'; readonly data: readonly number[] | Uint8Array; readonly integrity: string }
  | { readonly kind: 'referenced'; readonly uri: string; readonly integrity: string }
  | { readonly kind: 'hosted'; readonly slot: string; readonly fallbackAsset?: string; readonly integrity?: string };
interface LayoutAssetBase { readonly id: string; readonly name?: string; readonly mimeType?: string; readonly source?: LayoutAssetSource; }
export interface LayoutFolderAsset extends LayoutAssetBase { readonly kind: 'folder'; readonly children: readonly string[]; }
export interface LayoutImageAsset extends LayoutAssetBase { readonly kind: 'image'; readonly source: LayoutAssetSource; readonly width: number; readonly height: number; readonly filter?: 'nearest' | 'linear'; readonly wrapX?: 'clamp' | 'repeat' | 'mirror'; readonly wrapY?: 'clamp' | 'repeat' | 'mirror'; }
export interface LayoutFontAsset extends LayoutAssetBase { readonly kind: 'font'; readonly source: LayoutAssetSource; readonly family: string; readonly weight: number; readonly style: 'normal' | 'italic'; readonly metrics: CompiledFontMetrics; }
export interface LayoutAudioAsset extends LayoutAssetBase { readonly kind: 'audio'; readonly source: LayoutAssetSource; readonly duration: number; readonly sampleRate: number; readonly channels: number; }
export interface LayoutBlobAsset extends LayoutAssetBase { readonly kind: 'blob'; readonly source: LayoutAssetSource; readonly signature?: string; }
export interface LayoutManifestAsset extends LayoutAssetBase { readonly kind: 'manifest'; readonly source: LayoutAssetSource; readonly entries: Readonly<Record<string, string>>; }
export interface LayoutTextAsset extends LayoutAssetBase { readonly kind: 'text'; readonly source: LayoutAssetSource; readonly folderPath?: string; readonly encoding?: 'utf-8'; }
export type LayoutAsset = LayoutFolderAsset | LayoutImageAsset | LayoutFontAsset | LayoutAudioAsset | LayoutBlobAsset | LayoutManifestAsset | LayoutTextAsset;

export interface LayoutVisualStyle { readonly opacity?: number; readonly background?: LayoutColor; readonly borderColor?: LayoutColor; readonly borderWidth?: readonly [number, number, number, number]; readonly cornerRadius?: readonly [number, number, number, number]; readonly clip?: boolean; }
export interface LayoutGridTrack { readonly min: LayoutLength; readonly max?: LayoutLength; }
export interface LayoutGridPlacement { readonly column: number; readonly row: number; readonly columnSpan?: number; readonly rowSpan?: number; }
export interface LayoutStyle {
  readonly display?: 'flex' | 'grid' | 'none'; readonly position?: 'relative' | 'absolute'; readonly direction?: 'row' | 'column'; readonly writingDirection?: 'ltr' | 'rtl'; readonly wrap?: boolean;
  readonly width?: LayoutLength; readonly height?: LayoutLength; readonly minWidth?: LayoutLength; readonly maxWidth?: LayoutLength; readonly minHeight?: LayoutLength; readonly maxHeight?: LayoutLength; readonly aspectRatio?: number;
  readonly margin?: LayoutEdge; readonly padding?: LayoutEdge; readonly inset?: LayoutEdge; readonly gap?: readonly [LayoutLength, LayoutLength];
  readonly justify?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly'; readonly align?: 'start' | 'center' | 'end' | 'stretch'; readonly justifySelf?: 'auto' | 'start' | 'center' | 'end' | 'stretch'; readonly overflow?: 'visible' | 'hidden' | 'scroll';
  readonly gridColumns?: readonly LayoutGridTrack[]; readonly gridRows?: readonly LayoutGridTrack[]; readonly gridPlacement?: LayoutGridPlacement; readonly reflow?: { readonly duration: number; readonly easing: readonly [number, number, number, number] };
}
export interface LayoutScrollDefinition { readonly axis: 'x' | 'y' | 'both'; readonly mode?: 'clamped' | 'elastic' | 'infinite'; readonly snap?: number; readonly friction?: number; readonly elasticity?: number; readonly scrollbar?: { readonly node: string; readonly autoSize?: boolean }; }
export interface LayoutListDefinition { readonly dataPort: string; readonly templateArtboard: string; readonly direction: 'row' | 'column'; readonly itemExtent: number; readonly gap?: number; readonly virtualize?: boolean; readonly buffer?: number; readonly carousel?: boolean; }
export interface LayoutNSliceDefinition { readonly source: { readonly kind: 'asset'; readonly asset: string } | { readonly kind: 'node'; readonly node: string }; readonly sourceSize: readonly [number, number]; readonly xCuts: readonly number[]; readonly yCuts: readonly number[]; readonly tileModes?: readonly ('stretch' | 'repeat' | 'mirror')[]; }
export interface LayoutComponentDefinition { readonly artboard: string; readonly fit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'; readonly alignment?: readonly [number, number]; readonly sizing?: 'node' | 'leaf' | 'layout'; readonly playback?: { readonly mode: 'simple' | 'remap' | 'mix'; readonly speed?: number; readonly paused?: boolean; readonly quantize?: number; readonly stateful?: boolean; readonly remapPort?: string; readonly mixPort?: string }; readonly exposedInputs?: readonly string[]; readonly exposedEvents?: readonly string[]; }
export interface LayoutNodeDefinition { readonly id: string; readonly parent?: string; readonly kind: 'container' | 'leaf' | 'text' | 'image' | 'component' | 'list' | 'n-slice'; readonly style: LayoutStyle; readonly visual?: LayoutVisualStyle; readonly intrinsicSize?: readonly [number, number]; readonly text?: string; readonly asset?: string; readonly component?: LayoutComponentDefinition; readonly list?: LayoutListDefinition; readonly nSlice?: LayoutNSliceDefinition; readonly scroll?: LayoutScrollDefinition; }
export interface LayoutArtboardDefinition { readonly id: string; readonly name?: string; readonly width: number; readonly height: number; readonly root: string; readonly nodes: readonly LayoutNodeDefinition[]; }
export interface LayoutRootInstance { readonly id: string; readonly artboard: string; readonly fit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'; readonly alignment?: readonly [number, number]; readonly transform?: readonly [number, number, number, number, number, number]; }
export interface ResponsiveLayoutDocument { readonly format: typeof LAYOUT_FORMAT; readonly version: typeof LAYOUT_VERSION; readonly extension: typeof LAYOUT_EXTENSION_ID; readonly shaping: TextShapingContract; readonly assets: readonly LayoutAsset[]; readonly textStyles: readonly TextStyleDefinition[]; readonly textBlocks: readonly TextBlockDefinition[]; readonly artboards: readonly LayoutArtboardDefinition[]; readonly instances: readonly LayoutRootInstance[]; }
export interface LayoutParseOptions { readonly limits?: Partial<LayoutLimits>; }
