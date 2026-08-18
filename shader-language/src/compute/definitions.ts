import type {
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderPassV2Definition,
} from '../adapter/precompiled-v2';
import type { ShaderUniformBlockReflection } from '../contracts';
import type { ProductionComputeOperation, ProductionComputePassIrV1 } from './contracts';
import gpuDrawCommand from './stdlib/gpu-draw-command.wgsl';
import gpuSortBitonic from './stdlib/gpu-sort-bitonic.wgsl';
import instancedCull from './stdlib/instanced-cull.wgsl';
import instancedDepthSortKey from './stdlib/instanced-depth-sort-key.wgsl';
import mesh3dCull from './stdlib/mesh3d-cull.wgsl';

const COMPUTE = Object.freeze(['compute'] as const);

export function productionComputeModules(): Readonly<Record<ProductionComputeOperation, string>> {
  return Object.freeze({
    'gpu-draw-command': `${gpuDrawCommand.trim()}\n`,
    'gpu-sort-bitonic': `${gpuSortBitonic.trim()}\n`,
    'instanced-cull': `${instancedCull.trim()}\n`,
    'instanced-depth-sort-key': `${instancedDepthSortKey.trim()}\n`,
    'mesh3d-cull': `${mesh3dCull.trim()}\n`,
  });
}

export function emitProductionComputePass(
  pass: ProductionComputePassIrV1,
  sourcePath: string,
  computeModuleHash: string,
): { readonly code: string; readonly artifactPass: PrecompiledShaderPassV2Definition } {
  const source = productionComputeModules()[pass.operation];
  const code = `// haiyue:compute-pass ${pass.operation}\n`
    + '// haiyue:compute-abi 1\n'
    + `// haiyue:compute-ir ${pass.canonicalHash}\n`
    + `// haiyue:compute-module ${computeModuleHash}\n`
    + `// source: ${sourcePath}\n\n${source.trim()}\n`;
  return Object.freeze({
    code,
    artifactPass: Object.freeze({
      id: pass.id,
      code,
      entryPoints: Object.freeze({ compute: pass.entryPoint }),
      bindGroups: Object.freeze([bindGroup(pass)]),
      uniformBlocks: uniformBlocks(pass.operation),
      vertexBuffers: Object.freeze([]),
      varyings: Object.freeze([]),
      renderTargets: Object.freeze([]),
      capabilities: capabilities(pass),
      passRequirements: Object.freeze([
        'compute-abi-v1',
        `workgroup-size-${pass.workgroupSize.join('x')}`,
        `dispatch-domain-${pass.dispatch.domain}`,
        `dispatch-schedule-${pass.dispatch.schedule}`,
        ...pass.effects.map(effect => `effect-${effect.kind}:${effect.resource}`),
      ]),
      sourceMap: Object.freeze([Object.freeze({
        sourceId: `compute.${pass.operation}`,
        sourceName: sourcePath,
        generatedStartLine: 1,
        generatedEndLine: code.split('\n').length,
      })]),
    }),
  });
}

function bindGroup(pass: ProductionComputePassIrV1): PrecompiledShaderBindGroupV2 {
  return Object.freeze({
    logicalSpace: 'pass' as const,
    logicalGroup: 3,
    physicalGroup: 0,
    owner: 'artifact' as const,
    bindings: Object.freeze(pass.resources.map(resource => binding(resource))),
  });
}

function binding(resource: ProductionComputePassIrV1['resources'][number]): PrecompiledShaderBindingV2 {
  const bufferType = resource.kind === 'uniform-buffer'
    ? 'uniform' as const
    : resource.access === 'read' ? 'read-only-storage' as const : 'storage' as const;
  return Object.freeze({
    id: resource.id,
    binding: resource.binding,
    visibility: COMPUTE,
    layout: Object.freeze({ kind: 'buffer' as const, bufferType, hasDynamicOffset: false, minBindingSize: resource.minBindingSize }),
  });
}

function capabilities(pass: ProductionComputePassIrV1): readonly string[] {
  const values = ['compute', 'storage-buffer', 'explicit-side-effects', 'explicit-dispatch-abi'];
  if (pass.resources.some(resource => resource.access === 'atomic-read-write')) values.push('atomic');
  if (pass.operation === 'gpu-draw-command' || pass.operation === 'mesh3d-cull') values.push('indirect-buffer-write');
  return Object.freeze(values);
}

function uniformBlocks(operation: ProductionComputeOperation): readonly ShaderUniformBlockReflection[] {
  switch (operation) {
    case 'gpu-draw-command': return Object.freeze([block('pass.drawCommandParams', 16, [field('commandCount', 'u32', 0, 4)])]);
    case 'gpu-sort-bitonic': return Object.freeze([]);
    case 'instanced-cull': return Object.freeze([
      block('pass.frustum', 96, [field('planes', 'array<vec4<f32>, 6>', 0, 96)]),
      block('pass.cullingParams', 32, [field('instanceCount', 'u32', 0, 4), field('localSphere', 'vec4<f32>', 16, 16)]),
    ]);
    case 'instanced-depth-sort-key': return Object.freeze([
      block('pass.sortKeyParams', 80, [field('instanceCount', 'u32', 0, 4), field('reverseDepth', 'u32', 4, 4), field('paddedCount', 'u32', 8, 4), matrix('view', 16)]),
    ]);
    case 'mesh3d-cull': return Object.freeze([
      block('pass.frustum', 96, [field('planes', 'array<vec4<f32>, 6>', 0, 96)]),
      block('pass.cullParams', 16, [field('commandCount', 'u32', 0, 4)]),
    ]);
  }
}

function block(id: string, byteSize: number, fields: readonly ShaderUniformBlockReflection['fields'][number][]): ShaderUniformBlockReflection {
  return Object.freeze({ id, alignment: 16, byteSize, fields: Object.freeze(fields) });
}

function field(name: string, type: string, offset: number, size: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type, offset, size });
}

function matrix(name: string, offset: number): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({ name, type: 'mat4x4<f32>', offset, size: 64, matrixStride: 16 });
}
