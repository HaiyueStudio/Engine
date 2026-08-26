export const ANIMATION_FORMAT = 'haiyue-animation' as const;
export const ANIMATION_VERSION = '1.0' as const;
export const ANIMATION_MIME_TYPE = 'application/vnd.haiyue.animation' as const;
export const ANIMATION_FILE_EXTENSION = '.hya' as const;

export type AnimationCoordinateSystem = 'screen-y-down';
export type AnimationEndBehavior = 'hold' | 'loop' | 'destroy';
export type AnimationInterpolation = 'step' | 'linear' | 'cubic-bezier';
export type AnimationTrackProperty = 'position' | 'rotation' | 'scale' | 'opacity';

export interface AnimationCanvas {
  width: number;
  height: number;
  coordinateSystem: AnimationCoordinateSystem;
}

export interface AnimationTransform2D {
  position?: readonly [number, number];
  rotation?: number;
  scale?: readonly [number, number];
  anchor?: readonly [number, number];
  opacity?: number;
}

export interface AnimationShape2DComponent {
  type: 'shape2d';
  shape: 'rect' | 'ellipse';
  size: readonly [number, number];
  position?: readonly [number, number];
  fill: readonly [number, number, number, number];
}

export type AnimationPathCommand = 'M' | 'L' | 'Q' | 'C' | 'Z';
export type AnimationFillRule = 'nonzero' | 'evenodd';

export interface AnimationPath2DComponent {
  type: 'path2d';
  /** Packed command stream. M/L consume 2, Q consumes 4, C consumes 6, Z consumes 0 floats. */
  commands: string;
  values: readonly number[] | Float32Array;
  fill: readonly [number, number, number, number];
  fillRule?: AnimationFillRule;
  /** Maximum flattening error in animation canvas units. */
  tolerance?: number;
}

export interface AnimationSprite2DComponent {
  type: 'sprite2d';
  resource: string;
  size: readonly [number, number];
  position?: readonly [number, number];
  tint?: readonly [number, number, number, number];
  /** Normalized source rectangle [x, y, width, height]. */
  uvRect?: readonly [number, number, number, number];
  /** STEP-keyed normalized source rectangles for atlas/spritesheet animation. */
  uvRectTrack?: AnimationVectorValueTrack;
}

export interface AnimationText2DComponent {
  type: 'text2d';
  text: string;
  size: readonly [number, number];
  position?: readonly [number, number];
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: 'normal' | 'italic';
  /** Optional binary font resource loaded through FontFace before rasterization. */
  fontResource?: string;
  lineHeight?: number;
  /** Additional advance in animation canvas units between shaped graphemes. */
  tracking?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  color: readonly [number, number, number, number];
  backgroundColor?: readonly [number, number, number, number];
  padding?: number;
  resolutionScale?: number;
  /** Step-keyed source-neutral text documents. The first entry may start after zero. */
  documents?: readonly AnimationTextDocumentKeyframe[];
  /** Ordered per-character animators evaluated after deterministic grapheme shaping. */
  animators?: readonly AnimationTextAnimator[];
  /** Verified source-neutral program evaluated as a pure Text Document input. */
  expression?: import('./expression').AnimationSafeExpressionProgram;
}

export interface AnimationTextDocumentKeyframe {
  readonly time: number;
  readonly text: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string | number;
  readonly fontStyle?: 'normal' | 'italic';
  readonly fontResource?: string;
  readonly lineHeight?: number;
  readonly tracking?: number;
  readonly textAlign?: 'left' | 'center' | 'right';
  readonly color?: readonly [number, number, number, number];
}

export type AnimationTextSelectorUnits = 'percent' | 'index';
export type AnimationTextSelectorShape = 'square' | 'ramp-up' | 'ramp-down' | 'triangle' | 'round' | 'smooth';
export type AnimationTextSelectorBasedOn = 'characters' | 'characters-excluding-spaces' | 'words' | 'lines';

