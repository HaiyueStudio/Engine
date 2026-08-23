import { encodeAnimationBinary } from '../binary.js';
import type { AnimationDocument } from '../types.js';
import { createDeformableMesh2DFormatRegistry } from '../deformable2d/index.js';
import {
  OfflineConversionError,
  runOfflineConversion,
  type OfflineConversionAdapter,
  type OfflineConversionDiagnostic,
  type OfflineConversionFrameOperations,
  type OfflineConversionHost,
  type OfflineConversionMode,
  type OfflineConversionPipelineResult,
  type OfflineConversionRecipe,
  type OfflineConversionResolvedAsset,
  type OfflineConversionSamplingOptions,
  type OfflineConversionSession,
} from '../conversion/OfflineConversionPipeline.js';
import {
  CUBISM_DRAWABLE_CAPTURE_FORMAT,
  CUBISM_DRAWABLE_CAPTURE_VERSION,
  convertCubismCaptureToHya,
  type CubismCaptureFrame,
  type CubismCaptureTexture,
  type CubismCapturedDrawable,
  type CubismDrawableCapture,
} from './CubismCaptureConverter.js';

export const CUBISM_CLIP_BAKED_UPDATE_ORDER = Object.freeze([
  'reset-defaults',
  'motion',
  'expression',
  'constant-inputs',
  'physics',
  'pose',
  'model-update',
] as const);

export interface CubismClipBakedRecipe extends OfflineConversionRecipe {
  readonly motion?: string;
  readonly expression?: string;
  readonly physics?: boolean;
  readonly pose?: boolean;
  readonly runtimeInputs?: readonly string[];
}

export interface CubismBuildTimeEvaluator {
  readonly version: string;
  readonly duration: number;
  readonly keyTimes?: readonly number[];
  readonly capabilities: Readonly<{ motion: boolean; expression: boolean; physics: boolean; pose: boolean; drawableColors?: boolean }>;
  evaluate(
    time: number,
    recipe: CubismClipBakedRecipe,
    updateOrder: typeof CUBISM_CLIP_BAKED_UPDATE_ORDER,
    signal: AbortSignal,
  ): Promise<CubismCaptureFrame>;
  close(): void | Promise<void>;
}

export interface CubismClipBakedSource {
  readonly entry: string;
  readonly name: string;
  readonly sourceVersion: string;
  readonly coreVersion: string;
  readonly canvas: CubismDrawableCapture['canvas'];
  readonly frameRate: number;
  readonly textures: readonly CubismCaptureTexture[];
  readonly dependencies: readonly Readonly<{ uri: string; integrity?: string }>[];
  readonly evaluator: CubismBuildTimeEvaluator;
}

export interface CubismClipBakedConversionOptions {
  readonly source: CubismClipBakedSource;
  readonly sourceBytes: Uint8Array;
  readonly recipe: CubismClipBakedRecipe;
  readonly host: OfflineConversionHost;
  readonly sampling: OfflineConversionSamplingOptions;
  readonly mode?: OfflineConversionMode;
  readonly signal?: AbortSignal;
  readonly dataPath?: string;
  readonly hyaPath?: string;
}

/** License-isolated adapter: the evaluator owns Core/Framework, while this module only sees captured drawables. */
export class CubismClipBakedAdapter implements OfflineConversionAdapter<CubismClipBakedSource, CubismCaptureFrame> {
  readonly id = 'live2d-cubism-clip-baked';
  readonly version = '1.1.0';

