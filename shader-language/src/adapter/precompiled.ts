import type { ShaderUniformBlockReflection } from '../contracts';
import { shaderError } from '../diagnostics';
import type {
  CompiledMotionBlurGraphV1,
  CompiledMotionBlurPassV1,
  MotionBlurPostProcessPass,
} from '../postprocess/contracts';
import {
  createPrecompiledShaderArtifactV2,
  type PrecompiledShaderArtifactV2,
  type PrecompiledShaderBindingLayoutV2,
  type PrecompiledShaderPassV2Definition,
} from './precompiled-v2';

export interface MotionBlurPrecompiledArtifactOptions {
  readonly sourceGraphPath: string;
  readonly sourceGraphSha256: string;
}

/** Creates the production Motion Blur Artifact V2 from canonical graph compilation output. */
export function createMotionBlurPrecompiledArtifactV2(
  compiled: CompiledMotionBlurGraphV1,
  options: MotionBlurPrecompiledArtifactOptions,
): PrecompiledShaderArtifactV2 {
  if (!options.sourceGraphPath || !/^[a-f0-9]{64}$/.test(options.sourceGraphSha256)) {
    artifactError('source', 'Precompiled artifact requires stable graph path and SHA-256 provenance.');
  }
  const groups = new Set(Object.values(compiled.compilation.passes)
    .flatMap(pass => pass.reflection.resources.map(resource => resource.group)));
  if (groups.size !== 1 || groups.values().next().value !== 0) {
    artifactError('passes.bindGroups', 'Motion Blur must compact logical pass group 3 to physical group 0.');
  }
  const passes = Object.values(compiled.compilation.passes).map(pass => precompilePass(pass, compiled));
  return createPrecompiledShaderArtifactV2({
    compilerVersion: 'shader-language-m025',
    source: Object.freeze({
      kind: 'graph' as const,
      path: options.sourceGraphPath,
      sha256: options.sourceGraphSha256,
    }),
    canonicalHash: compiled.program.canonicalHash,
    typedModuleHash: compiled.compilation.typedModuleHash,
    passes,
  });
}

function precompilePass(
  pass: CompiledMotionBlurPassV1,
  compiled: CompiledMotionBlurGraphV1,
): PrecompiledShaderPassV2Definition {
  const bindings = pass.reflection.resources.map(resource => Object.freeze({
    id: resource.id,
    binding: resource.binding,
    visibility: resource.visibility,
    layout: bindingLayout(resource.id, compiled, pass),
  }));
  return Object.freeze({
    id: pass.pass,
    code: pass.code,
    entryPoints: Object.freeze({
      vertex: pass.reflection.vertexEntryPoint,
      fragment: pass.reflection.fragmentEntryPoint,
    }),
    bindGroups: Object.freeze([Object.freeze({
      logicalSpace: 'pass' as const,
      logicalGroup: 3,
      physicalGroup: 0,
      owner: 'artifact' as const,
      bindings: Object.freeze(bindings),
    })]),
    uniformBlocks: pass.reflection.uniformBlocks,
    vertexBuffers: Object.freeze([]),
    varyings: Object.freeze([]),
    renderTargets: Object.freeze([Object.freeze({
      location: 0,
      formatClass: pass.reflection.targetFormatClass,
    })]),
    capabilities: Object.freeze(['texture-sample']),
    passRequirements: Object.freeze(['motion-blur-abi-v1', 'artifact-v2']),
    sourceMap: Object.freeze([Object.freeze({
      sourceId: `motion-blur.${pass.pass}`,
      sourceName: compiled.graph.sourceName,
      generatedStartLine: 1,
      generatedEndLine: pass.code.split('\n').length,
    })]),
  });
}

function bindingLayout(
  id: string,
  compiled: CompiledMotionBlurGraphV1,
  pass: CompiledMotionBlurPassV1,
): PrecompiledShaderBindingLayoutV2 {
  const resources = compiled.program.resources;
  if (id === resources.sourceColor) {
    return Object.freeze({ kind: 'texture', sampleType: 'float', viewDimension: '2d', multisampled: false });
  }
  if (id === resources.velocity || id === resources.tileMax || id === resources.neighborMax) {
    return Object.freeze({ kind: 'texture', sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false });
  }
  if (id === resources.sampler) return Object.freeze({ kind: 'sampler', samplerType: 'filtering' });
  if (id === resources.parameters || id === resources.tileParameters) {
    const block = uniformBlock(pass.reflection.uniformBlocks, id, pass.pass);
    return Object.freeze({
      kind: 'buffer',
      bufferType: 'uniform',
      hasDynamicOffset: false,
      minBindingSize: block.byteSize,
    });
  }
  return artifactError(`passes.${pass.pass}.resources.${id}`, `No production binding policy exists for ${id}.`);
}

function uniformBlock(
  blocks: readonly ShaderUniformBlockReflection[],
  id: string,
  pass: MotionBlurPostProcessPass,
): ShaderUniformBlockReflection {
  const block = blocks.find(candidate => candidate.id === id);
  if (!block) artifactError(`passes.${pass}.uniformBlocks.${id}`, 'Uniform resource is missing its reflected block.');
  return block!;
}

function artifactError(path: string, message: string): never {
  shaderError('E_SHADER_RESOURCE_CONFLICT', message, {
    moduleId: '@motion-blur-precompiled-artifact-v2',
    path,
  });
}