export interface AnimationTextRangeSelector {
  readonly start: number;
  readonly end: number;
  readonly offset?: number;
  readonly units?: AnimationTextSelectorUnits;
  /** Signed selector influence in the normalized [-1, 1] domain. */
  readonly amount?: number;
  readonly shape?: AnimationTextSelectorShape;
  /** Glyph grouping used before applying the selector range. */
  readonly basedOn?: AnimationTextSelectorBasedOn;
  /** Cubic Bézier easing applied to the selector shape weight. */
  readonly easing?: readonly [number, number, number, number];
  /** Selector edge smoothing in the normalized [0, 1] domain. */
  readonly smoothness?: number;
  /** Stable uint32 seed for deterministic permutation of selector groups. */
  readonly randomSeed?: number;
  readonly startTrack?: AnimationVectorValueTrack;
  readonly endTrack?: AnimationVectorValueTrack;
  readonly offsetTrack?: AnimationVectorValueTrack;
  readonly amountTrack?: AnimationVectorValueTrack;
}

export interface AnimationTextAnimator {
  readonly selector: AnimationTextRangeSelector;
  readonly position?: readonly [number, number];
  readonly scale?: readonly [number, number];
  readonly rotation?: number;
  readonly opacity?: number;
  readonly fillColor?: readonly [number, number, number, number];
  readonly tracking?: number;
  readonly positionTrack?: AnimationVectorValueTrack;
  readonly scaleTrack?: AnimationVectorValueTrack;
  readonly rotationTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
  readonly fillColorTrack?: AnimationVectorValueTrack;
  readonly trackingTrack?: AnimationVectorValueTrack;
}

export interface AnimationParticle2DComponent {
  type: 'particle2d';
  maxParticles: number;
  emissionRate: number;
  burst?: number;
  duration?: number;
  loop?: boolean;
  seed?: number;
  lifetime: readonly [number, number];
  speed: readonly [number, number];
  angle: readonly [number, number];
  gravity?: readonly [number, number];
  startSize: readonly [number, number];
  endSize: readonly [number, number];
  startColor: readonly [number, number, number, number];
  endColor: readonly [number, number, number, number];
  shape?: 'point' | 'box' | 'circle';
  shapeSize?: readonly [number, number];
  shapeRadius?: number;
  blendMode?: 'normal' | 'additive';
  resource?: string;
  radial?: boolean;
}

export interface AnimationAudioComponent {
  type: 'audio';
  resource: string;
  volume?: number;
  loop?: boolean;
  startOffset?: number;
  playbackRate?: number;
}

export interface AnimationExtensionComponent {
  /** A namespaced component id such as `org.example.particle@1`. */
  type: string;
  [key: string]: unknown;
}

export const ANIMATION_VECTOR_SHAPE_EXTENSION_ID = 'org.haiyue.vector-shape@1' as const;

export interface AnimationVectorValueTrack {
  readonly times: readonly number[] | Float32Array;
  readonly values: readonly number[] | Float32Array;
  readonly valueSize: number;
  readonly interpolation: AnimationInterpolation;
  readonly easings?: readonly number[] | Float32Array;
}

export interface AnimationVectorSolidPaint {
  readonly kind: 'solid';
  readonly color: readonly [number, number, number, number];
  readonly opacity?: number;
  readonly colorTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
}

export interface AnimationVectorGradientPaint {
  readonly kind: 'linear-gradient' | 'radial-gradient';
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
  /** Repeating offset,r,g,b,a tuples. Runtime support is intentionally bounded to eight stops. */
  readonly stops: readonly number[] | Float32Array;
  readonly opacity?: number;
  readonly startTrack?: AnimationVectorValueTrack;
  readonly endTrack?: AnimationVectorValueTrack;
  readonly stopsTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
}

export interface AnimationVectorStrokePaint {
  readonly color: readonly [number, number, number, number];
  readonly gradient?: AnimationVectorGradientPaint;
  readonly width: number;
  readonly opacity?: number;
  readonly lineCap: 'butt' | 'round' | 'square';
  readonly lineJoin: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  readonly dash?: readonly number[] | Float32Array;
  readonly dashOffset?: number;
  readonly colorTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
  readonly widthTrack?: AnimationVectorValueTrack;
  readonly dashOffsetTrack?: AnimationVectorValueTrack;
}

export interface AnimationVectorTrimPathModifier {
  readonly kind: 'trim-path';
  /** Normalized path fractions. Values outside [0, 1] are wrapped by the runtime. */
  readonly start: number;
  readonly end: number;
  /** Rotation in turns, matching start/end's normalized domain. */
  readonly offset: number;
  readonly mode: 'simultaneous' | 'individual';
  readonly startTrack?: AnimationVectorValueTrack;
  readonly endTrack?: AnimationVectorValueTrack;
  readonly offsetTrack?: AnimationVectorValueTrack;
}

