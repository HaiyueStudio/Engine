import { RAY_TRAVERSAL_SHADER_ARTIFACT } from '../shaders/ray-traversal-artifact.generated.js';

export const RAY_TRAVERSAL_LAYOUT = Object.freeze({
  artifactFormat: RAY_TRAVERSAL_SHADER_ARTIFACT.format,
  artifactVersion: RAY_TRAVERSAL_SHADER_ARTIFACT.version,
  artifactHash: RAY_TRAVERSAL_SHADER_ARTIFACT.artifactHash,
  compilerVersion: RAY_TRAVERSAL_SHADER_ARTIFACT.compilerVersion,
  passId: 'ray-traversal',
  workgroupSize: 64,
  rayStride: 32,
  hitStride: 96,
  diagnosticSize: 32,
  parameterSize: 32,
  stackCapacity: 64,
  requiredStorageBuffersPerShaderStage: 8,
  requiredBindingsPerBindGroup: 9,
});

export function createRayTraversalBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  const pass = RAY_TRAVERSAL_SHADER_ARTIFACT.passes[RAY_TRAVERSAL_LAYOUT.passId];
  if (!pass) throw new Error('Ray traversal Artifact V2 is missing its frozen pass.');
  const group = pass.bindGroups[0];
  if (!group || group.owner !== 'artifact' || group.physicalGroup !== 0) throw new Error('Ray traversal Artifact V2 layout ownership drifted.');
  return device.createBindGroupLayout({
    label: 'ray-traversal-artifact-v2-layout',
    entries: group.bindings.map(binding => {
      if (binding.layout.kind !== 'buffer') throw new Error(`Ray traversal binding ${binding.id} is not a buffer.`);
      return {
        binding: binding.binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: binding.layout.bufferType,
          hasDynamicOffset: binding.layout.hasDynamicOffset,
          minBindingSize: binding.layout.minBindingSize,
        },
      } satisfies GPUBindGroupLayoutEntry;
    }),
  });
}
