import { RiveImportError } from './error.js';
import { FROZEN_OBJECTS, FROZEN_PROPERTIES, FROZEN_REGISTRY_IDENTITY } from './generated/frozen-registry.js';
import { readFrozenRiv, type ParsedObject, type ParsedRiv } from './read-riv.js';
import {
  RIVE_IMPORT_HARD_LIMITS,
  type FrozenRiveEvaluator,
  type ImportFrozenRivOptions,
  type NeutralAnimationIR,
  type NeutralImportedObject,
  type NeutralResolvedResource,
  type RiveAssetRequest,
  type RiveExternalAssetManifestEntry,
  type RiveImportDiagnosticContext,
  type RiveImportLimits,
  type RiveImportReport,
  type RiveNeutralImportResult,
  type RiveResolvedAsset,
} from './types.js';

const EXPECTED_EVALUATOR_FLAGS = Object.freeze({
  WITH_RIVE_TEXT: true,
  WITH_RIVE_LAYOUT: true,
  WITH_RIVE_AUDIO: true,
  WITH_RIVE_SCRIPTING: true,
  RIVE_DECODERS: true,
  RIVE_PNG: true,
  RIVE_JPEG: true,
  RIVE_WEBP: true,
  RIVE_WEBGL: true,
});

interface AssetCandidate {
  readonly object: ParsedObject;
  request: RiveAssetRequest;
  embedded?: Uint8Array;
}

interface ResolvedAssetSet {
  readonly resources: readonly NeutralResolvedResource[];
  readonly evaluatorAssets: readonly Readonly<{ assetId: number; bytes: Uint8Array; mimeType: string }>[];
}

type ResolvedAssetValue = Readonly<{
  resource: NeutralResolvedResource;
  evaluatorAsset: Readonly<{ assetId: number; bytes: Uint8Array; mimeType: string }>;
}>;

export async function importFrozenRiv(
  input: Uint8Array,
  options: ImportFrozenRivOptions = {},
): Promise<RiveNeutralImportResult> {
  if (input.byteLength > RIVE_IMPORT_HARD_LIMITS.rivBytes) {
    throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', 'Rive import exceeded rivBytes.', '$.riv', {
      tupleId: FROZEN_REGISTRY_IDENTITY.compatibilityTupleId,
      inputSha256: 'not-computed-hard-byte-gate',
      profile: 'full-fidelity',
      goal: 'g02-riv-import-neutral-ir',
      observed: input.byteLength,
      limit: RIVE_IMPORT_HARD_LIMITS.rivBytes,
      budget: 'rivBytes',
    });
  }

  const ownedBytes = Uint8Array.from(input);
  const inputSha256 = await sha256(ownedBytes);
  const context: RiveImportDiagnosticContext = Object.freeze({
    tupleId: FROZEN_REGISTRY_IDENTITY.compatibilityTupleId,
    inputSha256,
    profile: 'full-fidelity',
    goal: 'g02-riv-import-neutral-ir',
  });
  const limits = normalizeLimits(options.limits, context);
  assertLimit(input.byteLength, limits.rivBytes, 'rivBytes', '$.riv', context);
  const operation = createOperationSignal(options.signal, limits.importWallMs, context);

  try {
    operation.assertActive();
    const parsed = readFrozenRiv(ownedBytes, limits, context);
    const formatContext = Object.freeze({ ...context, formatMajor: 7, formatMinor: 3 });
    operation.assertActive();
    const resolvedAssets = await resolveAssets(parsed, options, limits, operation.signal, formatContext);
    operation.assertActive();
    const evaluator = await evaluateIfRequested(options.evaluator, ownedBytes, resolvedAssets.evaluatorAssets, limits, operation.signal, formatContext);
    operation.assertActive();

    const ir = buildNeutralIr(parsed, resolvedAssets.resources);
    const report = buildReport(parsed, ir, evaluator, inputSha256, ownedBytes.byteLength);
    const irBytes = new TextEncoder().encode(`${stableStringify(ir)}\n`);
    const reportBytes = new TextEncoder().encode(`${stableStringify(report)}\n`);
    return Object.freeze({ ir, report, irBytes, reportBytes });
  } catch (cause) {
    operation.assertActive(cause);
    if (cause instanceof RiveImportError) throw cause;
    throw new RiveImportError('E_RIVE_INTERNAL', 'Rive import failed an internal invariant.', '$.riv', context, { cause });
  } finally {
    operation.dispose();
  }
}