export interface AnimationVectorRoundCornersModifier {
  readonly kind: 'round-corners';
  readonly radius: number;
  readonly radiusTrack?: AnimationVectorValueTrack;
}

export type AnimationVectorPathModifier =
  | AnimationVectorTrimPathModifier
  | AnimationVectorRoundCornersModifier;

export interface AnimationVectorShapeComponent {
  readonly type: typeof ANIMATION_VECTOR_SHAPE_EXTENSION_ID;
  readonly commands: string;
  readonly values: readonly number[] | Float32Array;
  readonly morph?: AnimationVectorValueTrack;
  /** When true, morph samples are added component-wise to `values`. */
  readonly morphRelative?: boolean;
  readonly fill?: AnimationVectorSolidPaint | AnimationVectorGradientPaint;
  readonly stroke?: AnimationVectorStrokePaint;
  /** Ordered, source-neutral path modifiers. Runtime execution follows array order. */
  readonly modifiers?: readonly AnimationVectorPathModifier[];
  readonly fillRule?: AnimationFillRule;
  readonly tolerance?: number;
}

export interface AnimationTintEffect {
  readonly kind: 'tint';
  readonly black: readonly [number, number, number];
  readonly white: readonly [number, number, number];
  readonly amount: number;
  readonly blackTrack?: AnimationVectorValueTrack;
  readonly whiteTrack?: AnimationVectorValueTrack;
  readonly amountTrack?: AnimationVectorValueTrack;
}

export interface AnimationFillEffect {
  readonly kind: 'fill';
  readonly color: readonly [number, number, number, number];
  readonly opacity?: number;
  readonly colorTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
}

export interface AnimationOpacityEffect {
  readonly kind: 'opacity';
  readonly opacity: number;
  readonly opacityTrack?: AnimationVectorValueTrack;
}

export interface AnimationColorMatrixEffect {
  readonly kind: 'color-matrix';
  /** Four rows of five values operating on unpremultiplied RGBA. */
  readonly matrix: readonly number[] | Float32Array;
  readonly matrixTrack?: AnimationVectorValueTrack;
}

export interface AnimationBlurEffect {
  readonly kind: 'blur';
  /** Horizontal and vertical radius in output pixels. */
  readonly radius: readonly [number, number];
  readonly radiusTrack?: AnimationVectorValueTrack;
}

export interface AnimationDropShadowEffect {
  readonly kind: 'drop-shadow';
  readonly color: readonly [number, number, number, number];
  readonly opacity: number;
  /** Shadow displacement in output pixels. */
  readonly offset: readonly [number, number];
  readonly blur: number;
  readonly colorTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
  readonly offsetTrack?: AnimationVectorValueTrack;
  readonly blurTrack?: AnimationVectorValueTrack;
}

export type AnimationLayerEffect =
  | AnimationTintEffect
  | AnimationFillEffect
  | AnimationOpacityEffect
  | AnimationColorMatrixEffect
  | AnimationBlurEffect
  | AnimationDropShadowEffect;

export type AnimationComponent =
  | AnimationShape2DComponent
  | AnimationPath2DComponent
  | AnimationSprite2DComponent
  | AnimationText2DComponent
  | AnimationParticle2DComponent
  | AnimationAudioComponent
  | AnimationVectorShapeComponent
  | AnimationExtensionComponent;

export type AnimationCompositeKind = 'mask' | 'matte';
export type AnimationCompositeMode = 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
export type AnimationCompositeOperation = 'add' | 'subtract' | 'intersect' | 'difference';

export interface AnimationCompositeLayer {
  kind: AnimationCompositeKind;
  source: string;
  mode: AnimationCompositeMode;
  /** Ordered mask/matte composition. The first layer is evaluated against transparent coverage. */
  operation?: AnimationCompositeOperation;
  /** Screen-space feather radii in animation canvas units. */
  feather?: readonly [number, number];
  /** Positive values expand coverage; negative values contract it. */
  expansion?: number;
  /** Optional time-varying expansion sampled in composition seconds. */
  expansionTrack?: AnimationVectorValueTrack;
}

