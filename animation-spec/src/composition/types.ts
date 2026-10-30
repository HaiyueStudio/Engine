import type {AnimationExtensionRegistry} from '../extensions.js';

export const HYA_COMPOSITION_FORMAT = 'haiyue-composition' as const;
export const HYA_COMPOSITION_VERSION = 1 as const;

export type HyaCompositionValue = null | boolean | number | string | readonly HyaCompositionValue[] | {readonly [key: string]: HyaCompositionValue};
export interface HyaCompositionPart {
  readonly id: string;
  readonly extension: string;
  readonly required: boolean;
  readonly requires: readonly string[];
  readonly dependencies: readonly string[];
  readonly document: HyaCompositionValue;
}
export interface HyaCompositionTarget {
  readonly id: string;
  readonly part: string;
  readonly kind: 'animation-node' | 'layout-node' | 'text-block' | 'asset' | 'state-input' | 'interaction-target' | 'semantic-node' | 'audio-cue';
  readonly address: readonly string[];
}
export interface HyaCompositionDocument {
  readonly format: typeof HYA_COMPOSITION_FORMAT;
  readonly version: typeof HYA_COMPOSITION_VERSION;
  readonly parts: readonly HyaCompositionPart[];
  readonly targets: readonly HyaCompositionTarget[];
}
export interface HyaCompositionLimits {
  readonly maxInputBytes: number;
  readonly maxJsonNodes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxParts: number;
  readonly maxTargets: number;
  readonly maxRequirementsPerPart: number;
}
export type HyaCompositionPartValidator = (document: HyaCompositionValue) => void;
export interface HyaCompositionParseOptions {
  /** Strict is the default; only explicitly optional parts may be skipped otherwise. */
  readonly strict?: boolean;
  readonly limits?: Partial<HyaCompositionLimits>;
  /** Trusted application registrations; never deserialized from the document. */
  readonly validators?: ReadonlyMap<string, HyaCompositionPartValidator>;
  /** Reuse the existing core required-extension registry without replacing its parser. */
  readonly coreExtensions?: AnimationExtensionRegistry;
}
export interface HyaCompositionDiagnostic {
  readonly code: 'W_HYA_COMPOSITION_OPTIONAL_SKIPPED';
  readonly path: string;
  readonly capability: string;
  readonly part: string;
}
export interface HyaCompositionParseResult {
  readonly document: HyaCompositionDocument;
  readonly diagnostics: readonly HyaCompositionDiagnostic[];
}
export interface HyaCompositionPlan {
  readonly document: HyaCompositionDocument;
  readonly activeParts: readonly string[];
  readonly targets: readonly HyaCompositionTarget[];
  readonly diagnostics: readonly HyaCompositionDiagnostic[];
  readonly complete: boolean;
}
export type HyaCompositionErrorCode =
  | 'E_HYA_COMPOSITION_FORMAT' | 'E_HYA_COMPOSITION_VERSION' | 'E_HYA_COMPOSITION_LIMIT'
  | 'E_HYA_COMPOSITION_REQUIRED' | 'E_HYA_COMPOSITION_OPTIONAL' | 'E_HYA_COMPOSITION_CAPABILITY'
  | 'E_HYA_COMPOSITION_REFERENCE' | 'E_HYA_COMPOSITION_GRAPH' | 'E_HYA_COMPOSITION_PART';

export const DEFAULT_HYA_COMPOSITION_LIMITS: HyaCompositionLimits = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024, maxJsonNodes: 1_000_000, maxDepth: 128,
  maxStringBytes: 4 * 1024 * 1024, maxParts: 16, maxTargets: 100_000, maxRequirementsPerPart: 64,
});
