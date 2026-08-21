import type { AnimationDocument, AnimationImageResource } from '../types';
import {
  DEFORMABLE_MESH_2D_EXTENSION_ID,
  encodeDeformableMesh2DData,
  type DeformableMesh2DComponent,
  type DeformableMesh2DDataSource,
  type DeformableMesh2DDrawableSource,
} from '../deformable2d/index';

export const CUBISM_DRAWABLE_CAPTURE_FORMAT = 'live2d-cubism-drawable-capture' as const;
export const CUBISM_DRAWABLE_CAPTURE_VERSION = 1 as const;

const CUBISM_UNIT_INTERVAL_EPSILON = 1e-6;

export interface CubismCaptureTexture {
  readonly id: string;
  readonly uri: string;
  readonly width?: number;
  readonly height?: number;
  readonly integrity?: string;
}

export interface CubismCapturedDrawable {
  readonly id: string;
  readonly textureIndex: number;
  readonly renderOrder: number;
  readonly opacity: number;
  readonly blendMode?: 'normal' | 'additive' | 'multiplicative';
  readonly culling?: boolean;
  readonly masks?: readonly string[];
  readonly positions: readonly number[];
  readonly uvs: readonly number[];
  readonly indices: readonly number[];
  readonly multiplyColor?: readonly [number, number, number, number];
  readonly screenColor?: readonly [number, number, number, number];
}

export interface CubismCaptureFrame {
  readonly time: number;
  readonly drawables: readonly CubismCapturedDrawable[];
}

export interface CubismDrawableCapture {
  readonly format: typeof CUBISM_DRAWABLE_CAPTURE_FORMAT;
  readonly version: typeof CUBISM_DRAWABLE_CAPTURE_VERSION;
  readonly name?: string;
  readonly source?: Readonly<Record<string, unknown>>;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly pixelsPerUnit: number;
    readonly coordinateSystem: 'model-y-up';
    /** Legacy captures omit this and are interpreted as top-left image UVs. */
    readonly uvOrigin?: 'top-left' | 'bottom-left';
  };
  readonly duration: number;
  readonly frameRate: number;
  readonly textures: readonly CubismCaptureTexture[];
  readonly frames: readonly CubismCaptureFrame[];
}

export interface CubismCaptureDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code:
    | 'E_CUBISM_CAPTURE_INVALID'
    | 'E_CUBISM_TOPOLOGY_CHANGED'
    | 'W_CUBISM_COLOR_APPROXIMATED'
    | 'W_CUBISM_CULLING_IGNORED';
  readonly message: string;
  readonly path: string;
}

export interface CubismCaptureConversionOptions {
  readonly dataUri?: string;
  readonly strict?: boolean;
}

export interface CubismCaptureConversionResult {
  readonly document: AnimationDocument;
  readonly data: ArrayBuffer;
  readonly diagnostics: readonly CubismCaptureDiagnostic[];
  readonly report: Readonly<{
    sourceFormat: typeof CUBISM_DRAWABLE_CAPTURE_FORMAT;
    profile: 'clip-baked';
    frameCount: number;
    drawableCount: number;
    vertexCount: number;
    textureCount: number;
    unsupportedRuntimeFeatures: readonly string[];
  }>;
}

export class CubismCaptureConversionError extends Error {
  readonly diagnostics: readonly CubismCaptureDiagnostic[];

  constructor(message: string, diagnostics: readonly CubismCaptureDiagnostic[]) {
    super(message);
    this.name = 'CubismCaptureConversionError';
    this.diagnostics = diagnostics;
  }
}

