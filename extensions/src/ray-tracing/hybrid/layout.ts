import { RAY_HYBRID_SHADER_ARTIFACT } from './shaders/hybrid-artifact.generated.js';

export const RAY_HYBRID_LAYOUT = Object.freeze({ artifactHash: RAY_HYBRID_SHADER_ARTIFACT.artifactHash, workgroupSize: 8, parameterBytes: 256, compositeParameterBytes: 32, diagnosticBytes: 48,
  passIds: Object.freeze({ shadow: 'ray-hybrid-shadow', reflection: 'ray-hybrid-reflection', ao: 'ray-hybrid-ao', composite: 'ray-hybrid-composite' }) });
type PassId = keyof typeof RAY_HYBRID_SHADER_ARTIFACT.passes;
type Layout = typeof RAY_HYBRID_SHADER_ARTIFACT.passes[PassId]['bindGroups'][number]['bindings'][number]['layout'];
export function createRayHybridLayouts(device: GPUDevice): Readonly<Record<PassId, GPUBindGroupLayout>> {
  const result = {} as Record<PassId, GPUBindGroupLayout>;
  for (const id of Object.values(RAY_HYBRID_LAYOUT.passIds) as PassId[]) { const pass = RAY_HYBRID_SHADER_ARTIFACT.passes[id]; const group = pass?.bindGroups[0]; if (!pass || !group || pass.bindGroups.length !== 1 || group.owner !== 'artifact' || group.physicalGroup !== 0) throw new Error(`Hybrid Artifact V2 ownership drifted for ${id}.`); result[id] = device.createBindGroupLayout({ label: `${id}-artifact-v2-group-0`, entries: group.bindings.map(binding => ({ binding: binding.binding, visibility: GPUShaderStage.COMPUTE, ...entry(binding.layout) })) }); }
  return Object.freeze(result);
}
function entry(layout: Layout): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> { if (layout.kind === 'buffer') return { buffer: { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize } }; if (layout.kind === 'texture') return { texture: { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled } }; if (layout.kind === 'storage-texture') return { storageTexture: { access: layout.access, format: layout.format as GPUTextureFormat, viewDimension: layout.viewDimension } }; throw new Error('Unsupported hybrid Artifact V2 binding.'); }
