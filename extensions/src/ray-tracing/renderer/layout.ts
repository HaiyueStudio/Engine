import { RAY_PATH_TRACING_SHADER_ARTIFACT } from './shaders/path-tracing-artifact.generated.js';

export const RAY_PATH_LAYOUT = Object.freeze({
  artifactFormat: RAY_PATH_TRACING_SHADER_ARTIFACT.format,
  artifactVersion: RAY_PATH_TRACING_SHADER_ARTIFACT.version,
  artifactHash: RAY_PATH_TRACING_SHADER_ARTIFACT.artifactHash,
  compilerVersion: RAY_PATH_TRACING_SHADER_ARTIFACT.compilerVersion,
  tracePassId: 'ray-path-tracing', tonePassId: 'ray-tone-mapping',
  workgroupSizeX: 8, workgroupSizeY: 8,
  materialStride: 128, surfaceStride: 128,
  parameterBytes: 128, lightBytes: 512, diagnosticBytes: 48,
  maxLights: 8, maxBounces: 8,
  requiredStorageBuffersPerShaderStage: 8,
  requiredBindingsPerBindGroup: 15,
});

export function createRayPathBindGroupLayouts(device: GPUDevice): readonly [GPUBindGroupLayout, GPUBindGroupLayout] {
  const trace = RAY_PATH_TRACING_SHADER_ARTIFACT.passes[RAY_PATH_LAYOUT.tracePassId];
  const tone = RAY_PATH_TRACING_SHADER_ARTIFACT.passes[RAY_PATH_LAYOUT.tonePassId];
  if (!trace || !tone) throw new Error('Ray path-tracing Artifact V2 is missing a required pass.');
  const groups = [trace.bindGroups[0], tone.bindGroups[0]];
  if (groups.some(group => !group || group.physicalGroup !== 0 || group.owner !== 'artifact')
    || trace.bindGroups.length !== 1 || tone.bindGroups.length !== 1) throw new Error('Ray path-tracing Artifact V2 group ownership drifted.');
  const created = groups.map((group, index) => device.createBindGroupLayout({
    label: `ray-path-artifact-v2-${index === 0 ? 'trace' : 'tone'}-group-0`,
    entries: group.bindings.map(binding => ({
      binding: binding.binding,
      visibility: GPUShaderStage.COMPUTE,
      ...layoutEntry(binding.layout),
    })),
  }));
  return Object.freeze([created[0]!, created[1]!] as const);
}

function layoutEntry(layout: typeof RAY_PATH_TRACING_SHADER_ARTIFACT.passes[keyof typeof RAY_PATH_TRACING_SHADER_ARTIFACT.passes]['bindGroups'][number]['bindings'][number]['layout']): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> {
  if (layout.kind === 'buffer') return { buffer: { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize } };
  if (layout.kind === 'texture') return { texture: { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled } };
  if (layout.kind === 'sampler') return { sampler: { type: layout.samplerType } };
  if (layout.kind === 'storage-texture') return { storageTexture: { access: layout.access, format: layout.format as GPUTextureFormat, viewDimension: layout.viewDimension } };
  throw new Error('Ray path-tracing Artifact V2 contains an unsupported external texture binding.');
}
