import { RAY_PROGRESSIVE_SHADER_ARTIFACT } from './shaders/progressive-artifact.generated.js';

export const RAY_PROGRESSIVE_LAYOUT = Object.freeze({
  artifactHash: RAY_PROGRESSIVE_SHADER_ARTIFACT.artifactHash,
  accumulatePassId: 'ray-progressive-accumulate',
  presentPassId: 'ray-progressive-present',
  parameterBytes: 64,
  diagnosticBytes: 16,
  workgroupSizeX: 8,
  workgroupSizeY: 8,
  requiredStorageTextures: 4,
  requiredBindings: 9,
});

export function createRayProgressiveLayouts(device: GPUDevice): readonly [GPUBindGroupLayout, GPUBindGroupLayout] {
  const accumulate = RAY_PROGRESSIVE_SHADER_ARTIFACT.passes[RAY_PROGRESSIVE_LAYOUT.accumulatePassId];
  const present = RAY_PROGRESSIVE_SHADER_ARTIFACT.passes[RAY_PROGRESSIVE_LAYOUT.presentPassId];
  if (!accumulate || !present || accumulate.bindGroups.length !== 1 || present.bindGroups.length !== 1) throw new Error('Ray progressive Artifact V2 pass layout is incomplete.');
  const groups = [accumulate.bindGroups[0]!, present.bindGroups[0]!];
  if (groups.some(group => group.owner !== 'artifact' || group.physicalGroup !== 0)) throw new Error('Ray progressive Artifact V2 group ownership drifted.');
  const layouts = groups.map((group, index) => device.createBindGroupLayout({
    label: `ray-progressive-${index === 0 ? 'accumulate' : 'present'}-group-0`,
    entries: group.bindings.map(binding => ({ binding: binding.binding, visibility: GPUShaderStage.COMPUTE, ...layoutEntry(binding.layout) })),
  }));
  return Object.freeze([layouts[0]!, layouts[1]!] as const);
}

type Layout = typeof RAY_PROGRESSIVE_SHADER_ARTIFACT.passes[keyof typeof RAY_PROGRESSIVE_SHADER_ARTIFACT.passes]['bindGroups'][number]['bindings'][number]['layout'];
function layoutEntry(layout: Layout): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> {
  if (layout.kind === 'buffer') return { buffer: { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize } };
  if (layout.kind === 'texture') return { texture: { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled } };
  if (layout.kind === 'storage-texture') return { storageTexture: { access: layout.access, format: layout.format as GPUTextureFormat, viewDimension: layout.viewDimension } };
  throw new Error('Unsupported ray progressive Artifact V2 binding.');
}