  async open(source: CubismClipBakedSource, recipe: OfflineConversionRecipe, context: { readonly signal: AbortSignal; readonly assets: ReadonlyMap<string, OfflineConversionResolvedAsset> }): Promise<OfflineConversionSession<CubismCaptureFrame>> {
    const typedRecipe = recipe as CubismClipBakedRecipe;
    validateSource(source);
    const diagnostics: OfflineConversionDiagnostic[] = [];
    for (let index = 0; index < source.dependencies.length; index++) {
      if (!context.assets.has(source.dependencies[index]!.uri)) diagnostics.push(error('E_CUBISM_DEPENDENCY_MISSING', `Required Cubism dependency "${source.dependencies[index]!.uri}" was not resolved.`, `$.dependencies[${index}]`));
    }
    const runtimeInputs = typedRecipe.runtimeInputs ?? [];
    for (let index = 0; index < runtimeInputs.length; index++) diagnostics.push(error('E_CUBISM_RUNTIME_INPUT_UNBAKED', `Runtime input "${runtimeInputs[index]}" is outside clip-baked playback.`, `$.recipe.runtimeInputs[${index}]`));
    requireCapability(source, typedRecipe.motion !== undefined, 'motion', diagnostics);
    requireCapability(source, typedRecipe.expression !== undefined, 'expression', diagnostics);
    requireCapability(source, typedRecipe.physics === true, 'physics', diagnostics);
    requireCapability(source, typedRecipe.pose === true, 'pose', diagnostics);
    if (source.evaluator.capabilities.drawableColors === false) diagnostics.push(warning('W_CUBISM_DRAWABLE_COLOR_UNAVAILABLE', 'Evaluator does not expose drawable multiply/screen colors; neutral fallback is used.', '$.evaluator.capabilities.drawableColors'));
    const seenDiagnostics = new Set(diagnostics.map(item => `${item.code}\0${item.path}`));
    const multiplyColorDrawables = new Set<string>();
    const screenColorDrawables = new Set<string>();
    const features: Record<string, number | boolean | string> = {
      motion: typedRecipe.motion === undefined ? false : true,
      expression: typedRecipe.expression === undefined ? false : true,
      physics: typedRecipe.physics === true,
      pose: typedRecipe.pose === true,
      textureCount: source.textures.length,
      drawableColorCapture: source.evaluator.capabilities.drawableColors === false ? 'unavailable' : source.evaluator.capabilities.drawableColors === true ? 'captured' : 'legacy-unspecified',
      multiplyColorDrawableCount: 0,
      screenColorDrawableCount: 0,
      multiplyColorDrawableFrameCount: 0,
      screenColorDrawableFrameCount: 0,
    };
    return {
      duration: typedRecipe.duration ?? source.evaluator.duration,
      ...(source.evaluator.keyTimes === undefined ? {} : { keyTimes: source.evaluator.keyTimes }),
      sourceVersion: source.sourceVersion,
      evaluatorVersion: `${source.coreVersion}+${source.evaluator.version}`,
      diagnostics,
      features,
      async evaluate(time, signal) {
        const frame = await source.evaluator.evaluate((typedRecipe.start ?? 0) + time, typedRecipe, CUBISM_CLIP_BAKED_UPDATE_ORDER, signal);
        const diagnosticStart = diagnostics.length;
        inspectFrame(frame, diagnostics, seenDiagnostics, time, source.evaluator.capabilities.drawableColors === true, features, multiplyColorDrawables, screenColorDrawables);
        const frameError = diagnostics.slice(diagnosticStart).find(item => item.severity === 'error');
        if (frameError) throw new OfflineConversionError('E_CUBISM_DRAWABLE_COLOR_INVALID', frameError.message, frameError.path);
        return frame;
      },
      close: () => source.evaluator.close(),
    };
  }
}

