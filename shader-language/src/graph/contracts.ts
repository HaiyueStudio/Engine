import type { ShaderCapabilityProfile, ShaderColorSpace } from '../contracts';

export const SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS = Object.freeze([
  'format',
  'version',
  'kind',
  'profile',
  'resources',
  'nodes',
  'outputs',
] as const);

export const SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS = Object.freeze([
  'sceneFeatures',
  'metadata',
] as const);

export const SHADER_GRAPH_V1_ROOT_FIELDS = Object.freeze([
  ...SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS,
  ...SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS,
] as const);

/** Fields from the target material architecture that are not Graph v1 root fields. */
export const SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS = Object.freeze({
  surface: Object.freeze({
    currentOwner: 'outputs',
    guidance: 'Author MaterialSurface slots directly through the outputs map.',
  }),
  lightingModel: Object.freeze({
    currentOwner: 'compiler-entrypoint',
    guidance: 'compileMaterialGraphV1 selects metallic-roughness; Graph v1 does not select a lighting model.',
  }),
  coverage: Object.freeze({
    currentOwner: 'renderer-material-descriptor',
    guidance: 'Alpha mode, cutoff, sidedness, and pass coverage remain renderer material state.',
  }),
  vertexDisplacement: Object.freeze({
    currentOwner: 'deformation-program-v1',
    guidance: 'Use the deformation pass-family contract; Graph v1 does not own vertex displacement.',
  }),
  passRequirements: Object.freeze({
    currentOwner: 'compiler-reflection-and-render-graph',
    guidance: 'Pass requirements are compiler/reflection output and cannot be authored on a Graph v1 root.',
  }),
} as const);

export type ShaderGraphKind = 'material' | 'postprocess' | 'compute';
export type ShaderGraphResourceKind =
  | 'uniform'
  | 'texture-2d'
  | 'texture-cube'
  | 'sampler'
  | 'storage-read'
  | 'storage-read-write';
export type ShaderGraphResourceFrequency = 'material' | 'draw' | 'frame' | 'pass';

export interface ShaderGraphResourceV1 {
  readonly id: string;
  readonly space: 'material' | 'pass';
  readonly kind: ShaderGraphResourceKind;
  readonly valueType: string;
  readonly frequency: ShaderGraphResourceFrequency;
  readonly colorSpace?: ShaderColorSpace;
}

export interface ShaderGraphLiteralValueV1 {
  readonly kind: 'literal';
  readonly type: string;
  readonly value: boolean | number | readonly number[];
  readonly space?: string;
  readonly colorSpace?: ShaderColorSpace;
}

export interface ShaderGraphNodeValueV1 {
  readonly kind: 'node';
  readonly node: string;
  readonly output: string;
}

export interface ShaderGraphSemanticValueV1 {
  readonly kind: 'semantic';
  readonly semantic: string;
}

export interface ShaderGraphResourceValueV1 {
  readonly kind: 'resource';
  readonly resource: string;
}

export type ShaderGraphValueV1 =
  | ShaderGraphLiteralValueV1
  | ShaderGraphNodeValueV1
  | ShaderGraphSemanticValueV1
  | ShaderGraphResourceValueV1;

export interface ShaderGraphNodeV1 {
  readonly id: string;
  readonly type: string;
  readonly typeVersion: number;
  readonly inputs: Readonly<Record<string, ShaderGraphValueV1>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ShaderGraphSourceLocation {
  readonly line: number;
  readonly column: number;
}

export interface ShaderGraphV1 {
  readonly format: 'haiyue-shader-graph';
  readonly version: 1;
  readonly kind: ShaderGraphKind;
  readonly profile: ShaderCapabilityProfile;
  readonly resources: readonly ShaderGraphResourceV1[];
  readonly nodes: readonly ShaderGraphNodeV1[];
  readonly outputs: Readonly<Record<string, ShaderGraphValueV1>>;
  readonly sceneFeatures: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceName: string;
  readonly nodeLocations: Readonly<Record<string, ShaderGraphSourceLocation>>;
}

export interface ParseShaderGraphV1Options {
  readonly sourceName?: string;
}
