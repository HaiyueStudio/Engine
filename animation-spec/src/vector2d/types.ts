export type VectorFillRule = 'nonzero' | 'evenodd';
export type VectorLineCap = 'butt' | 'round' | 'square';
export type VectorLineJoin = 'miter' | 'round' | 'bevel';
export type VectorBlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference'
  | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'
  | 'add' | 'subtract';
export type VectorColorSpace = 'srgb' | 'display-p3' | 'linear-srgb';
export type VectorFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
export type VectorFilter = 'nearest' | 'linear';
export type VectorWrap = 'clamp' | 'repeat' | 'mirror-repeat';
export type VectorTopologyPolicy = 'stable' | 'discrete';

export interface VectorVisualLimits {
  readonly maxNodes: number;
  readonly maxPathsPerNode: number;
  readonly maxCommands: number;
  readonly maxValues: number;
  readonly maxKeyframes: number;
  readonly maxGradientStops: number;
  readonly maxPaintsPerNode: number;
  readonly maxEffectsPerGroup: number;
  readonly maxEffectGroupsPerNode: number;
  readonly maxClipNodes: number;
  readonly maxClipDepth: number;
  readonly maxVertices: number;
  readonly maxIndices: number;
  readonly maxDashEntries: number;
  readonly maxFeather: number;
  readonly maxOffscreenPixels: number;
  readonly maxImagePixels: number;
}

export interface VectorTrack<T> {
  readonly times: readonly number[];
  readonly values: readonly T[];
  readonly interpolation?: 'step' | 'linear';
}

export interface VectorPathFrame {
  readonly time: number;
  readonly commands: string;
  readonly values: readonly number[];
}

export interface VectorCommandPath {
  readonly kind: 'path';
  readonly commands: string;
  readonly values: readonly number[];
  readonly fillRule?: VectorFillRule;
  readonly isHole?: boolean;
  readonly topologyPolicy?: VectorTopologyPolicy;
  readonly frames?: readonly VectorPathFrame[];
}

export interface VectorEllipse { readonly kind: 'ellipse'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number; }
export interface VectorRectangle {
  readonly kind: 'rectangle'; readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly radii?: readonly [number, number, number, number];
}
export interface VectorPolygon { readonly kind: 'polygon'; readonly cx: number; readonly cy: number; readonly radius: number; readonly points: number; readonly rotation?: number; readonly cornerRadius?: number; }
export interface VectorStar { readonly kind: 'star'; readonly cx: number; readonly cy: number; readonly outerRadius: number; readonly innerRadius: number; readonly points: number; readonly rotation?: number; readonly cornerRadius?: number; }
export interface VectorTriangle { readonly kind: 'triangle'; readonly points: readonly [number, number, number, number, number, number]; readonly cornerRadius?: number; }

export interface VectorImageMesh {
  readonly positions: readonly number[];
  readonly uvs: readonly number[];
  readonly indices: readonly number[];
}

export interface VectorImageGeometry {
  readonly kind: 'image';
  readonly resource: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly crop?: readonly [number, number, number, number];
  readonly fit?: VectorFit;
  readonly alignment?: readonly [number, number];
  readonly mesh?: VectorImageMesh;
}

export interface VectorNSliceGeometry {
  readonly kind: 'n-slice';
  readonly source: { readonly kind: 'image'; readonly resource: string } | { readonly kind: 'node'; readonly node: string };
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sourceSize: readonly [number, number];
  readonly xCuts: readonly number[];
  readonly yCuts: readonly number[];
}

export type VectorGeometry = VectorCommandPath | VectorEllipse | VectorRectangle | VectorPolygon | VectorStar | VectorTriangle | VectorImageGeometry | VectorNSliceGeometry;

export interface VectorGradientStop { readonly offset: number; readonly color: readonly [number, number, number, number]; }
export interface VectorSolidPaint { readonly kind: 'solid'; readonly color: readonly [number, number, number, number]; }
export interface VectorLinearGradientPaint { readonly kind: 'linear-gradient'; readonly start: readonly [number, number]; readonly end: readonly [number, number]; readonly stops: readonly VectorGradientStop[]; readonly colorSpace?: VectorColorSpace; }
export interface VectorRadialGradientPaint { readonly kind: 'radial-gradient'; readonly center: readonly [number, number]; readonly radius: number; readonly focal?: readonly [number, number]; readonly stops: readonly VectorGradientStop[]; readonly colorSpace?: VectorColorSpace; }
export type VectorPaintSource = VectorSolidPaint | VectorLinearGradientPaint | VectorRadialGradientPaint;

