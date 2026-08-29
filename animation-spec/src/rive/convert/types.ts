import type { ImportFrozenRivOptions, RiveNeutralImportResult } from '../import/types.js';
import type { AnimationDocument, AnimationTrackProperty } from '../../types.js';

export const RIVE_HYA_PACKAGE_FORMAT = 'haiyue-rive-hya-package' as const;
export const RIVE_HYA_PACKAGE_VERSION = 1 as const;
export const RIVE_CAPABILITY_EVALUATION_FORMAT = 'haiyue-rive-neutral-capability-evaluation' as const;
export const RIVE_CAPABILITY_EVALUATION_VERSION = 1 as const;

export type RiveConversionMode = 'normal' | 'strict';
export type RiveRepresentation = 'native-semantic' | 'visual-baked';
export type RiveNeutralCapability =
  | 'vector-visual'
  | 'deformable-rig'
  | 'responsive-layout'
  | 'state-machine'
  | 'data-binding'
  | 'interaction'
  | 'semantics'
  | 'audio-events'
  | 'sandbox-script';

export interface RiveConversionTuple {
  readonly adapterId: string;
  readonly adapterRevisionSha256: string;
  readonly evaluatorId: string;
  readonly evaluatorRevisionSha256: string;
  readonly optionsRevision: string;
}

export interface RiveCapabilityArtifact {
  readonly id: string;
  readonly capability: RiveNeutralCapability;
  readonly representation: RiveRepresentation;
  /** A complete document accepted by the capability's frozen G03-G09 parser. */
  readonly document: unknown;
}

export interface RiveCoverageEntry {
  readonly objectId: string;
  readonly propertyIds: readonly string[];
  readonly capability: RiveNeutralCapability | 'hya-core';
  readonly representation: RiveRepresentation;
  readonly artifactId?: string;
}

/** Observable behavior that makes a feature mechanically ineligible for visual baking. */
export interface RiveBakingObservables {
  readonly input: boolean;
  readonly data: boolean;
  readonly layoutResize: boolean;
  readonly event: boolean;
  readonly audio: boolean;
  readonly semantics: boolean;
  readonly script: boolean;
  readonly resourceReplacement: boolean;
  readonly stateExposure: boolean;
}

export interface RiveBakedTrackPlan {
  readonly id: string;
  readonly node: string;
  readonly property: AnimationTrackProperty;
  readonly duration: number;
  readonly tolerance: number;
  readonly valueQuantum: number;
  readonly timeQuantum: number;
  readonly maxDepth: number;
  readonly deterministicVisual: true;
  readonly observables: RiveBakingObservables;
}

export interface RiveEmbeddedAsset {
  readonly id: string;
  readonly neutralResourceObjectId: string;
  readonly kind: 'embedded';
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly revision: string;
  readonly licenseId: string;
}

export interface RiveExternalAsset {
  readonly id: string;
  readonly neutralResourceObjectId: string;
  readonly kind: 'external';
  readonly mimeType: string;
  readonly uri: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly revision: string;
  readonly licenseId: string;
}

export type RiveConverterAsset = RiveEmbeddedAsset | RiveExternalAsset;

export interface RiveFeatureLedgerEntry {
  readonly feature: string;
  readonly capability: RiveNeutralCapability | 'hya-core';
  readonly representation: RiveRepresentation;
  readonly count: number;
  readonly artifactId?: string;
}

/**
 * Build-time evaluator output. This boundary is deliberately source-neutral:
 * Rive type/property ids and runtime SDK objects are forbidden here.
 */
export interface RiveNeutralCapabilityEvaluation {
  readonly format: typeof RIVE_CAPABILITY_EVALUATION_FORMAT;
  readonly version: typeof RIVE_CAPABILITY_EVALUATION_VERSION;
  readonly inputIrSha256: string;
  readonly tuple: RiveConversionTuple;
  readonly baseDocument: AnimationDocument;
  readonly artifacts: readonly RiveCapabilityArtifact[];
  readonly coverage: readonly RiveCoverageEntry[];
  readonly bakedTracks: readonly RiveBakedTrackPlan[];
  readonly assets: readonly RiveConverterAsset[];
  readonly featureLedger: readonly RiveFeatureLedgerEntry[];
  readonly classification: Readonly<{
    unclassifiedObjects: 0;
    unclassifiedProperties: 0;
    unclassifiedAssets: 0;
    unclassifiedScripts: 0;
  }>;
}

export interface RiveSampleRequest { readonly trackId: string; readonly time: number; }
export interface RiveSampleResult extends RiveSampleRequest { readonly value: readonly number[]; }
export interface RiveExtremaRequest { readonly trackId: string; readonly start: number; readonly end: number; }
export interface RiveExtremaResult extends RiveExtremaRequest { readonly times: readonly number[]; }
export interface RiveVisualEvaluator {
  sample(requests: readonly RiveSampleRequest[], signal: AbortSignal): Promise<readonly RiveSampleResult[]>;
  /** Returns every analytic/numeric extremum in each open interval. */
  extrema(requests: readonly RiveExtremaRequest[], signal: AbortSignal): Promise<readonly RiveExtremaResult[]>;
}

export interface RiveConversionProgress {
  readonly phase: 'adapting' | 'sampling' | 'compiling' | 'packaging' | 'complete';
  readonly completed: number;
  readonly total: number;
}

export interface RiveConversionLimits {
  readonly maxArtifacts: number;
  readonly maxAssets: number;
  readonly maxEmbeddedAssetBytes: number;
  readonly maxTotalEmbeddedAssetBytes: number;
  readonly maxBakedTracks: number;
  readonly maxSamplesPerTrack: number;
  readonly maxPackageFiles: number;
  readonly maxPackageBytes: number;
}

