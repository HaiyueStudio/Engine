import type { FROZEN_REGISTRY_IDENTITY, FrozenWireKind } from './generated/frozen-registry.js';

export type RiveImportDiagnosticCode =
  | 'E_RIVE_INVALID_FINGERPRINT'
  | 'E_RIVE_FORMAT_MAJOR_UNSUPPORTED'
  | 'E_RIVE_FORMAT_MINOR_UNSUPPORTED'
  | 'E_RIVE_TRUNCATED'
  | 'E_RIVE_VARINT_OVERFLOW'
  | 'E_RIVE_TOC_INVALID'
  | 'E_RIVE_LIMIT_EXCEEDED'
  | 'E_RIVE_UNKNOWN_OBJECT'
  | 'E_RIVE_UNKNOWN_PROPERTY'
  | 'E_RIVE_UNSUPPORTED_PROPERTY'
  | 'E_RIVE_REFERENCE_INVALID'
  | 'E_RIVE_REFERENCE_CYCLE'
  | 'E_RIVE_ASSET_MISSING'
  | 'E_RIVE_ASSET_INTEGRITY'
  | 'E_RIVE_ASSET_LICENSE'
  | 'E_RIVE_ASSET_URL_POLICY'
  | 'E_RIVE_ORACLE_MISMATCH'
  | 'E_RIVE_ABORTED'
  | 'E_RIVE_INTERNAL';

export interface RiveImportDiagnosticContext {
  readonly tupleId: string;
  readonly inputSha256: string;
  readonly formatMajor?: number;
  readonly formatMinor?: number;
  readonly objectKey?: number;
  readonly propertyKey?: number;
  readonly profile: 'full-fidelity';
  readonly goal: 'g02-riv-import-neutral-ir';
  readonly observed?: number;
  readonly limit?: number;
  readonly budget?: string;
}

export type NeutralValue =
  | Readonly<{ type: 'unsigned-integer'; value: number }>
  | Readonly<{ type: 'signed-integer'; value: number }>
  | Readonly<{ type: 'boolean'; value: boolean }>
  | Readonly<{ type: 'string'; value: string }>
  | Readonly<{ type: 'bytes'; base64: string; byteLength: number }>
  | Readonly<{ type: 'number'; value: number }>
  | Readonly<{ type: 'color'; rgba: readonly [number, number, number, number] }>;

export interface NeutralProperty {
  readonly id: string;
  readonly value: NeutralValue;
}

export interface NeutralImportedObject {
  readonly id: string;
  readonly family:
    | 'structure'
    | 'vector-graphics'
    | 'deformation'
    | 'layout-text-resource'
    | 'animation-graph'
    | 'data-interaction-semantics'
    | 'audio-event'
    | 'sandbox-program';
  readonly properties: readonly NeutralProperty[];
}

export interface NeutralResolvedResource {
  readonly objectId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly revision: string;
}

export interface NeutralAnimationIR {
  readonly schema: 'NeutralAnimationIR';
  readonly version: 1;
  readonly coordinateSystem: 'screen-y-down';
  readonly units: 'css-pixel-like';
  readonly colorSpace: 'unpremultiplied-srgb';
  readonly objects: readonly NeutralImportedObject[];
  readonly artboards: readonly string[];
  readonly instances: readonly string[];
  readonly nodes: readonly string[];
  readonly drawables: readonly string[];
  readonly resources: readonly string[];
  readonly geometry: readonly string[];
  readonly paints: readonly string[];
  readonly rigs: readonly string[];
  readonly constraints: readonly string[];
  readonly layouts: readonly string[];
  readonly text: readonly string[];
  readonly timelines: readonly string[];
  readonly stateMachines: readonly string[];
  readonly dataModels: readonly string[];
  readonly interactions: readonly string[];
  readonly events: readonly string[];
  readonly audioSchedules: readonly string[];
  readonly semantics: readonly string[];
  readonly sandboxPrograms: readonly string[];
  readonly resolvedResources: readonly NeutralResolvedResource[];
}

export type RiveFieldVisitStatus = 'consumed' | 'explicit-default' | 'not-serialized';

export interface RivePropertyVisit {
  readonly sourcePropertyKey: number;
  readonly sourceName: string;
  readonly sourceOwner: string;
  readonly wireKind: FrozenWireKind;
  readonly status: RiveFieldVisitStatus;
  readonly neutralFieldIds: readonly string[];
}

export interface RiveObjectVisit {
  readonly neutralObjectId: string;
  readonly sourceObjectIndex: number;
  readonly sourceTypeKey: number;
  readonly sourceName: string;
  readonly sourceFamily: string;
  readonly properties: readonly RivePropertyVisit[];
}