export async function runCubismClipBakedConversion(
  options: CubismClipBakedConversionOptions,
): Promise<OfflineConversionPipelineResult<CubismCaptureFrame>> {
  const dataPath = safeOutputPath(options.dataPath ?? 'model.hydm');
  const hyaPath = safeOutputPath(options.hyaPath ?? 'model.hya');
  return runOfflineConversion({
    source: options.source,
    sourceBytes: options.sourceBytes,
    adapter: new CubismClipBakedAdapter(),
    recipe: options.recipe,
    assets: options.source.dependencies,
    host: options.host,
    frame: CUBISM_CAPTURE_FRAME_OPERATIONS,
    sampling: options.sampling,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    async encode(input) {
      const capture: CubismDrawableCapture = {
        format: CUBISM_DRAWABLE_CAPTURE_FORMAT,
        version: CUBISM_DRAWABLE_CAPTURE_VERSION,
        name: options.source.name,
        source: Object.freeze({ kind: 'cubism-clip-baked-adapter', sourceVersion: options.source.sourceVersion, coreVersion: options.source.coreVersion, recipeId: options.recipe.id }),
        canvas: options.source.canvas,
        duration: input.times[input.times.length - 1]!,
        frameRate: options.source.frameRate,
        textures: options.source.textures.map(texture => Object.freeze({ ...texture })),
        frames: Object.freeze(input.frames.map((frame, index) => Object.freeze({ ...frame, time: input.times[index]! }))),
      };
      const converted = convertCubismCaptureToHya(capture, { dataUri: dataPath, strict: options.mode === 'strict' });
      const dataHash = await options.host.sha256(new Uint8Array(converted.data));
      const document: AnimationDocument = {
        ...converted.document,
        resources: (converted.document.resources ?? []).map(resource => resource.type === 'binary'
          ? { ...resource, integrity: `sha256-${dataHash.toLowerCase()}` }
          : resource),
      };
      const hya = new Uint8Array(encodeAnimationBinary(document, { extensions: createDeformableMesh2DFormatRegistry() }));
      const textures = options.source.textures.map(texture => {
        const asset = input.assets.get(texture.uri);
        if (!asset) throw new OfflineConversionError('E_CONVERSION_ASSET_MISSING', `Texture "${texture.uri}" was not resolved.`, '$textures');
        return { path: safeOutputPath(texture.uri), bytes: asset.bytes, mimeType: 'image/png' };
      });
      return [
        { path: hyaPath, bytes: hya, mimeType: 'application/vnd.haiyue.animation' },
        { path: dataPath, bytes: new Uint8Array(converted.data), mimeType: 'application/vnd.haiyue.deformable-mesh-2d' },
        ...textures,
      ];
    },
  });
}

export const CUBISM_CAPTURE_FRAME_OPERATIONS: OfflineConversionFrameOperations<CubismCaptureFrame> = {
  interpolate(left, right, progress) {
    assertCompatibleFrames(left, right);
    return Object.freeze({
      time: left.time + (right.time - left.time) * progress,
      drawables: Object.freeze(left.drawables.map((drawable, index) => {
        const next = right.drawables[index]!;
        return Object.freeze({
          ...drawable,
          opacity: mix(drawable.opacity, next.opacity, progress),
          positions: Object.freeze(drawable.positions.map((value, valueIndex) => mix(value, next.positions[valueIndex]!, progress))),
          multiplyColor: interpolateColor(drawable.multiplyColor, next.multiplyColor, progress, [1, 1, 1, 1]),
          screenColor: interpolateColor(drawable.screenColor, next.screenColor, progress, [0, 0, 0, 0]),
          renderOrder: progress < 0.5 ? drawable.renderOrder : next.renderOrder,
        });
      })),
    });
  },
  error(actual, interpolated) {
    assertCompatibleFrames(actual, interpolated);
    let maximum = 0;
    for (let drawableIndex = 0; drawableIndex < actual.drawables.length; drawableIndex++) {
      const left = actual.drawables[drawableIndex]!;
      const right = interpolated.drawables[drawableIndex]!;
      maximum = Math.max(maximum, Math.abs(left.opacity - right.opacity));
      for (let index = 0; index < left.positions.length; index++) maximum = Math.max(maximum, Math.abs(left.positions[index]! - right.positions[index]!));
      maximum = Math.max(maximum, colorError(left.multiplyColor, right.multiplyColor, [1, 1, 1, 1]));
      maximum = Math.max(maximum, colorError(left.screenColor, right.screenColor, [0, 0, 0, 0]));
    }
    return maximum;
  },
  quantize(frame, step) {
    return Object.freeze({
      ...frame,
      drawables: Object.freeze(frame.drawables.map(drawable => Object.freeze({
        ...drawable,
        opacity: quantize(drawable.opacity, step),
        positions: Object.freeze(drawable.positions.map(value => quantize(value, step))),
        ...(drawable.multiplyColor === undefined ? {} : { multiplyColor: quantizeColor(drawable.multiplyColor, step) }),
        ...(drawable.screenColor === undefined ? {} : { screenColor: quantizeColor(drawable.screenColor, step) }),
      }))),
    });
  },
  dirtyChannels(previous, current) {
    if (!previous) return Object.freeze(current.drawables.flatMap((_, index) => [`drawable/${index}/vertices`, `drawable/${index}/opacity`, `drawable/${index}/color`, `drawable/${index}/order`]));
    assertCompatibleFrames(previous, current);
    const dirty: string[] = [];
    for (let index = 0; index < current.drawables.length; index++) {
      const before = previous.drawables[index]!;
      const after = current.drawables[index]!;
      if (before.positions.some((value, valueIndex) => value !== after.positions[valueIndex])) dirty.push(`drawable/${index}/vertices`);
      if (before.opacity !== after.opacity) dirty.push(`drawable/${index}/opacity`);
      if (!sameColor(before.multiplyColor, after.multiplyColor, [1, 1, 1, 1]) || !sameColor(before.screenColor, after.screenColor, [0, 0, 0, 0])) dirty.push(`drawable/${index}/color`);
      if (before.renderOrder !== after.renderOrder) dirty.push(`drawable/${index}/order`);
    }
    return Object.freeze(dirty);
  },
};

