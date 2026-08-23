export type OfflineConversionMode = 'normal' | 'strict';

export interface OfflineConversionDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface OfflineConversionAssetRequest {
  readonly uri: string;
  readonly integrity?: string;
}

export interface OfflineConversionResolvedAsset {
  readonly uri: string;
  readonly bytes: Uint8Array;
  readonly integrity: string;
}

export interface OfflineConversionRecipe {
  readonly id: string;
  readonly clip: string;
  readonly start?: number;
  readonly duration?: number;
  readonly constants?: Readonly<Record<string, number>>;
  readonly bake?: Readonly<Record<string, boolean>>;
}

export interface OfflineConversionAdapterContext {
  readonly signal: AbortSignal;
  readonly assets: ReadonlyMap<string, OfflineConversionResolvedAsset>;
}

export interface OfflineConversionSession<TFrame> {
  readonly duration: number;
  readonly keyTimes?: readonly number[];
  readonly sourceVersion: string;
  readonly evaluatorVersion: string;
  readonly diagnostics?: readonly OfflineConversionDiagnostic[];
  readonly features?: Readonly<Record<string, number | boolean | string>>;
  evaluate(time: number, signal: AbortSignal): Promise<TFrame>;
  close(): void | Promise<void>;
}

export interface OfflineConversionAdapter<TSource, TFrame> {
  readonly id: string;
  readonly version: string;
  open(source: TSource, recipe: OfflineConversionRecipe, context: OfflineConversionAdapterContext): Promise<OfflineConversionSession<TFrame>>;
}

export interface OfflineConversionArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
}

export interface OfflineConversionTransaction {
  stage(path: string, bytes: Uint8Array): void | Promise<void>;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export interface OfflineConversionHost {
  readAsset(uri: string, signal: AbortSignal): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<string>;
  beginTransaction?(): OfflineConversionTransaction | Promise<OfflineConversionTransaction>;
}

export interface OfflineConversionFrameOperations<TFrame> {
  interpolate(left: TFrame, right: TFrame, progress: number): TFrame;
  error(actual: TFrame, interpolated: TFrame): number;
  quantize(frame: TFrame, step: number): TFrame;
  dirtyChannels(previous: TFrame | undefined, current: TFrame): readonly string[];
}

export interface OfflineConversionSamplingOptions {
  readonly tolerance: number;
  readonly quantizationStep: number;
  readonly maxDepth?: number;
  readonly evaluationConcurrency?: number;
}

export interface OfflineConversionEncodeInput<TFrame> {
  readonly times: Float32Array;
  readonly frames: readonly TFrame[];
  readonly dirtyChannels: readonly (readonly string[])[];
  readonly recipe: OfflineConversionRecipe;
  readonly assets: ReadonlyMap<string, OfflineConversionResolvedAsset>;
}

export interface OfflineConversionPipelineOptions<TSource, TFrame> {
  readonly source: TSource;
  readonly sourceBytes: Uint8Array;
  readonly adapter: OfflineConversionAdapter<TSource, TFrame>;
  readonly recipe: OfflineConversionRecipe;
  readonly assets?: readonly OfflineConversionAssetRequest[];
  readonly host: OfflineConversionHost;
  readonly frame: OfflineConversionFrameOperations<TFrame>;
  readonly sampling: OfflineConversionSamplingOptions;
  readonly mode?: OfflineConversionMode;
  readonly signal?: AbortSignal;
  readonly encode: (input: OfflineConversionEncodeInput<TFrame>) => readonly OfflineConversionArtifact[] | Promise<readonly OfflineConversionArtifact[]>;
  readonly onProgress?: (progress: Readonly<{ phase: 'assets' | 'sampling' | 'encoding' | 'committing'; completed: number; total: number }>) => void;
}

export interface OfflineConversionReport {
  readonly schemaVersion: 1;
  readonly adapter: Readonly<{ id: string; version: string; sourceVersion: string; evaluatorVersion: string }>;
  readonly sourceIntegrity: string;
  readonly assets: readonly Readonly<{ uri: string; integrity: string; bytes: number }>[];
  readonly recipe: OfflineConversionRecipe;
  readonly sampling: Readonly<{ tolerance: number; quantizationStep: number; maxDepth: number; frameCount: number; dirtyChannelCount: number }>;
  readonly features: Readonly<Record<string, number | boolean | string>>;
  readonly diagnostics: readonly OfflineConversionDiagnostic[];
  readonly outputs: readonly Readonly<{ path: string; integrity: string; bytes: number; mimeType?: string }>[];
  readonly unclassifiedFailureCount: 0;
}

export interface OfflineConversionPipelineResult<TFrame> {
  readonly times: Float32Array;
  readonly frames: readonly TFrame[];
  readonly artifacts: readonly OfflineConversionArtifact[];
  readonly report: OfflineConversionReport;
  readonly reportBytes: Uint8Array;
}

export class OfflineConversionError extends Error {
  readonly code:
    | 'E_CONVERSION_ABORTED'
    | 'E_CONVERSION_ASSET_MISSING'
    | 'E_CONVERSION_HASH_MISMATCH'
    | 'E_CONVERSION_STRICT_DIAGNOSTIC'
    | 'E_CONVERSION_ERROR_BOUND'
    | 'E_CONVERSION_INVALID_ADAPTER'
    | 'E_CUBISM_DEPENDENCY_MISSING'
    | 'E_CUBISM_RUNTIME_INPUT_UNBAKED'
    | 'E_CUBISM_RECIPE_CAPABILITY_MISSING'
    | 'E_CUBISM_DRAWABLE_COLOR_INVALID'
    | 'E_CUBISM_WPK_UNSUPPORTED';
  readonly path: string;