export function convertCubismCaptureToHya(
  capture: CubismDrawableCapture,
  options: CubismCaptureConversionOptions = {},
): CubismCaptureConversionResult {
  const diagnostics: CubismCaptureDiagnostic[] = [];
  validateCaptureRoot(capture, diagnostics);
  if (diagnostics.some(item => item.severity === 'error')) throw new CubismCaptureConversionError('Cubism drawable capture is invalid.', diagnostics);
  const first = capture.frames[0]!;
  const ordered = [...first.drawables].sort((a, b) => a.renderOrder - b.renderOrder || a.id.localeCompare(b.id));
  const times = new Float32Array(capture.frames.map(frame => frame.time));
  const drawables: DeformableMesh2DDrawableSource[] = [];
  let vertexCount = 0;
  for (const base of ordered) {
    const positions = new Float32Array(capture.frames.length * base.positions.length);
    const opacities = new Float32Array(capture.frames.length);
    const renderOrders = new Float32Array(capture.frames.length);
    for (let frameIndex = 0; frameIndex < capture.frames.length; frameIndex++) {
      const frameDrawable = capture.frames[frameIndex]!.drawables.find(item => item.id === base.id);
      const path = `$.frames[${frameIndex}].drawables[id=${JSON.stringify(base.id)}]`;
      if (!frameDrawable || !sameTopology(base, frameDrawable)) {
        diagnostics.push({ severity: 'error', code: 'E_CUBISM_TOPOLOGY_CHANGED', message: `Drawable "${base.id}" changed or disappeared across capture frames.`, path });
        continue;
      }
      const targetOffset = frameIndex * base.positions.length;
      for (let valueIndex = 0; valueIndex < frameDrawable.positions.length; valueIndex += 2) {
        positions[targetOffset + valueIndex] = capture.canvas.width / 2 + frameDrawable.positions[valueIndex]! * capture.canvas.pixelsPerUnit;
        positions[targetOffset + valueIndex + 1] = capture.canvas.height / 2 - frameDrawable.positions[valueIndex + 1]! * capture.canvas.pixelsPerUnit;
      }
      opacities[frameIndex] = clampUnitInterval(frameDrawable.opacity);
      renderOrders[frameIndex] = frameDrawable.renderOrder;
    }
    const basePath = `$.frames[0].drawables[id=${JSON.stringify(base.id)}]`;
    const blendMode = base.blendMode ?? 'normal';
    const samples = capture.frames.map(frame => frame.drawables.find(item => item.id === base.id)!).filter(Boolean);
    if (samples.some(item => item.culling === true)) diagnostics.push({ severity: 'warning', code: 'W_CUBISM_CULLING_IGNORED', message: 'Drawable culling is disabled by the v1 2D renderer.', path: `${basePath}.culling` });
    if (samples.some(item => !isNeutralMultiply(item.multiplyColor) || !isNeutralScreen(item.screenColor))) diagnostics.push({ severity: 'warning', code: 'W_CUBISM_COLOR_APPROXIMATED', message: 'Non-neutral multiply/screen color is not represented by v1.', path: basePath });
    vertexCount += base.positions.length / 2;
    drawables.push({
      id: base.id,
      textureIndex: base.textureIndex,
      blendMode,
      culling: base.culling ?? false,
      masks: Object.freeze([...(base.masks ?? [])]),
      uvs: normalizeCubismUvs(base.uvs, capture.canvas.uvOrigin ?? 'top-left'),
      indices: new Uint32Array(base.indices),
      positions,
      opacities,
      renderOrders,
    });
  }
  if (diagnostics.some(item => item.severity === 'error') || (options.strict && diagnostics.length > 0)) {
    throw new CubismCaptureConversionError(options.strict ? 'Strict Cubism conversion rejected fidelity diagnostics.' : 'Cubism conversion failed.', diagnostics);
  }
  const dataSource: DeformableMesh2DDataSource = {
    canvasWidth: capture.canvas.width,
    canvasHeight: capture.canvas.height,
    duration: capture.duration,
    frameRate: capture.frameRate,
    times,
    drawables,
  };
  const data = encodeDeformableMesh2DData(dataSource);
  const textureResources = capture.textures.map((texture, index): AnimationImageResource => ({
    id: texture.id || `texture-${index}`,
    type: 'image',
    uri: texture.uri,
    ...(texture.width === undefined ? {} : { width: texture.width }),
    ...(texture.height === undefined ? {} : { height: texture.height }),
    ...(texture.integrity === undefined ? {} : { integrity: texture.integrity }),
    colorSpace: 'srgb',
  }));
  const dataResourceId = 'deformable-mesh-data';
  const component: DeformableMesh2DComponent = {
    type: DEFORMABLE_MESH_2D_EXTENSION_ID,
    dataResource: dataResourceId,
    textures: textureResources.map(resource => resource.id),
  };
  const document: AnimationDocument = {
    format: 'haiyue-animation',
    version: '1.0',
    name: capture.name ?? 'Cubism clip-baked animation',
    canvas: { width: capture.canvas.width, height: capture.canvas.height, coordinateSystem: 'screen-y-down' },
    duration: capture.duration,
    frameRate: capture.frameRate,
    endBehavior: 'loop',
    resources: [
      { id: dataResourceId, type: 'binary', uri: options.dataUri ?? 'model.hydm', mimeType: 'application/vnd.haiyue.deformable-mesh-2d' },
      ...textureResources,
    ],
    nodes: [{ id: 'deformable-model', name: capture.name ?? 'Deformable model', components: [component] }],
    extensionsUsed: [DEFORMABLE_MESH_2D_EXTENSION_ID],
    extensionsRequired: [DEFORMABLE_MESH_2D_EXTENSION_ID],
  };
  return Object.freeze({
    document,
    data,
    diagnostics: Object.freeze(diagnostics),
    report: Object.freeze({
      sourceFormat: CUBISM_DRAWABLE_CAPTURE_FORMAT,
      profile: 'clip-baked',
      frameCount: capture.frames.length,
      drawableCount: drawables.length,
      vertexCount,
      textureCount: capture.textures.length,
      unsupportedRuntimeFeatures: Object.freeze(['parameterized-input', 'physics-runtime', 'motion-sync', 'multiply-screen-color', 'culling']),
    }),
  });
}