function buildNeutralIr(parsed: ParsedRiv, resolvedResources: readonly NeutralResolvedResource[]): NeutralAnimationIR {
  const categories: Record<string, string[]> = {
    artboards: [], instances: [], nodes: [], drawables: [], resources: [], geometry: [], paints: [], rigs: [], constraints: [],
    layouts: [], text: [], timelines: [], stateMachines: [], dataModels: [], interactions: [], events: [], audioSchedules: [], semantics: [], sandboxPrograms: [],
  };
  const objects: NeutralImportedObject[] = [];
  for (const object of parsed.objects) {
    const name = object.source.name;
    const id = object.neutralObjectId;
    const neutralObject: NeutralImportedObject = Object.freeze({
      id,
      family: neutralFamily(object.source.family),
      properties: Object.freeze(object.properties.map(property => property.neutral)),
    });
    objects.push(neutralObject);
    categories.nodes!.push(id);
    if (name === 'Artboard') categories.artboards!.push(id);
    if (/NestedArtboard|ArtboardInstance|ComponentList/.test(name)) categories.instances!.push(id);
    if (object.source.lineage.includes('Drawable')) categories.drawables!.push(id);
    if (/Asset|Resource|FileAssetContents|Folder/.test(name)) categories.resources!.push(id);
    if (/Path|Shape|Vertex|Mesh|Contour|Rectangle|Ellipse|Polygon|Star|Triangle|Image/.test(name)) categories.geometry!.push(id);
    if (/Paint|Fill|Stroke|Gradient|Color|Feather|Dash|Trim|Blend|Clip/.test(name)) categories.paints!.push(id);
    if (/Bone|Skin|Tendon|Weight|Mesh/.test(name)) categories.rigs!.push(id);
    if (/Constraint/.test(name)) categories.constraints!.push(id);
    if (/Layout|Grid|Axis|Scroll/.test(name)) categories.layouts!.push(id);
    if (/Text|Font/.test(name)) categories.text!.push(id);
    if (/Animation|KeyFrame|Keyed|Interpolator/.test(name)) categories.timelines!.push(id);
    if (/StateMachine|Transition|LayerState|State$|BlendState/.test(name)) categories.stateMachines!.push(id);
    if (/ViewModel|Data|Bindable|Converter|Enum|Formula/.test(name)) categories.dataModels!.push(id);
    if (/Listener|Input|Joystick|Keyboard|Gamepad|Focus|Pointer/.test(name)) categories.interactions!.push(id);
    if (/Event|ListenerAction|Trigger/.test(name)) categories.events!.push(id);
    if (/Audio/.test(name)) categories.audioSchedules!.push(id);
    if (/Semantic/.test(name)) categories.semantics!.push(id);
    if (/Script|Shader|Program/.test(name)) categories.sandboxPrograms!.push(id);
  }
  const frozen = (name: string): readonly string[] => Object.freeze(categories[name] ?? []);
  return Object.freeze({
    schema: 'NeutralAnimationIR', version: 1, coordinateSystem: 'screen-y-down', units: 'css-pixel-like', colorSpace: 'unpremultiplied-srgb',
    objects: Object.freeze(objects),
    artboards: frozen('artboards'), instances: frozen('instances'), nodes: frozen('nodes'), drawables: frozen('drawables'), resources: frozen('resources'),
    geometry: frozen('geometry'), paints: frozen('paints'), rigs: frozen('rigs'), constraints: frozen('constraints'), layouts: frozen('layouts'), text: frozen('text'),
    timelines: frozen('timelines'), stateMachines: frozen('stateMachines'), dataModels: frozen('dataModels'), interactions: frozen('interactions'), events: frozen('events'),
    audioSchedules: frozen('audioSchedules'), semantics: frozen('semantics'), sandboxPrograms: frozen('sandboxPrograms'),
    resolvedResources: Object.freeze([...resolvedResources]),
  });
}