  constructor(code: OfflineConversionError['code'], message: string, path: string) {
    super(message);
    this.name = 'OfflineConversionError';
    this.code = code;
    this.path = path;
  }
}

/** Runs a source-pure evaluator and commits only a complete deterministic artifact set. */
export async function runOfflineConversion<TSource, TFrame>(
  options: OfflineConversionPipelineOptions<TSource, TFrame>,
): Promise<OfflineConversionPipelineResult<TFrame>> {
  validateOptions(options);
  const signal = options.signal ?? new AbortController().signal;
  assertNotAborted(signal);
  const transaction = options.host.beginTransaction ? await options.host.beginTransaction() : undefined;
  let session: OfflineConversionSession<TFrame> | undefined;
  let committed = false;
  try {
    const assets = await resolveAssets(options.assets ?? [], options.host, signal, options.onProgress);
    assertNotAborted(signal);
    session = await options.adapter.open(options.source, options.recipe, { signal, assets });
    assertNotAborted(signal);
    if (!Number.isFinite(session.duration) || session.duration <= 0 || !session.sourceVersion || !session.evaluatorVersion) {
      throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Adapter session must provide a positive duration and stable versions.', '$adapter');
    }
    const openingDiagnostics = canonicalDiagnostics(session.diagnostics ?? []);
    const openingError = openingDiagnostics.find(item => item.severity === 'error');
    if (openingError) throw new OfflineConversionError(sourceErrorCode(openingError.code), openingError.message, openingError.path);
    const sampled = await adaptiveSample(session, options.frame, options.sampling, signal, options.onProgress);
    const diagnostics = canonicalDiagnostics(session.diagnostics ?? []);
    const diagnosticError = diagnostics.find(item => item.severity === 'error');
    if (diagnosticError) throw new OfflineConversionError(sourceErrorCode(diagnosticError.code), diagnosticError.message, diagnosticError.path);
    if (options.mode === 'strict' && diagnostics.length > 0) {
      throw new OfflineConversionError('E_CONVERSION_STRICT_DIAGNOSTIC', 'Conversion diagnostics rejected the selected mode.', '$diagnostics');
    }
    const dirtyChannels = sampled.frames.map((frame, index) => Object.freeze([...options.frame.dirtyChannels(sampled.frames[index - 1], frame)].sort()));
    options.onProgress?.({ phase: 'encoding', completed: 0, total: 1 });
    const artifacts = canonicalArtifacts(await options.encode({ ...sampled, dirtyChannels, recipe: options.recipe, assets }));
    assertNotAborted(signal);
    options.onProgress?.({ phase: 'encoding', completed: 1, total: 1 });
    const [sourceIntegrity, outputFacts] = await Promise.all([
      digest(options.host, options.sourceBytes),
      Promise.all(artifacts.map(async artifact => Object.freeze({
        path: artifact.path,
        integrity: await digest(options.host, artifact.bytes),
        bytes: artifact.bytes.byteLength,
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      }))),
    ]);
    assertNotAborted(signal);
    const report: OfflineConversionReport = Object.freeze({
      schemaVersion: 1,
      adapter: Object.freeze({ id: options.adapter.id, version: options.adapter.version, sourceVersion: session.sourceVersion, evaluatorVersion: session.evaluatorVersion }),
      sourceIntegrity,
      assets: Object.freeze([...assets.values()].sort((left, right) => left.uri.localeCompare(right.uri)).map(asset => Object.freeze({ uri: asset.uri, integrity: asset.integrity, bytes: asset.bytes.byteLength }))),
      recipe: canonicalObject(options.recipe) as unknown as OfflineConversionRecipe,
      sampling: Object.freeze({
        tolerance: options.sampling.tolerance,
        quantizationStep: options.sampling.quantizationStep,
        maxDepth: options.sampling.maxDepth ?? 12,
        frameCount: sampled.frames.length,
        dirtyChannelCount: dirtyChannels.reduce((sum, channels) => sum + channels.length, 0),
      }),
      features: Object.freeze(canonicalObject(session.features ?? {})) as Readonly<Record<string, number | boolean | string>>,
      diagnostics: Object.freeze(diagnostics),
      outputs: Object.freeze(outputFacts),
      unclassifiedFailureCount: 0,
    });
    const reportBytes = new TextEncoder().encode(`${stableStringify(report)}\n`);
    await session.close();
    session = undefined;
    assertNotAborted(signal);
    if (transaction) {
      options.onProgress?.({ phase: 'committing', completed: 0, total: artifacts.length + 1 });
      for (let index = 0; index < artifacts.length; index++) {
        assertNotAborted(signal);
        await transaction.stage(artifacts[index]!.path, artifacts[index]!.bytes);
        options.onProgress?.({ phase: 'committing', completed: index + 1, total: artifacts.length + 1 });
      }
      assertNotAborted(signal);
      await transaction.stage('conversion-report.json', reportBytes);
      await transaction.commit();
      committed = true;
      options.onProgress?.({ phase: 'committing', completed: artifacts.length + 1, total: artifacts.length + 1 });
    }
    return Object.freeze({ times: sampled.times, frames: sampled.frames, artifacts, report, reportBytes });
  } catch (error) {
    if (signal.aborted && !(error instanceof OfflineConversionError)) throw aborted();
    throw error;
  } finally {
    try { await session?.close(); } finally { if (transaction && !committed) await transaction.rollback(); }
  }
}

async function adaptiveSample<TFrame>(
  session: OfflineConversionSession<TFrame>,
  operations: OfflineConversionFrameOperations<TFrame>,
  options: OfflineConversionSamplingOptions,
  signal: AbortSignal,
  progress?: OfflineConversionPipelineOptions<unknown, TFrame>['onProgress'],
): Promise<{ readonly times: Float32Array; readonly frames: readonly TFrame[] }> {
  const cache = new Map<number, Promise<TFrame>>();
  const schedule = createLimiter(options.evaluationConcurrency ?? 1);
  let evaluated = 0;
  const evaluate = (time: number): Promise<TFrame> => {
    const key = Math.fround(time);
    let pending = cache.get(key);
    if (!pending) {
      pending = schedule(() => session.evaluate(key, signal)).then(frame => {
        assertNotAborted(signal);
        evaluated++;
        progress?.({ phase: 'sampling', completed: evaluated, total: Math.max(evaluated, cache.size) });
        return frame;
      });
      cache.set(key, pending);
    }
    return pending;
  };
  const maxDepth = options.maxDepth ?? 12;
  const seeds = [0, ...(session.keyTimes ?? []), session.duration]
    .filter((time, index, values) => Number.isFinite(time) && time >= 0 && time <= session.duration && values.indexOf(time) === index)
    .sort((left, right) => left - right);
  if (seeds[0] !== 0 || seeds[seeds.length - 1] !== session.duration) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Adapter key times must stay inside the session duration.', '$adapter.keyTimes');
  const seedFrames = await Promise.all(seeds.map(evaluate));
  const refine = async (leftTime: number, left: TFrame, rightTime: number, right: TFrame, depth: number): Promise<void> => {
    const middleTime = Math.fround((leftTime + rightTime) / 2);
    if (middleTime <= leftTime || middleTime >= rightTime) return;
    const actual = await evaluate(middleTime);
    const error = operations.error(actual, operations.interpolate(left, right, (middleTime - leftTime) / (rightTime - leftTime)));
    if (!Number.isFinite(error) || error < 0) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Frame error evaluator returned an invalid value.', '$sampling.error');
    if (error <= options.tolerance) return;
    if (depth >= maxDepth) throw new OfflineConversionError('E_CONVERSION_ERROR_BOUND', `Adaptive sampling could not reach tolerance ${options.tolerance}.`, '$sampling.tolerance');
    await Promise.all([refine(leftTime, left, middleTime, actual, depth + 1), refine(middleTime, actual, rightTime, right, depth + 1)]);
  };
  await Promise.all(seeds.slice(0, -1).map((leftTime, index) => refine(leftTime, seedFrames[index]!, seeds[index + 1]!, seedFrames[index + 1]!, 0)));
  assertNotAborted(signal);
  const times = [...cache.keys()].sort((left, right) => left - right);
  const frames = await Promise.all(times.map(async time => operations.quantize(await cache.get(time)!, options.quantizationStep)));
  return Object.freeze({ times: Float32Array.from(times), frames: Object.freeze(frames) });
}

async function resolveAssets(
  requests: readonly OfflineConversionAssetRequest[],
  host: OfflineConversionHost,
  signal: AbortSignal,
  progress?: OfflineConversionPipelineOptions<unknown, unknown>['onProgress'],
): Promise<ReadonlyMap<string, OfflineConversionResolvedAsset>> {
  const result = new Map<string, OfflineConversionResolvedAsset>();
  const ordered = [...requests].sort((left, right) => left.uri.localeCompare(right.uri));
  for (let index = 0; index < ordered.length; index++) {
    const request = ordered[index]!;
    if (!request.uri || result.has(request.uri)) throw new OfflineConversionError('E_CONVERSION_ASSET_MISSING', 'Asset URIs must be non-empty and unique.', '$assets');
    let bytes: Uint8Array;
    try { bytes = await host.readAsset(request.uri, signal); }
    catch (error) { throw new OfflineConversionError('E_CONVERSION_ASSET_MISSING', `Asset "${request.uri}" could not be read: ${error instanceof Error ? error.message : String(error)}`, `$assets[${index}]`); }
    assertNotAborted(signal);
    const integrity = await digest(host, bytes);
    if (request.integrity !== undefined && request.integrity !== integrity) throw new OfflineConversionError('E_CONVERSION_HASH_MISMATCH', `Asset "${request.uri}" integrity changed.`, `$assets[${index}].integrity`);
    result.set(request.uri, Object.freeze({ uri: request.uri, bytes, integrity }));
    progress?.({ phase: 'assets', completed: index + 1, total: ordered.length });
  }
  return result;
}

function validateOptions<TSource, TFrame>(options: OfflineConversionPipelineOptions<TSource, TFrame>): void {
  if (!options.adapter.id || !options.adapter.version || !options.recipe.id || !options.recipe.clip) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Adapter and recipe ids must be non-empty.', '$');
  if (!Number.isFinite(options.sampling.tolerance) || options.sampling.tolerance < 0) throw new RangeError('Sampling tolerance must be finite and non-negative.');
  if (!Number.isFinite(options.sampling.quantizationStep) || options.sampling.quantizationStep <= 0) throw new RangeError('Quantization step must be positive and finite.');
  const maxDepth = options.sampling.maxDepth ?? 12;
  const concurrency = options.sampling.evaluationConcurrency ?? 1;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 24) throw new RangeError('Sampling maxDepth must be an integer inside 0-24.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new RangeError('Evaluation concurrency must be an integer inside 1-32.');
}

function canonicalDiagnostics(source: readonly OfflineConversionDiagnostic[]): readonly OfflineConversionDiagnostic[] {
  return Object.freeze([...source].map(item => Object.freeze({ ...item })).sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)));
}

