export const SHADER_STAGES = ['vertex', 'fragment', 'compute'] as const;
export type ShaderStage = typeof SHADER_STAGES[number];

export const SHADER_TARGETS = ['webgpu-wgsl', 'webgl2-glsl-es300'] as const;
export type ShaderTarget = typeof SHADER_TARGETS[number];

export const SHADER_CAPABILITY_PROFILES = [
  'webgpu-portable',
  'webgpu-enhanced',
  'webgl2-compatible',
] as const;
export type ShaderCapabilityProfile = typeof SHADER_CAPABILITY_PROFILES[number];

export const SHADER_RESOURCE_SPACES = ['frame', 'object', 'material', 'pass'] as const;
export type ShaderResourceSpace = typeof SHADER_RESOURCE_SPACES[number];

export const SHADER_COORDINATE_SPACES = [
  'geometry-local',
  'object',
  'world',
  'view',
  'tangent',
  'clip',
  'screen',
] as const;
export type ShaderCoordinateSpace = typeof SHADER_COORDINATE_SPACES[number];

export const SHADER_COLOR_SPACES = ['linear', 'srgb', 'data'] as const;
export type ShaderColorSpace = typeof SHADER_COLOR_SPACES[number];

export const SHADER_RESOURCE_GROUPS: Readonly<Record<ShaderResourceSpace, number>> = Object.freeze({
  frame: 0,
  object: 1,
  material: 2,
  pass: 3,
});

export type ShaderSymbolKind = 'function' | 'struct' | 'constant' | 'alias';
export type ShaderSymbolVisibility = 'export' | 'private';

export interface ShaderSymbolDefinition {
  readonly id: string;
  readonly kind: ShaderSymbolKind;
  readonly visibility: ShaderSymbolVisibility;
  readonly stages: readonly ShaderStage[];
}

export interface ShaderSymbolImportDefinition {
  readonly from: string;
  readonly symbol: string;
  readonly stages?: readonly ShaderStage[];
}

export interface ShaderSymbolImport {
  readonly from: string;
  readonly symbol: string;
  readonly stages: readonly ShaderStage[];
}

export type ShaderResourceKind =
  | 'uniform-buffer'
  | 'storage-buffer-read'
  | 'storage-buffer-read-write'
  | 'texture'
  | 'storage-texture'
  | 'sampler';

export interface ShaderUniformFieldDefinition {
  readonly id: string;
  readonly type: string;
  readonly semantic?: 'value' | 'position' | 'direction' | 'normal' | 'uv' | 'color' | 'transform';
  readonly coordinateSpace?: ShaderCoordinateSpace;
  readonly colorSpace?: Exclude<ShaderColorSpace, 'data'>;
  readonly fromSpace?: ShaderCoordinateSpace;
  readonly toSpace?: ShaderCoordinateSpace;
}

export interface ShaderResourceDefinition {
  readonly id: string;
  readonly space: ShaderResourceSpace;
  readonly kind: ShaderResourceKind;
  readonly visibility: readonly ShaderStage[];
  /** WGSL resource type. Omit only for a generated uniform block with fields. */
  readonly valueType?: string;
  readonly fields?: readonly ShaderUniformFieldDefinition[];
  /** Sample interpretation only; storage and uniform resources never infer color conversion. */
  readonly colorSpace?: ShaderColorSpace;
  /** Reserved for engine-known ABI resources. Extensions should use automatic allocation. */
  readonly fixedBinding?: number;
}

export type ShaderSpecializationType = 'bool' | 'i32' | 'u32' | 'f32';
export type ShaderSpecializationValue = boolean | number;

export interface ShaderSpecializationDefinition {
  readonly id: string;
  readonly type: ShaderSpecializationType;
  readonly defaultValue: ShaderSpecializationValue;
}

export interface ShaderEntryPointDefinition {
  readonly id: string;
  readonly stage: ShaderStage;
  readonly name: string;
}

export interface ShaderSourceContext {
  readonly moduleId: string;
  symbol(id: string): string;
  imported(moduleId: string, symbolId: string): string;
  resource(id: string): string;
  uniformField(resourceId: string, fieldId: string): string;
  specialization(id: string): string;
  entryPoint(id: string): string;
}

export interface ShaderGeneratedSourceSpan {
  readonly sourceId: string;
  readonly sourceName: string;
  /** One-based line inside `code`. */
  readonly generatedStartLine: number;
  /** One-based inclusive line inside `code`. */
  readonly generatedEndLine: number;
  readonly sourceStartLine?: number;
  readonly sourceStartColumn?: number;
}

export interface ShaderGeneratedSource {
  readonly code: string;
  readonly sourceMap?: readonly ShaderGeneratedSourceSpan[];
}

export type ShaderSourceFactory = (context: ShaderSourceContext) => string | ShaderGeneratedSource;

export interface ShaderModuleDefinition {
  readonly id: string;
  readonly version?: number;
  readonly sourceName?: string;
  readonly stages: readonly ShaderStage[];
  readonly dependencies?: readonly ShaderModule[];
  readonly symbols?: readonly ShaderSymbolDefinition[];
  readonly imports?: readonly ShaderSymbolImportDefinition[];
  readonly resources?: readonly ShaderResourceDefinition[];
  readonly specializations?: readonly ShaderSpecializationDefinition[];
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly targets?: readonly ShaderTarget[];
  readonly profiles?: readonly ShaderCapabilityProfile[];
  readonly passRequirements?: readonly string[];
  readonly entryPoints?: readonly ShaderEntryPointDefinition[];
  readonly source: ShaderSourceFactory;
}