function buildReport(
  parsed: ParsedRiv,
  ir: NeutralAnimationIR,
  evaluator: Readonly<{ used: boolean; adapterId?: string; evidenceSha256?: string }>,
  inputSha256: string,
  byteLength: number,
): RiveImportReport {
  return Object.freeze({
    schema: 'haiyue-rive-neutral-import-report', version: 1,
    compatibility: FROZEN_REGISTRY_IDENTITY,
    input: Object.freeze({ sha256: inputSha256, byteLength, fingerprint: 'RIVE', major: 7, minor: 3, fileId: parsed.fileId }),
    counts: Object.freeze({ objects: parsed.objects.length, runtimeNullObjects: parsed.runtimeNullObjects.length, ...parsed.counts, resolvedAssets: ir.resolvedResources.length }),
    registryCoverage: Object.freeze({
      declaredObjectTypes: 288,
      declaredPropertyKeys: 618,
      encounteredObjectTypeKeys: Object.freeze([...new Set(parsed.objects.map(object => object.source.typeKey))].sort((a, b) => a - b)),
      encounteredPropertyKeys: Object.freeze([...new Set(parsed.objects.flatMap(object => object.properties.map(property => property.source.key)))].sort((a, b) => a - b)),
      notSerializedRegistryPropertyKeys: Object.freeze(FROZEN_PROPERTIES.filter(property => !property.serialized).map(property => property.key).sort((a, b) => a - b)),
      unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0,
    }),
    toc: parsed.toc,
    objects: Object.freeze(parsed.objects.map(object => object.visit)),
    runtimeNullObjects: parsed.runtimeNullObjects,
    evaluator,
    diagnostics: Object.freeze([] as []),
  });
}