function canonicalArtifacts(source: readonly OfflineConversionArtifact[]): readonly OfflineConversionArtifact[] {
  const ordered = [...source].sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  for (const artifact of ordered) {
    if (!artifact.path || paths.has(artifact.path) || !(artifact.bytes instanceof Uint8Array)) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'Encoded artifact paths must be non-empty, unique, and byte-backed.', '$outputs');
    paths.add(artifact.path);
  }
  return Object.freeze(ordered.map(artifact => Object.freeze({ ...artifact, bytes: artifact.bytes.slice() })));
}

async function digest(host: OfflineConversionHost, bytes: Uint8Array): Promise<string> {
  const value = (await host.sha256(bytes)).toLowerCase();
  if (!/^[a-f\d]{64}$/u.test(value)) throw new OfflineConversionError('E_CONVERSION_INVALID_ADAPTER', 'SHA-256 host must return 64 lowercase-compatible hex characters.', '$host.sha256');
  return `sha256-${value}`;
}

function canonicalObject(value: object): Record<string, unknown> {
  return JSON.parse(stableStringify(value)) as Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry)]));
}

function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw aborted(); }
function aborted(): OfflineConversionError { return new OfflineConversionError('E_CONVERSION_ABORTED', 'Offline conversion was aborted.', '$signal'); }
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}
function sourceErrorCode(code: string): OfflineConversionError['code'] {
  return [
    'E_CUBISM_DEPENDENCY_MISSING',
    'E_CUBISM_RUNTIME_INPUT_UNBAKED',
    'E_CUBISM_RECIPE_CAPABILITY_MISSING',
    'E_CUBISM_DRAWABLE_COLOR_INVALID',
    'E_CUBISM_WPK_UNSUPPORTED',
  ].includes(code) ? code as OfflineConversionError['code'] : 'E_CONVERSION_STRICT_DIAGNOSTIC';
}