export interface ShaderModule {
  readonly id: string;
  readonly version: number;
  readonly sourceName: string;
  readonly stages: readonly ShaderStage[];
  readonly dependencies: readonly ShaderModule[];
  readonly symbols: readonly ShaderSymbolDefinition[];
  readonly imports: readonly ShaderSymbolImport[];
  readonly resources: readonly ShaderResourceDefinition[];
  readonly specializations: readonly ShaderSpecializationDefinition[];
  readonly requires: readonly string[];
  readonly provides: readonly string[];
  readonly conflicts: readonly string[];
  readonly targets: readonly ShaderTarget[];
  readonly profiles: readonly ShaderCapabilityProfile[];
  readonly passRequirements: readonly string[];
  readonly entryPoints: readonly ShaderEntryPointDefinition[];
  readonly source: ShaderSourceFactory;
}

export interface ShaderUniformFieldReflection {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly arrayStride?: number;
  readonly matrixStride?: number;
}

export interface ShaderUniformBlockReflection {
  readonly id: string;
  readonly alignment: number;
  readonly byteSize: number;
  readonly fields: readonly ShaderUniformFieldReflection[];
}

export interface ShaderResourceReflection {
  readonly id: string;
  readonly space: ShaderResourceSpace;
  readonly group: number;
  readonly binding: number;
  readonly kind: ShaderResourceKind;
  readonly visibility: readonly ShaderStage[];
}

export interface ShaderVaryingReflection {
  readonly semantic: string;
  readonly location: number;
  readonly type: string;
  readonly interpolation: 'perspective' | 'linear' | 'flat';
}

export interface ShaderSourceSpan {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
  readonly sourceStartLine?: number;
  readonly sourceStartColumn?: number;
}

export interface ShaderSourceLocation {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly line: number;
  readonly column: number;
  readonly generatedLine: number;
}

export interface ShaderReflection {
  readonly format: 'haiyue-shader-reflection';
  readonly version: 1;
  readonly compilerVersion: string;
  readonly target: ShaderTarget;
  readonly profile: ShaderCapabilityProfile;
  readonly irHash: string;
  readonly variantKey: string;
  readonly entryPoints: readonly { readonly stage: ShaderStage; readonly name: string }[];
  readonly resources: readonly ShaderResourceReflection[];
  readonly uniformBlocks: readonly ShaderUniformBlockReflection[];
  readonly vertexSemantics: readonly string[];
  readonly varyings: readonly ShaderVaryingReflection[];
  readonly capabilities: readonly string[];
  readonly passRequirements: readonly string[];
  readonly sourceMap: readonly {
    readonly sourceId: string;
    readonly generatedStartLine: number;
    readonly generatedEndLine: number;
  }[];
}

export interface ComposeShaderModulesOptions {
  readonly label: string;
  readonly entry: ShaderModule;
  readonly target?: ShaderTarget;
  readonly profile?: ShaderCapabilityProfile;
  readonly availableCapabilities?: readonly string[];
  readonly specializationValues?: Readonly<Record<string, ShaderSpecializationValue>>;
  readonly maxBindingsPerGroup?: number | Partial<Record<ShaderResourceSpace, number>>;
  readonly vertexSemantics?: readonly string[];
  readonly varyings?: readonly ShaderVaryingReflection[];
  readonly passRequirements?: readonly string[];
}

export interface ComposedShaderModules {
  readonly label: string;
  readonly code: string;
  readonly moduleIds: readonly string[];
  readonly variantKey: string;
  readonly irHash: string;
  readonly reflection: ShaderReflection;
  readonly sourceMap: readonly ShaderSourceSpan[];
}

export type ShaderDiagnosticCode =
  | 'E_SHADER_MODULE_INVALID'
  | 'E_SHADER_DEPENDENCY_CYCLE'
  | 'E_SHADER_MODULE_ID_CONFLICT'
  | 'E_SHADER_SYMBOL_INVALID'
  | 'E_SHADER_IMPORT_MISSING'
  | 'E_SHADER_CAPABILITY_MISSING'
  | 'E_SHADER_CAPABILITY_CONFLICT'
  | 'E_SHADER_STAGE_MISMATCH'
  | 'E_SHADER_RESOURCE_CONFLICT'
  | 'E_SHADER_RESOURCE_LIMIT'
  | 'E_SHADER_BINDING_CONFLICT'
  | 'E_SHADER_SPECIALIZATION_INVALID'
  | 'E_SHADER_TARGET_UNSUPPORTED'
  | 'E_SHADER_SOURCE_GENERATION_FAILED'
  | 'E_SHADER_IR_INVALID'
  | 'E_SHADER_TYPE_MISMATCH'
  | 'E_SHADER_SEMANTIC_MISMATCH'
  | 'E_SHADER_SPACE_MISMATCH'
  | 'E_SHADER_STAGE_VIOLATION'
  | 'E_SHADER_IR_RESOURCE_INVALID'
  | 'E_SHADER_WGSL_CODEGEN'
  | 'E_SHADER_GLSL_CODEGEN'
  | 'E_SHADER_GRAPH_INVALID'
  | 'E_SHADER_GRAPH_NODE_UNKNOWN'
  | 'E_SHADER_GRAPH_REFERENCE_INVALID'
  | 'E_SHADER_GRAPH_PORT_INVALID'
  | 'E_SHADER_SURFACE_INVALID'
  | 'E_SHADER_SURFACE_UNSUPPORTED'
  | 'E_SHADER_UNIFORM_VALUE_INVALID';

export interface ShaderDiagnostic {
  readonly code: ShaderDiagnosticCode;
  readonly message: string;
  readonly moduleId?: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