async function resolveAssets(
  parsed: ParsedRiv,
  options: ImportFrozenRivOptions,
  limits: RiveImportLimits,
  signal: AbortSignal,
  context: RiveImportDiagnosticContext,
): Promise<ResolvedAssetSet> {
  const candidates: AssetCandidate[] = [];
  let active: AssetCandidate | undefined;
  for (const object of parsed.objects) {
    if (object.source.lineage.includes('FileAsset')) {
      const assetId = numberProperty(object, 'assetId') ?? 0;
      const cdnUuid = bytesProperty(object, 'cdnUuid');
      active = {
        object,
        request: Object.freeze({
          assetId,
          name: stringProperty(object, 'name') ?? '',
          cdnUuidBase64: cdnUuid?.neutral.value.type === 'bytes'
            ? cdnUuid.neutral.value.base64
            : '',
          cdnBaseUrl: stringProperty(object, 'cdnBaseUrl') ?? 'https://public.rive.app/cdn/uuid',
          sourceObjectIndex: object.sourceObjectIndex,
        }),
      };
      candidates.push(active);
    } else if (object.source.name === 'FileAssetContents' && active) {
      const embedded = bytesProperty(object, 'bytes')?.rawBytes;
      if (embedded) active.embedded = embedded;
    }
  }
  assertLimit(candidates.filter(candidate => !candidate.embedded).length, limits.externalAssets, 'externalAssets', '$.riv.assets', context);
  // Match BackboardImporter::addFileAsset's EDITOR BUG 4204 recovery: retain
  // the first serialized id and deterministically assign later collisions the
  // next unused id in file order.
  const ids = new Set<number>();
  let nextAssetId = 1;
  for (const candidate of candidates) {
    let assetId = candidate.request.assetId;
    if (ids.has(assetId)) {
      while (ids.has(nextAssetId)) nextAssetId++;
      assetId = nextAssetId++;
      candidate.request = Object.freeze({ ...candidate.request, assetId });
    } else if (assetId >= nextAssetId) {
      nextAssetId = assetId + 1;
    }
    ids.add(assetId);
  }
  const manifest = manifestMap(options.assetManifest ?? [], context);
  const allowedHostedOrigins = Object.freeze([...(options.allowedHostedOrigins ?? [])]);
  const resolveAsset = options.assetResolver
    ? options.assetResolver.resolve.bind(options.assetResolver)
    : undefined;
  const concurrency = normalizeConcurrency(options.concurrency, context);
  const settled: Array<PromiseSettledResult<ResolvedAssetValue> | undefined> = new Array(candidates.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= candidates.length || signal.aborted) return;
      try {
        settled[index] = { status: 'fulfilled', value: await resolveOneAsset(candidates[index]!, manifest.get(candidates[index]!.request.assetId), allowedHostedOrigins, resolveAsset, limits, signal, context) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const firstFailure = settled.find(result => result?.status === 'rejected') as PromiseRejectedResult | undefined;
  if (firstFailure) throw firstFailure.reason;
  const values = settled.map(result => (result as PromiseFulfilledResult<ResolvedAssetValue>).value);
  const resources = values.map(value => value.resource)
    .sort((a, b) => a.objectId.localeCompare(b.objectId));
  const total = resources.reduce((sum, resource) => sum + resource.byteLength, 0);
  assertLimit(total, limits.totalResolvedAssetBytes, 'totalResolvedAssetBytes', '$.riv.assets', context);
  assertLimit(parsed.estimatedWorkingSetBytes + total * 2, limits.decodedWorkingSetBytes, 'decodedWorkingSetBytes', '$.riv.assets', context);
  const evaluatorAssets = values.map(value => value.evaluatorAsset).sort((a, b) => a.assetId - b.assetId);
  return Object.freeze({ resources: Object.freeze(resources), evaluatorAssets: Object.freeze(evaluatorAssets) });
}

async function resolveOneAsset(
  candidate: AssetCandidate,
  manifest: RiveExternalAssetManifestEntry | undefined,
  allowedHostedOrigins: readonly string[],
  resolveAsset: ((request: RiveAssetRequest, signal: AbortSignal) => Promise<RiveResolvedAsset | undefined>) | undefined,
  limits: RiveImportLimits,
  signal: AbortSignal,
  context: RiveImportDiagnosticContext,
): Promise<ResolvedAssetValue> {
  let resolved: RiveResolvedAsset;
  if (candidate.embedded) {
    resolved = Object.freeze({ bytes: candidate.embedded, mimeType: manifest?.mimeType ?? 'application/octet-stream' });
  } else {
    if (!manifest) throw assetError('E_RIVE_ASSET_LICENSE', 'External asset has no immutable manifest and rights record.', candidate.request, context);
    if (!manifest.licenseId || !manifest.allowedUse || !manifest.revision) {
      throw assetError('E_RIVE_ASSET_LICENSE', 'External asset rights record is incomplete.', candidate.request, context);
    }
    validateHostedUrl(candidate.request.cdnBaseUrl, allowedHostedOrigins, candidate.request, context);
    if (!resolveAsset) throw assetError('E_RIVE_ASSET_MISSING', 'External asset resolver is not configured.', candidate.request, context);
    const value = await resolveAsset(candidate.request, signal);
    if (!value) throw assetError('E_RIVE_ASSET_MISSING', 'External asset could not be resolved.', candidate.request, context);
    if (value.finalUrl) validateHostedUrl(value.finalUrl, allowedHostedOrigins, candidate.request, context);
    resolved = Object.freeze({
      bytes: Uint8Array.from(value.bytes),
      mimeType: value.mimeType,
      ...(value.finalUrl === undefined ? {} : { finalUrl: value.finalUrl }),
    });
  }
  assertLimit(resolved.bytes.byteLength, limits.oneAssetBytes, 'oneAssetBytes', `$.riv.assets[id=${candidate.request.assetId}].contents`, context);
  const digest = await sha256(resolved.bytes);
  if (manifest && (manifest.sha256.toLowerCase() !== digest || manifest.byteLength !== resolved.bytes.byteLength || manifest.mimeType !== resolved.mimeType)) {
    throw assetError('E_RIVE_ASSET_INTEGRITY', 'Asset bytes, size, or MIME do not match the immutable manifest.', candidate.request, context);
  }
  const resource = Object.freeze({
    objectId: candidate.object.neutralObjectId,
    contentSha256: digest,
    byteLength: resolved.bytes.byteLength,
    mimeType: resolved.mimeType,
    revision: manifest?.revision ?? `embedded:${digest}`,
  });
  return Object.freeze({
    resource,
    evaluatorAsset: Object.freeze({ assetId: candidate.request.assetId, bytes: Uint8Array.from(resolved.bytes), mimeType: resolved.mimeType }),
  });
}

async function evaluateIfRequested(
  evaluator: FrozenRiveEvaluator | undefined,
  bytes: Uint8Array,
  assets: readonly Readonly<{ assetId: number; bytes: Uint8Array; mimeType: string }>[],
  limits: RiveImportLimits,
  signal: AbortSignal,
  context: RiveImportDiagnosticContext,
): Promise<Readonly<{ used: boolean; adapterId?: string; evidenceSha256?: string }>> {
  if (!evaluator) return Object.freeze({ used: false });
  const descriptor = evaluator.descriptor;
  const adapterId = descriptor.adapterId;
  const flags = Object.keys(EXPECTED_EVALUATOR_FLAGS);
  if (
    descriptor.adapterId.length === 0 ||
    descriptor.package !== '@rive-app/webgl2' || descriptor.version !== '2.40.0' ||
    descriptor.riveJsSha256 !== 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714' ||
    descriptor.riveWasmSha256 !== '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32' ||
    descriptor.enforcesDecodedBudgets !== true ||
    Object.keys(descriptor.buildFlags).length !== flags.length || flags.some(flag => descriptor.buildFlags[flag] !== true)
  ) {
    throw new RiveImportError('E_RIVE_ORACLE_MISMATCH', 'Official evaluator descriptor does not match the accepted compatibility tuple.', '$.riv.evaluator', context);
  }
  const evaluatorAssets = assets.map(asset => Object.freeze({ ...asset, bytes: Uint8Array.from(asset.bytes) }));
  const evaluated = await evaluator.evaluate(Uint8Array.from(bytes), Object.freeze(evaluatorAssets), limits, signal);
  const evidenceSha256 = await sha256(new TextEncoder().encode(stableStringify(evaluated.evidence)));
  return Object.freeze({ used: true, adapterId, evidenceSha256 });
}

function normalizeConcurrency(value: number | undefined, context: RiveImportDiagnosticContext): number {
  const concurrency = value ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', 'Asset concurrency must be an integer from 1 through 64.', '$.options.concurrency', { ...context, observed: concurrency, limit: 64, budget: 'assetConcurrency' });
  }
  return concurrency;
}

function normalizeLimits(overrides: Partial<RiveImportLimits> | undefined, context: RiveImportDiagnosticContext): RiveImportLimits {
  const merged = { ...RIVE_IMPORT_HARD_LIMITS };
  if (overrides) {
    for (const key of Object.keys(overrides) as Array<keyof RiveImportLimits>) {
      const value = overrides[key];
      if (value === undefined) continue;
      const hard = RIVE_IMPORT_HARD_LIMITS[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > hard) {
        throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', `Configured ${key} is outside the approved hard ceiling.`, `$.options.limits.${key}`, { ...context, observed: value, limit: hard, budget: key });
      }
      merged[key] = value;
    }
  }
  return Object.freeze(merged);
}

function createOperationSignal(owner: AbortSignal | undefined, timeoutMs: number, context: RiveImportDiagnosticContext): Readonly<{
  signal: AbortSignal;
  assertActive(cause?: unknown): void;
  dispose(): void;
}> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(owner?.reason);
  owner?.addEventListener('abort', onAbort, { once: true });
  if (owner?.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    assertActive(cause?: unknown): void {
      if (!controller.signal.aborted) return;
      if (timedOut) throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', 'Rive import exceeded importWallMs.', '$.riv', { ...context, observed: timeoutMs, limit: timeoutMs, budget: 'importWallMs' }, { cause });
      throw new RiveImportError('E_RIVE_ABORTED', 'Rive import was aborted by its owner.', '$.riv', context, { cause });
    },
    dispose(): void { clearTimeout(timer); owner?.removeEventListener('abort', onAbort); },
  });
}

