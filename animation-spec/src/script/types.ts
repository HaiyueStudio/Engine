export const SANDBOXED_ANIMATION_SCRIPT_EXTENSION = 'org.haiyue.sandboxed-animation-script@1' as const;
export const PORTABLE_SCRIPT_ARTIFACT = 'haiyue-portable-script@1' as const;

export type AnimationScriptProtocol =
  | 'node'
  | 'layout'
  | 'converter'
  | 'path-effect'
  | 'transition-condition'
  | 'listener-action'
  | 'util';

export type AnimationScriptCapability =
  | 'data.read'
  | 'data.write'
  | 'asset.read'
  | 'path.emit'
  | 'canvas.emit'
  | 'event.emit'
  | 'timer.schedule'
  | 'timer.cancel';

export type AnimationScriptHandleKind =
  | 'node'
  | 'layout'
  | 'view-model'
  | 'image'
  | 'font'
  | 'audio'
  | 'blob'
  | 'canvas';

export interface AnimationScriptSourceLocation {
  readonly sourceId: string;
  readonly line: number;
  readonly column: number;
}

export type PortableScriptConstant = null | boolean | number | string;

export type PortableScriptUnaryOperator = 'negate' | 'not' | 'length';
export type PortableScriptBinaryOperator =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'power'
  | 'equal'
  | 'not-equal'
  | 'less'
  | 'less-equal'
  | 'greater'
  | 'greater-equal'
  | 'and'
  | 'or'
  | 'concat';

export type PortableScriptInstruction =
  | { readonly op: 'load-constant'; readonly to: number; readonly constant: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'load-input'; readonly to: number; readonly name: string; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'load-context'; readonly to: number; readonly path: readonly string[]; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'random'; readonly to: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'move'; readonly to: number; readonly from: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'unary'; readonly to: number; readonly operator: PortableScriptUnaryOperator; readonly value: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'binary'; readonly to: number; readonly operator: PortableScriptBinaryOperator; readonly left: number; readonly right: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'make-list'; readonly to: number; readonly values: readonly number[]; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'make-table'; readonly to: number; readonly entries: readonly { readonly key: string; readonly value: number }[]; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'get'; readonly to: number; readonly target: number; readonly key: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'set'; readonly target: number; readonly key: number; readonly value: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'jump'; readonly target: number; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'jump-if'; readonly condition: number; readonly target: number; readonly when: boolean; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'call'; readonly to: number; readonly function: string; readonly arguments: readonly number[]; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'capability'; readonly to?: number | undefined; readonly capability: AnimationScriptCapability; readonly arguments: readonly number[]; readonly location?: AnimationScriptSourceLocation | undefined }
  | { readonly op: 'return'; readonly value?: number | undefined; readonly location?: AnimationScriptSourceLocation | undefined };

export interface PortableScriptFunction {
  readonly id: string;
  readonly parameters: number;
  readonly registers: number;
  readonly instructions: readonly PortableScriptInstruction[];
}

export interface PortableScriptProgram {
  readonly id: string;
  readonly protocol: AnimationScriptProtocol;
  readonly artifact: typeof PORTABLE_SCRIPT_ARTIFACT;
  readonly sourceRevisionSha256: string;
  readonly constants: readonly PortableScriptConstant[];
  readonly functions: readonly PortableScriptFunction[];
  readonly entrypoints: Readonly<Record<string, string>>;
  readonly capabilities: readonly AnimationScriptCapability[];
}

export type SandboxedShaderBindingKind = 'uniform-buffer' | 'sampled-texture' | 'sampler';

export interface SandboxedShaderBinding {
  readonly binding: number;
  readonly kind: SandboxedShaderBindingKind;
  readonly visibility: 'vertex' | 'fragment' | 'vertex-fragment';
  readonly maxBytes?: number | undefined;
}

export interface SandboxedShaderModule {
  readonly id: string;
  readonly language: 'wgsl';
  readonly vertexEntryPoint: string;
  readonly fragmentEntryPoint: string;
  readonly source: string;
  readonly bindings: readonly SandboxedShaderBinding[];
  readonly targetFormat: 'rgba8unorm';
}

export interface SandboxedAnimationScriptLimits {
  readonly maxPrograms: number;
  readonly maxProgramBytes: number;
  readonly maxFunctions: number;
  readonly maxInstructionsPerFunction: number;
  readonly maxInstructionsPerInvocation: number;
  readonly maxInstructionsPerScope: number;
  readonly maxRegistersPerFunction: number;
  readonly maxConstants: number;
  readonly maxStringBytes: number;
  readonly maxHeapBytes: number;
  readonly maxCallDepth: number;
  readonly maxOutputCommands: number;
  readonly maxEventsPerInvocation: number;
  readonly maxTimers: number;
  readonly maxPendingPromises: number;
  readonly maxWallTimeMs: number;
  readonly maxShaderModules: number;
  readonly maxShaderSourceBytes: number;
  readonly maxShaderTokens: number;
  readonly maxShaderBindings: number;
  readonly maxTextures: number;
  readonly maxUniformBytes: number;
  readonly maxStorageBytes: number;
  readonly maxPipelines: number;
  readonly maxDrawsPerFrame: number;
}

export interface SandboxedAnimationScriptDocument {
  readonly extension: typeof SANDBOXED_ANIMATION_SCRIPT_EXTENSION;
  readonly version: 1;
  readonly language: Readonly<{
    source: 'luau';
    sourcePolicy: 'build-time-only';
    sourceRevisionSha256: string;
    artifact: typeof PORTABLE_SCRIPT_ARTIFACT;
    numericMode: 'ieee754-f64-canonical-nan';
    stringMode: 'utf8';
    tableMode: 'insertion-ordered-own-keys';
    modulePolicy: 'closed-manifest';
    clock: 'injected-integer-microseconds';
    random: 'injected-seeded-xoshiro128';
  }>;
  readonly limits: SandboxedAnimationScriptLimits;
  readonly programs: readonly PortableScriptProgram[];
  readonly shaders: readonly SandboxedShaderModule[];
}
