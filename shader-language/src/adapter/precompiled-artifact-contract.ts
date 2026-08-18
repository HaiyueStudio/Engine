/** Canonical Artifact V2 data contract. Keep this file type-only and runtime-neutral. */
export type PrecompiledShaderStage = 'vertex' | 'fragment' | 'compute';
export type PrecompiledShaderResourceSpace = 'frame' | 'object' | 'material' | 'pass';
export type PrecompiledShaderLayoutOwnerV2 = 'artifact' | 'renderer';

export interface PrecompiledShaderUniformFieldV2 {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly arrayStride?: number;
  readonly matrixStride?: number;
}

export interface PrecompiledShaderUniformBlockV2 {
  readonly id: string;
  readonly alignment: number;
  readonly byteSize: number;
  readonly fields: readonly PrecompiledShaderUniformFieldV2[];
}

export interface PrecompiledShaderVaryingV2 {
  readonly semantic: string;
  readonly location: number;
  readonly type: string;
  readonly interpolation: 'perspective' | 'linear' | 'flat';
}

export type PrecompiledShaderBindingLayoutV2 =
  | {
      readonly kind: 'buffer';
      readonly bufferType: 'uniform' | 'storage' | 'read-only-storage';
      readonly hasDynamicOffset: boolean;
      readonly minBindingSize: number;
    }
  | {
      readonly kind: 'sampler';
      readonly samplerType: 'filtering' | 'non-filtering' | 'comparison';
    }
  | {
      readonly kind: 'texture';
      readonly sampleType: 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';
      readonly viewDimension: '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
      readonly multisampled: boolean;
    }
  | {
      readonly kind: 'storage-texture';
      readonly access: 'write-only' | 'read-only' | 'read-write';
      readonly format: string;
      readonly viewDimension: '1d' | '2d' | '2d-array' | '3d';
    }
  | { readonly kind: 'external-texture' };

export interface PrecompiledShaderBindingV2 {
  readonly id: string;
  readonly binding: number;
  readonly visibility: readonly PrecompiledShaderStage[];
  readonly layout: PrecompiledShaderBindingLayoutV2;
}

export interface PrecompiledShaderBindGroupV2 {
  readonly logicalSpace: PrecompiledShaderResourceSpace;
  readonly logicalGroup: number;
  readonly physicalGroup: number;
  readonly owner: PrecompiledShaderLayoutOwnerV2;
  readonly bindings: readonly PrecompiledShaderBindingV2[];
}

export interface PrecompiledShaderVertexAttributeV2 {
  readonly semantic: string;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: string;
}

export interface PrecompiledShaderVertexBufferV2 {
  readonly arrayStride: number;
  readonly stepMode: 'vertex' | 'instance';
  readonly attributes: readonly PrecompiledShaderVertexAttributeV2[];
}

export interface PrecompiledShaderRenderTargetV2 {
  readonly location: number;
  readonly formatClass: string;
}

export interface PrecompiledShaderStageEntriesV2 {
  readonly vertex?: string;
  readonly fragment?: string;
  readonly compute?: string;
}

export interface PrecompiledShaderSourceMapEntryV2 {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
  readonly sourceStartLine?: number;
  readonly sourceStartColumn?: number;
}

export interface PrecompiledShaderPassV2 {
  readonly id: string;
  readonly code: string;
  readonly canonicalHash: string;
  readonly entryPoints: PrecompiledShaderStageEntriesV2;
  readonly bindGroups: readonly PrecompiledShaderBindGroupV2[];
  readonly uniformBlocks: readonly PrecompiledShaderUniformBlockV2[];
  readonly vertexBuffers: readonly PrecompiledShaderVertexBufferV2[];
  readonly varyings: readonly PrecompiledShaderVaryingV2[];
  readonly renderTargets: readonly PrecompiledShaderRenderTargetV2[];
  readonly capabilities: readonly string[];
  readonly passRequirements: readonly string[];
  readonly sourceMap: readonly PrecompiledShaderSourceMapEntryV2[];
}

export interface PrecompiledShaderArtifactV2 {
  readonly format: 'haiyue-precompiled-shader-artifact';
  readonly version: 2;
  readonly compilerVersion: string;
  readonly source: {
    readonly kind: 'graph' | 'typed-ir' | 'module-family';
    readonly path: string;
    readonly sha256: string;
  };
  readonly canonicalHash: string;
  readonly typedModuleHash: string;
  readonly passes: Readonly<Record<string, PrecompiledShaderPassV2>>;
  readonly artifactHash: string;
}