function manifestMap(entries: readonly RiveExternalAssetManifestEntry[], context: RiveImportDiagnosticContext): ReadonlyMap<number, RiveExternalAssetManifestEntry> {
  const map = new Map<number, RiveExternalAssetManifestEntry>();
  for (const entry of entries) {
    if (map.has(entry.assetId)) throw new RiveImportError('E_RIVE_REFERENCE_INVALID', 'Asset manifest contains a duplicate id.', `$.options.assetManifest[id=${entry.assetId}]`, context);
    map.set(entry.assetId, Object.freeze({ ...entry }));
  }
  return map;
}

function validateHostedUrl(value: string, allowedOrigins: readonly string[], request: RiveAssetRequest, context: RiveImportDiagnosticContext): void {
  let url: URL;
  try { url = new URL(value); } catch (cause) {
    throw assetError('E_RIVE_ASSET_URL_POLICY', 'Hosted asset URL is invalid.', request, context, cause);
  }
  if (url.protocol !== 'https:' || !allowedOrigins.includes(url.origin)) {
    throw assetError('E_RIVE_ASSET_URL_POLICY', 'Hosted asset origin is not explicitly allowed.', request, context);
  }
}

function assetError(code: 'E_RIVE_ASSET_MISSING' | 'E_RIVE_ASSET_INTEGRITY' | 'E_RIVE_ASSET_LICENSE' | 'E_RIVE_ASSET_URL_POLICY' | 'E_RIVE_REFERENCE_INVALID', message: string, request: RiveAssetRequest, context: RiveImportDiagnosticContext, cause?: unknown): RiveImportError {
  return new RiveImportError(code, message, `$.riv.assets[id=${request.assetId}].contents`, context, cause === undefined ? undefined : { cause });
}