export interface VectorTrim {
  readonly start: number;
  readonly end: number;
  readonly offset?: number;
  readonly mode?: 'simultaneous' | 'individual';
}

export interface VectorFillPaint {
  readonly kind: 'fill';
  readonly source: VectorPaintSource;
  readonly fillRule?: VectorFillRule;
  readonly opacity?: number;
  readonly blendMode?: VectorBlendMode;
  readonly visible?: boolean;
}

export interface VectorStrokePaint {
  readonly kind: 'stroke';
  readonly source: VectorPaintSource;
  readonly width: number;
  readonly cap?: VectorLineCap;
  readonly join?: VectorLineJoin;
  readonly miterLimit?: number;
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
  readonly dashUnits?: 'absolute' | 'path-percent';
  readonly trim?: VectorTrim;
  readonly transformMode?: 'scale' | 'fixed';
  readonly opacity?: number;
  readonly blendMode?: VectorBlendMode;
  readonly visible?: boolean;
}

export type VectorPaint = VectorFillPaint | VectorStrokePaint;

export interface VectorFeatherEffect { readonly kind: 'feather'; readonly radiusX: number; readonly radiusY: number; readonly offsetX?: number; readonly offsetY?: number; readonly inner?: boolean; readonly space?: 'local' | 'world'; }
export interface VectorOpacityEffect { readonly kind: 'opacity'; readonly value: number; }
export interface VectorColorMatrixEffect { readonly kind: 'color-matrix'; readonly values: readonly number[]; }
export interface VectorBlurEffect { readonly kind: 'blur'; readonly radiusX: number; readonly radiusY: number; }
export interface VectorDropShadowEffect { readonly kind: 'drop-shadow'; readonly offsetX: number; readonly offsetY: number; readonly blur: number; readonly color: readonly [number, number, number, number]; }
export interface VectorScriptPathPort {
  readonly kind: 'custom-path-port';
  readonly port: string;
  readonly inputs: Readonly<Record<string, number | boolean | string>>;
  readonly execution: 'external-only';
}
export type VectorEffect = VectorFeatherEffect | VectorOpacityEffect | VectorColorMatrixEffect | VectorBlurEffect | VectorDropShadowEffect | VectorScriptPathPort;

export interface VectorEffectGroup {
  readonly id: string;
  readonly target?: string;
  readonly blendMode?: VectorBlendMode;
  readonly effects: readonly VectorEffect[];
}

export interface VectorClipNode {
  readonly id: string;
  readonly source: string;
  readonly operation?: 'add' | 'subtract' | 'intersect' | 'difference';
  readonly inverted?: boolean;
  readonly fillRule?: VectorFillRule;
  readonly children?: readonly string[];
}

export interface VectorImageResource {
  readonly id: string;
  readonly kind: 'image';
  readonly width: number;
  readonly height: number;
  readonly source:
    | { readonly kind: 'embedded'; readonly resource: string }
    | { readonly kind: 'referenced'; readonly resource: string }
    | { readonly kind: 'hosted-replacement'; readonly slot: string; readonly fallback?: string };
  readonly colorSpace?: VectorColorSpace;
  readonly filter?: VectorFilter;
  readonly wrapX?: VectorWrap;
  readonly wrapY?: VectorWrap;
}

export interface VectorVisualNode {
  readonly id: string;
  readonly name?: string;
  readonly visible?: boolean;
  readonly solo?: boolean;
  readonly drawOrder: number;
  readonly opacity?: number;
  readonly transform?: readonly [number, number, number, number, number, number];
  readonly geometries: readonly VectorGeometry[];
  readonly paints: readonly VectorPaint[];
  readonly effectGroups?: readonly VectorEffectGroup[];
  readonly clips?: readonly string[];
}

export interface VectorVisualDocument {
  readonly format: 'haiyue-vector-visual';
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly duration?: number;
  readonly resources?: readonly VectorImageResource[];
  readonly nodes: readonly VectorVisualNode[];
  readonly clips?: readonly VectorClipNode[];
}

export interface ParsedVectorVisualDocument extends VectorVisualDocument {
  readonly resources: readonly VectorImageResource[];
  readonly clips: readonly VectorClipNode[];
}