export const RIVE_CONVERSION_HARD_LIMITS: RiveConversionLimits = Object.freeze({
  maxArtifacts: 64,
  maxAssets: 4_096,
  maxEmbeddedAssetBytes: 256 * 1024 * 1024,
  maxTotalEmbeddedAssetBytes: 1024 * 1024 * 1024,
  maxBakedTracks: 100_000,
  maxSamplesPerTrack: 1_048_577,
  maxPackageFiles: 8_192,
  maxPackageBytes: 2 * 1024 * 1024 * 1024,
});

export interface ConvertRiveToHyaOptions {
  readonly mode?: RiveConversionMode;
  readonly signal?: AbortSignal;
  readonly evaluator?: RiveVisualEvaluator;
  /** Exact HTTPS origins approved for immutable external assets. Empty means no network assets. */
  readonly approvedExternalOrigins?: readonly string[];
  /** Optional atomic owner. Files remain staged until every validation and hash succeeds. */
  readonly sink?: RiveConversionSink;
  readonly limits?: Partial<RiveConversionLimits>;
  readonly onProgress?: (progress: RiveConversionProgress) => void;
}
export interface ConvertRiveToHyaInput {
  readonly imported: RiveNeutralImportResult;
  readonly evaluation: RiveNeutralCapabilityEvaluation;
}

export interface RiveCapabilityEvaluationRequest {
  /** Owned copy of the untrusted source bytes. Available only at the build-time adapter boundary. */
  readonly rivBytes: Uint8Array;
  readonly imported: RiveNeutralImportResult;
  readonly inputIrSha256: string;
  /** Optional composition selected by the importing product. It remains inside the build-time adapter boundary. */
  readonly selection?: Readonly<{ readonly artboard?: string; readonly animation?: string; readonly stateMachine?: string }>;
}

export interface RiveCapabilityEvaluator {
  readonly descriptor: RiveConversionTuple;
  evaluate(request: RiveCapabilityEvaluationRequest, signal: AbortSignal): Promise<RiveNeutralCapabilityEvaluation>;
}

export interface ConvertRivBytesToHyaOptions {
  readonly capabilityEvaluator: RiveCapabilityEvaluator;
  readonly selection?: RiveCapabilityEvaluationRequest['selection'];
  readonly signal?: AbortSignal;
  readonly importer?: Omit<ImportFrozenRivOptions, 'signal'>;
  readonly conversion?: Omit<ConvertRiveToHyaOptions, 'signal'>;
}

export interface RivePackageFileEntry { readonly path: string; readonly mediaType: string; readonly byteLength: number; readonly sha256: string; }
export interface RivePackageAssetEntry {
  readonly id: string; readonly kind: 'embedded' | 'external'; readonly mimeType: string; readonly sha256: string;
  readonly byteLength: number; readonly revision: string; readonly licenseId: string; readonly path?: string; readonly uri?: string;
}
export interface RiveHyaPackageManifest {
  readonly format: typeof RIVE_HYA_PACKAGE_FORMAT; readonly version: typeof RIVE_HYA_PACKAGE_VERSION; readonly hya: 'animation.hya';
  readonly tuple: RiveConversionTuple; readonly input: Readonly<{ rivSha256: string; neutralIrSha256: string }>;
  readonly files: readonly RivePackageFileEntry[]; readonly assets: readonly RivePackageAssetEntry[]; readonly featureLedger: readonly RiveFeatureLedgerEntry[];
}

export interface RiveConversionDiagnostic {
  readonly severity: 'warning' | 'error'; readonly code: RiveConversionDiagnosticCode; readonly message: string; readonly path: string;
  readonly source?: Readonly<{ objectIndex?: number; objectTypeKey?: number; propertyKey?: number }>;
}
export type RiveConversionDiagnosticCode =
  | 'E_RIVE_CONVERT_FORMAT' | 'E_RIVE_CONVERT_UNSUPPORTED' | 'E_RIVE_CONVERT_UNCLASSIFIED'
  | 'E_RIVE_CONVERT_ORACLE_REQUIRED' | 'E_RIVE_CONVERT_LIMIT' | 'E_RIVE_CONVERT_BAKING_INELIGIBLE'
  | 'E_RIVE_CONVERT_ASSET_MISSING' | 'E_RIVE_CONVERT_ASSET_INTEGRITY' | 'E_RIVE_CONVERT_ABORTED'
  | 'E_RIVE_CONVERT_ATOMIC_COMMIT' | 'E_RIVE_CONVERT_INTERNAL';

export interface RiveConversionReport {
  readonly schema: 'haiyue-rive-hya-conversion-report'; readonly version: 1; readonly mode: RiveConversionMode;
  readonly tuple: RiveConversionTuple; readonly input: Readonly<{ rivSha256: string; neutralIrSha256: string }>;
  readonly output: Readonly<{ packageSha256: string; byteLength: number; hyaSha256: string }>;
  readonly featureLedger: readonly RiveFeatureLedgerEntry[];
  readonly coverage: Readonly<{ objects: number; properties: number; uncoveredObjects: 0; uncoveredProperties: 0 }>;
  readonly classification: Readonly<{ unclassifiedObjects: 0; unclassifiedProperties: 0; unclassifiedAssets: 0; unclassifiedScripts: 0 }>;
  readonly diagnostics: readonly RiveConversionDiagnostic[];
}
export interface RiveConversionResult {
  readonly hyaBytes: Uint8Array; readonly packageBytes: Uint8Array; readonly manifest: RiveHyaPackageManifest;
  readonly manifestBytes: Uint8Array; readonly report: RiveConversionReport; readonly reportBytes: Uint8Array;
}
export interface RiveConversionSink {
  stage(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  commit(signal: AbortSignal): Promise<void>;
  abort(reason: unknown): Promise<void>;
}