function validateSource(source: CubismClipBakedSource): void {
  const lower = source.entry.toLowerCase();
  if (lower.endsWith('.wpk') || lower.endsWith('.cmo3')) throw new OfflineConversionError('E_CUBISM_WPK_UNSUPPORTED', 'Export an authorized Cubism runtime asset set first; protected containers are not accepted.', '$.entry');
  if (!lower.endsWith('.model3.json')) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Cubism entry must be a model3.json runtime asset.', '$.entry');
  if (!source.name || !source.sourceVersion || !source.coreVersion || !Number.isFinite(source.frameRate) || source.frameRate <= 0 || source.textures.length === 0) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Cubism source metadata is incomplete.', '$source');
  for (const dependency of source.dependencies) safeOutputPath(dependency.uri);
  for (const texture of source.textures) safeOutputPath(texture.uri);
}

function requireCapability(source: CubismClipBakedSource, required: boolean, capability: keyof CubismBuildTimeEvaluator['capabilities'], diagnostics: OfflineConversionDiagnostic[]): void {
  if (required && !source.evaluator.capabilities[capability]) diagnostics.push(error('E_CUBISM_RECIPE_CAPABILITY_MISSING', `Evaluator does not support requested ${capability} baking.`, `$.recipe.${capability}`));
}

function inspectFrame(
  frame: CubismCaptureFrame,
  diagnostics: OfflineConversionDiagnostic[],
  seen: Set<string>,
  time: number,
  drawableColorsRequired: boolean,
  features: Record<string, number | boolean | string>,
  multiplyColorDrawables: Set<string>,
  screenColorDrawables: Set<string>,
): void {
  for (let index = 0; index < frame.drawables.length; index++) {
    const drawable = frame.drawables[index]!;
    inspectColor(drawable.multiplyColor, drawableColorsRequired, `$.frames[time=${time}].drawables[${index}].multiplyColor`, diagnostics, seen);
    inspectColor(drawable.screenColor, drawableColorsRequired, `$.frames[time=${time}].drawables[${index}].screenColor`, diagnostics, seen);
    if (!neutralRgb(drawable.multiplyColor, 1)) {
      multiplyColorDrawables.add(drawable.id);
      features.multiplyColorDrawableFrameCount = Number(features.multiplyColorDrawableFrameCount) + 1;
    }
    if (!neutralRgb(drawable.screenColor, 0)) {
      screenColorDrawables.add(drawable.id);
      features.screenColorDrawableFrameCount = Number(features.screenColorDrawableFrameCount) + 1;
    }
  }
  features.multiplyColorDrawableCount = multiplyColorDrawables.size;
  features.screenColorDrawableCount = screenColorDrawables.size;
}