function validateCaptureRoot(capture: CubismDrawableCapture, diagnostics: CubismCaptureDiagnostic[]): void {
  const fail = (message: string, path: string): void => {
    diagnostics.push({ severity: 'error', code: 'E_CUBISM_CAPTURE_INVALID', message, path });
  };
  if (!capture || typeof capture !== 'object') { fail('Capture must be an object.', '$'); return; }
  if (capture.format !== CUBISM_DRAWABLE_CAPTURE_FORMAT || capture.version !== CUBISM_DRAWABLE_CAPTURE_VERSION) fail('Capture format/version is unsupported.', '$.format');
  if (!capture.canvas || capture.canvas.coordinateSystem !== 'model-y-up') fail('Capture coordinate system must be model-y-up.', '$.canvas.coordinateSystem');
  if (capture.canvas?.uvOrigin !== undefined && capture.canvas.uvOrigin !== 'top-left' && capture.canvas.uvOrigin !== 'bottom-left') fail('UV origin must be top-left or bottom-left.', '$.canvas.uvOrigin');
  for (const [key, value] of [['width', capture.canvas?.width], ['height', capture.canvas?.height], ['pixelsPerUnit', capture.canvas?.pixelsPerUnit]] as const) if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${key} must be positive and finite.`, `$.canvas.${key}`);
  if (!Number.isFinite(capture.duration) || capture.duration <= 0) fail('Duration must be positive and finite.', '$.duration');
  if (!Number.isFinite(capture.frameRate) || capture.frameRate <= 0) fail('Frame rate must be positive and finite.', '$.frameRate');
  if (!Array.isArray(capture.textures) || capture.textures.length === 0) fail('At least one texture is required.', '$.textures');
  if (!Array.isArray(capture.frames) || capture.frames.length === 0) { fail('At least one frame is required.', '$.frames'); return; }
  let previous = -1;
  for (let frameIndex = 0; frameIndex < capture.frames.length; frameIndex++) {
    const frame = capture.frames[frameIndex]!;
    if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time <= previous || frame.time > capture.duration + 1e-6) fail('Frame times must be finite, increasing and inside duration.', `$.frames[${frameIndex}].time`);
    previous = frame.time;
    if (!Array.isArray(frame.drawables) || frame.drawables.length === 0) fail('Frame requires drawables.', `$.frames[${frameIndex}].drawables`);
    const ids = new Set<string>();
    for (let drawableIndex = 0; drawableIndex < frame.drawables.length; drawableIndex++) {
      const drawable = frame.drawables[drawableIndex]!;
      const path = `$.frames[${frameIndex}].drawables[${drawableIndex}]`;
      if (!drawable.id || ids.has(drawable.id)) fail('Drawable id must be non-empty and unique per frame.', `${path}.id`);
      ids.add(drawable.id);
      if (!Number.isSafeInteger(drawable.textureIndex) || drawable.textureIndex < 0 || drawable.textureIndex >= capture.textures.length) fail('Texture index is out of range.', `${path}.textureIndex`);
      if (!Number.isSafeInteger(drawable.renderOrder)) fail('Render order must be a safe integer.', `${path}.renderOrder`);
      if (!Number.isFinite(drawable.opacity) || drawable.opacity < -CUBISM_UNIT_INTERVAL_EPSILON || drawable.opacity > 1 + CUBISM_UNIT_INTERVAL_EPSILON) fail('Opacity must be finite and inside [0, 1], allowing only float32 capture drift.', `${path}.opacity`);
      if (!Array.isArray(drawable.positions) || drawable.positions.length < 6 || drawable.positions.length % 2 !== 0 || !drawable.positions.every(Number.isFinite)) fail('Positions require finite xy triples.', `${path}.positions`);
      if (!Array.isArray(drawable.uvs) || drawable.uvs.length !== drawable.positions.length || !drawable.uvs.every(Number.isFinite)) fail('UVs must match positions.', `${path}.uvs`);
      if (!Array.isArray(drawable.indices) || drawable.indices.length < 3 || drawable.indices.length % 3 !== 0 || !drawable.indices.every((value: number) => Number.isSafeInteger(value) && value >= 0 && value < drawable.positions.length / 2)) fail('Indices must contain in-range triangle triplets.', `${path}.indices`);
    }
  }
  const baseIds = new Set(capture.frames[0]!.drawables.map((item: CubismCapturedDrawable) => item.id));
  for (let frameIndex = 1; frameIndex < capture.frames.length; frameIndex++) {
    if (capture.frames[frameIndex]!.drawables.length !== baseIds.size || capture.frames[frameIndex]!.drawables.some((item: CubismCapturedDrawable) => !baseIds.has(item.id))) fail('Drawable population must stay stable across frames.', `$.frames[${frameIndex}].drawables`);
  }
  for (let drawableIndex = 0; drawableIndex < capture.frames[0]!.drawables.length; drawableIndex++) {
    for (let maskIndex = 0; maskIndex < (capture.frames[0]!.drawables[drawableIndex]!.masks?.length ?? 0); maskIndex++) {
      const mask = capture.frames[0]!.drawables[drawableIndex]!.masks![maskIndex]!;
      if (mask === capture.frames[0]!.drawables[drawableIndex]!.id || !baseIds.has(mask)) fail('Mask must reference another captured drawable.', `$.frames[0].drawables[${drawableIndex}].masks[${maskIndex}]`);
    }
  }
}

function sameTopology(a: CubismCapturedDrawable, b: CubismCapturedDrawable): boolean {
  const aMasks = a.masks ?? [];
  const bMasks = b.masks ?? [];
  return a.textureIndex === b.textureIndex
    && a.positions.length === b.positions.length
    && a.uvs.length === b.uvs.length
    && a.indices.length === b.indices.length
    && a.indices.every((value, index) => value === b.indices[index])
    && a.uvs.every((value, index) => value === b.uvs[index])
    && aMasks.length === bMasks.length
    && aMasks.every((value, index) => value === bMasks[index]);
}

function isNeutralMultiply(value: readonly number[] | undefined): boolean { return value === undefined || (value.length === 4 && value.every(component => component === 1)); }
function isNeutralScreen(value: readonly number[] | undefined): boolean { return value === undefined || (value.length === 4 && value.every(component => component === 0)); }
function clampUnitInterval(value: number): number { return Math.max(0, Math.min(1, value)); }
function normalizeCubismUvs(source: readonly number[], origin: 'top-left' | 'bottom-left'): Float32Array {
  const normalized = new Float32Array(source);
  if (origin === 'top-left') return normalized;
  for (let index = 0; index < source.length; index += 2) {
    normalized[index + 1] = 1 - source[index + 1]!;
  }
  return normalized;
}
