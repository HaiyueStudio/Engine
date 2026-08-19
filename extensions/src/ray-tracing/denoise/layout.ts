import { RAY_DENOISE_SHADER_ARTIFACT } from './shaders/denoise-artifact.generated.js';

export const RAY_DENOISE_LAYOUT = Object.freeze({
  artifactHash: RAY_DENOISE_SHADER_ARTIFACT.artifactHash,
  temporalPassId: 'ray-denoise-temporal',
  spatialPassId: 'ray-denoise-spatial',
  parameterBytes: 64,
  workgroupSizeX: 8,
  workgroupSizeY: 8,
});

export function createRayDenoiseLayouts(device: GPUDevice): readonly [GPUBindGroupLayout, GPUBindGroupLayout] {
  const temporal = RAY_DENOISE_SHADER_ARTIFACT.passes[RAY_DENOISE_LAYOUT.temporalPassId];
  const spatial = RAY_DENOISE_SHADER_ARTIFACT.passes[RAY_DENOISE_LAYOUT.spatialPassId];
  if (!temporal || !spatial || temporal.bindGroups.length !== 1 || spatial.bindGroups.length !== 1) throw new Error('Ray denoise Artifact V2 pass layout is incomplete.');
  const groups = [temporal.bindGroups[0]!, spatial.bindGroups[0]!];
  if (groups.some(group => group.owner !== 'artifact' || group.physicalGroup !== 0)) throw new Error('Ray denoise Artifact V2 group ownership drifted.');
  const layouts = groups.map((group, index) => device.createBindGroupLayout({
    label: `ray-denoise-${index === 0 ? 'temporal' : 'spatial'}-group-0`,
    entries: group.bindings.map(binding => ({ binding: binding.binding, visibility: GPUShaderStage.COMPUTE, ...layoutEntry(binding.layout) })),
  }));
  return Object.freeze([layouts[0]!, layouts[1]!] as const);
}

type Layout = typeof RAY_DENOISE_SHADER_ARTIFACT.passes[keyof typeof RAY_DENOISE_SHADER_ARTIFACT.passes]['bindGroups'][number]['bindings'][number]['layout'];
function layoutEntry(layout: Layout): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> {
  if (layout.kind === 'buffer') return { buffer: { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize } };
  if (layout.kind === 'texture') return { texture: { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled } };
  if (layout.kind === 'storage-texture') return { storageTexture: { access: layout.access, format: layout.format as GPUTextureFormat, viewDimension: layout.viewDimension } };
  throw new Error('Unsupported ray denoise Artifact V2 binding.');
}