function assertCompatibleFrames(left: CubismCaptureFrame, right: CubismCaptureFrame): void {
  if (left.drawables.length !== right.drawables.length) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Evaluator changed drawable population.', '$frames');
  for (let index = 0; index < left.drawables.length; index++) {
    const a = left.drawables[index]!;
    const b = right.drawables[index]!;
    if (a.id !== b.id || a.positions.length !== b.positions.length || a.indices.length !== b.indices.length || a.uvs.length !== b.uvs.length || a.indices.some((value, valueIndex) => value !== b.indices[valueIndex]) || a.uvs.some((value, valueIndex) => value !== b.uvs[valueIndex])) {
      throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Evaluator changed drawable topology.', `$.drawables[${index}]`);
    }
  }
}

function safeOutputPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized) || normalized.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/iu.test(normalized)) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', `Unsafe package path "${value}".`, '$path');
  return normalized;
}

function addDiagnostic(target: OfflineConversionDiagnostic[], seen: Set<string>, diagnostic: OfflineConversionDiagnostic): void { const key = `${diagnostic.code}\0${diagnostic.path}`; if (!seen.has(key)) { seen.add(key); target.push(diagnostic); } }
function error(code: string, message: string, path: string): OfflineConversionDiagnostic { return Object.freeze({ severity: 'error', code, message, path }); }
function warning(code: string, message: string, path: string): OfflineConversionDiagnostic { return Object.freeze({ severity: 'warning', code, message, path }); }
function inspectColor(value: readonly number[] | undefined, required: boolean, path: string, diagnostics: OfflineConversionDiagnostic[], seen: Set<string>): void {
  if (value === undefined) {
    if (required) addDiagnostic(diagnostics, seen, error('E_CUBISM_DRAWABLE_COLOR_INVALID', 'Evaluator declared drawable color support but omitted a color.', path));
    return;
  }
  if (value.length !== 4 || value.some(component => !Number.isFinite(component) || component < -1e-4 || component > 1 + 1e-4)) addDiagnostic(diagnostics, seen, error('E_CUBISM_DRAWABLE_COLOR_INVALID', 'Drawable color must contain four finite values inside [0, 1].', path));
}
function interpolateColor(left: readonly number[] | undefined, right: readonly number[] | undefined, progress: number, fallback: readonly [number, number, number, number]): readonly [number, number, number, number] {
  return Object.freeze([0, 1, 2, 3].map(index => mix(left?.[index] ?? fallback[index]!, right?.[index] ?? fallback[index]!, progress))) as unknown as readonly [number, number, number, number];
}
function colorError(left: readonly number[] | undefined, right: readonly number[] | undefined, fallback: readonly [number, number, number, number]): number {
  let maximum = 0;
  for (let index = 0; index < 4; index++) maximum = Math.max(maximum, Math.abs((left?.[index] ?? fallback[index]!) - (right?.[index] ?? fallback[index]!)));
  return maximum;
}
function quantizeColor(value: readonly [number, number, number, number], step: number): readonly [number, number, number, number] {
  return Object.freeze(value.map(component => clamp(quantize(component, step), 0, 1))) as unknown as readonly [number, number, number, number];
}
function sameColor(left: readonly number[] | undefined, right: readonly number[] | undefined, fallback: readonly [number, number, number, number]): boolean {
  for (let index = 0; index < 4; index++) if ((left?.[index] ?? fallback[index]) !== (right?.[index] ?? fallback[index])) return false;
  return true;
}
function neutralRgb(value: readonly number[] | undefined, expected: number): boolean { return value === undefined || (value.length === 4 && value[0] === expected && value[1] === expected && value[2] === expected); }
function mix(left: number, right: number, progress: number): number { return left + (right - left) * progress; }
function quantize(value: number, step: number): number { return Math.round(value / step) * step; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