export interface RiveImportReport {
  readonly schema: 'haiyue-rive-neutral-import-report';
  readonly version: 1;
  readonly compatibility: typeof FROZEN_REGISTRY_IDENTITY;
  readonly input: Readonly<{
    sha256: string;
    byteLength: number;
    fingerprint: 'RIVE';
    major: 7;
    minor: 3;
    fileId: number;
  }>;
  readonly counts: Readonly<{
    objects: number;
    propertyAssignments: number;
    strings: number;
    textBytes: number;
    embeddedBytes: number;
    listItems: number;
    resolvedAssets: number;
  }>;
  readonly registryCoverage: Readonly<{
    declaredObjectTypes: 288;
    declaredPropertyKeys: 611;
    encounteredObjectTypeKeys: readonly number[];
    encounteredPropertyKeys: readonly number[];
    notSerializedRegistryPropertyKeys: readonly number[];
    unclassifiedObjects: 0;
    unclassifiedProperties: 0;
    unclassifiedAssets: 0;
    unclassifiedScripts: 0;
  }>;
  readonly toc: readonly Readonly<{ sourcePropertyKey: number; fieldType: 0 | 1 | 2 | 3; status: 'consumed-type-declaration' }>[];
  readonly objects: readonly RiveObjectVisit[];
  readonly evaluator: Readonly<{ used: boolean; adapterId?: string; evidenceSha256?: string }>;
  readonly diagnostics: readonly [];
}

export interface RiveNeutralImportResult {
  readonly ir: NeutralAnimationIR;
  readonly report: RiveImportReport;
  readonly irBytes: Uint8Array;
  readonly reportBytes: Uint8Array;
}

export interface RiveImportLimits {
  readonly rivBytes: number;
  readonly decodedWorkingSetBytes: number;
  readonly objects: number;
  readonly propertyAssignments: number;
  readonly referenceDepth: number;
  readonly artboardInstances: number;
  readonly listItems: number;
  readonly eventRecursion: number;
  readonly stringBytes: number;
  readonly totalTextBytes: number;
  readonly externalAssets: number;
  readonly oneAssetBytes: number;
  readonly totalResolvedAssetBytes: number;
  readonly imageDimension: number;
  readonly decodedPixels: number;
  readonly vertices: number;
  readonly keyframes: number;
  readonly drawItems: number;
  readonly importWallMs: number;
}

export interface RiveExternalAssetManifestEntry {
  readonly assetId: number;
  readonly revision: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly licenseId: string;
  readonly allowedUse: string;
}

export interface RiveAssetRequest {
  readonly assetId: number;
  readonly name: string;
  readonly cdnUuidBase64: string;
  readonly cdnBaseUrl: string;
  readonly sourceObjectIndex: number;
}

export interface RiveResolvedAsset {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly finalUrl?: string;
}

export interface RiveAssetResolver {
  resolve(request: RiveAssetRequest, signal: AbortSignal): Promise<RiveResolvedAsset | undefined>;
}

export interface FrozenRiveEvaluatorDescriptor {
  readonly adapterId: string;
  readonly package: '@rive-app/webgl2';
  readonly version: '2.40.0';
  readonly riveJsSha256: 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714';
  readonly riveWasmSha256: '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32';
  readonly enforcesDecodedBudgets: true;
  readonly buildFlags: Readonly<Record<string, boolean>>;
}

export interface FrozenRiveEvaluator {
  readonly descriptor: FrozenRiveEvaluatorDescriptor;
  evaluate(
    bytes: Uint8Array,
    assets: readonly Readonly<{ assetId: number; bytes: Uint8Array; mimeType: string }>[],
    limits: RiveImportLimits,
    signal: AbortSignal,
  ): Promise<Readonly<{ evidence: unknown }>>;
}

export interface ImportFrozenRivOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<RiveImportLimits>;
  readonly assetResolver?: RiveAssetResolver;
  readonly assetManifest?: readonly RiveExternalAssetManifestEntry[];
  readonly allowedHostedOrigins?: readonly string[];
  readonly evaluator?: FrozenRiveEvaluator;
  readonly concurrency?: number;
}

export const RIVE_IMPORT_HARD_LIMITS: RiveImportLimits = Object.freeze({
  rivBytes: 64 * 1024 * 1024,
  decodedWorkingSetBytes: 512 * 1024 * 1024,
  objects: 250_000,
  propertyAssignments: 4_000_000,
  referenceDepth: 128,
  artboardInstances: 8_192,
  listItems: 100_000,
  eventRecursion: 64,
  stringBytes: 4 * 1024 * 1024,
  totalTextBytes: 32 * 1024 * 1024,
  externalAssets: 4_096,
  oneAssetBytes: 256 * 1024 * 1024,
  totalResolvedAssetBytes: 1024 * 1024 * 1024,
  imageDimension: 16_384,
  decodedPixels: 268_435_456,
  vertices: 5_000_000,
  keyframes: 10_000_000,
  drawItems: 1_000_000,
  importWallMs: 60_000,
});