export interface AnimationCompositeStack {
  readonly layers: readonly AnimationCompositeLayer[];
}

/** A single layer remains accepted as the compact authoring form. Parsers canonicalize neither form away. */
export type AnimationComposite = AnimationCompositeLayer | AnimationCompositeStack;

export interface AnimationNode {
  id: string;
  name?: string;
  parent?: string;
  start?: number;
  duration?: number;
  transform?: AnimationTransform2D;
  composite?: AnimationComposite;
  /** Ordered source-neutral visual effects applied to this node's visual subtree. */
  effects?: readonly AnimationLayerEffect[];
  components?: readonly AnimationComponent[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface AnimationTrack {
  node: string;
  property: AnimationTrackProperty;
  interpolation: AnimationInterpolation;
  /** Strictly increasing seconds relative to the composition start. */
  times: readonly number[] | Float32Array;
  /** Keyframe values, tightly packed by property component count. */
  values: readonly number[] | Float32Array;
  /** Per-segment cubic-bezier x1,y1,x2,y2 tuples. */
  easings?: readonly number[] | Float32Array;
  /**
   * Optional per-segment spatial cubic controls for 2D position tracks.
   * Each tuple is outgoingX,outgoingY,incomingX,incomingY relative to the
   * segment start/end values. Temporal easing still owns curve progress.
   */
  spatialTangents?: readonly number[] | Float32Array;
}

export interface AnimationImageResource {
  id: string;
  type: 'image';
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
  integrity?: string;
  /** Sampling color space; ordinary authored images default to sRGB. */
  colorSpace?: 'srgb' | 'linear';
}

export interface AnimationBinaryResource {
  id: string;
  type: 'binary';
  uri: string;
  mimeType?: string;
  integrity?: string;
}

export interface AnimationAudioResource {
  id: string;
  type: 'audio';
  uri: string;
  mimeType?: string;
  integrity?: string;
}

export type AnimationResource = AnimationImageResource | AnimationAudioResource | AnimationBinaryResource;

export interface AnimationDocument {
  format: typeof ANIMATION_FORMAT;
  version: typeof ANIMATION_VERSION;
  name?: string;
  canvas: AnimationCanvas;
  duration: number;
  frameRate?: number;
  endBehavior?: AnimationEndBehavior;
  resources?: readonly AnimationResource[];
  nodes: readonly AnimationNode[];
  tracks?: readonly AnimationTrack[];
  extensionsUsed?: readonly string[];
  extensionsRequired?: readonly string[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ParsedAnimationTrack extends Omit<AnimationTrack, 'times' | 'values' | 'easings' | 'spatialTangents'> {
  readonly times: Float32Array;
  readonly values: Float32Array;
  readonly easings?: Float32Array;
  readonly spatialTangents?: Float32Array;
  readonly valueSize: 1 | 2;
}

export interface ParsedAnimation {
  readonly format: typeof ANIMATION_FORMAT;
  readonly version: typeof ANIMATION_VERSION;
  readonly name?: string;
  readonly canvas: Readonly<AnimationCanvas>;
  readonly duration: number;
  readonly frameRate?: number;
  readonly endBehavior: AnimationEndBehavior;
  readonly resources: readonly Readonly<AnimationResource>[];
  readonly nodes: readonly Readonly<AnimationNode>[];
  readonly tracks: readonly ParsedAnimationTrack[];
  readonly extensionsUsed: readonly string[];
  readonly extensionsRequired: readonly string[];
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly source: 'json' | 'binary';
  /** Keeps zero-copy binary track views alive. */
  readonly backingBuffer?: ArrayBuffer;
}

export interface AnimationParseLimits {
  maxInputBytes?: number;
  maxMetadataBytes?: number;
  maxNodes?: number;
  maxComponents?: number;
  maxTracks?: number;
  maxKeyframes?: number;
  maxResources?: number;
  maxPathValues?: number;
  maxTextCharacters?: number;
  maxParticleCapacity?: number;
}

export interface AnimationParseOptions extends AnimationParseLimits {
  extensions?: import('./extensions').AnimationExtensionRegistry;
  /** Copies binary track/path Float32 views instead of retaining the source buffer. */
  copyFloatData?: boolean;
}

export type AnimationSource = AnimationDocument | string | ArrayBuffer;