function numberProperty(object: ParsedObject, name: string): number | undefined {
  return [...object.properties].reverse().find(property => property.source.name === name)?.numberValue;
}
function stringProperty(object: ParsedObject, name: string): string | undefined {
  return [...object.properties].reverse().find(property => property.source.name === name)?.stringValue;
}
function bytesProperty(object: ParsedObject, name: string) {
  return [...object.properties].reverse().find(property => property.source.name === name);
}

function neutralFamily(family: string): NeutralImportedObject['family'] {
  switch (family) {
    case 'import-neutral-ir': return 'structure';
    case 'vector-paint-composite': return 'vector-graphics';
    case 'rig-mesh-constraint': return 'deformation';
    case 'text-layout-component-asset': return 'layout-text-resource';
    case 'timeline-state-machine': return 'animation-graph';
    case 'data-interaction-accessibility': return 'data-interaction-semantics';
    case 'audio-event': return 'audio-event';
    case 'scripting-custom-rendering': return 'sandbox-program';
    default: throw new Error(`Unclassified frozen family: ${family}`);
  }
}

function assertLimit(observed: number, limit: number, budget: string, path: string, context: RiveImportDiagnosticContext): void {
  if (observed > limit) throw new RiveImportError('E_RIVE_LIMIT_EXCEEDED', `Rive import exceeded ${budget}.`, path, { ...context, observed, limit, budget });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Only finite numbers can be serialized.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported deterministic value: ${typeof value}`);
}

export const FROZEN_RIVE_REGISTRY_COUNTS = Object.freeze({
  objects: FROZEN_OBJECTS.length,
  properties: FROZEN_PROPERTIES.length,
});
