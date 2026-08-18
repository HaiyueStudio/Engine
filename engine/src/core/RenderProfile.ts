import {
  GPU_FEATURE_INDIRECT_FIRST_INSTANCE,
  GPU_FEATURE_TIMESTAMP_QUERY,
  OPTIONAL_TEXTURE_COMPRESSION_FEATURES,
  hasGpuFeature,
} from './GPUFeatures';

export type RenderDimension = '3d' | '2d' | 'mixed';
export type RenderProfileName = 'simple' | 'batched' | 'gpu-driven' | 'diagnostic';

export type RenderCapabilityName =
  | 'material-batching'
  | 'frustum-culling'
  | 'gpu-driven-batches'
  | 'gpu-driven-draw-commands'
  | 'gpu-driven-indirect-draws'
  | 'gpu-driven-culling'
  | 'gpu-timestamp-query'
  | 'gpu-culling-readback'
  | 'texture-compression-bc'
  | 'texture-compression-etc2'
  | 'texture-compression-astc';

export interface RenderProfileSettings {
  readonly materialBatching: boolean;
  readonly frustumCulling: boolean;
  readonly gpuDrivenBatches: boolean;
  readonly gpuDrivenDrawCommands: boolean;
  readonly gpuDrivenIndirectDraws: boolean;
  readonly gpuDrivenCulling: boolean;
  readonly gpuTimestampQuery: boolean;
  readonly gpuCullingReadback: boolean;
  readonly megaBatchSort: boolean;
}

/** A named, immutable product configuration. Boolean combinations are not part of the stable API. */
export interface RenderProfile {
  readonly name: RenderProfileName;
  readonly dimension: RenderDimension;
  readonly description: string;
  readonly settings: RenderProfileSettings;
}

export interface RenderCapabilityDecision {
  readonly capability: RenderCapabilityName;
  readonly requested: boolean;
  readonly enabled: boolean;
  readonly fallback: string | null;
  readonly reason: string;
}

export interface RenderCapabilityReport {
  readonly requestedProfile: RenderProfileName;
  readonly enabledProfile: RenderProfileName;
  readonly degraded: boolean;
  readonly decisions: readonly RenderCapabilityDecision[];
}

export interface RenderCapabilities {
  readonly profile: RenderProfile;
  readonly report: RenderCapabilityReport;
  readonly format: GPUTextureFormat;
  readonly adapterFeatures: readonly GPUFeatureName[];
  readonly deviceFeatures: readonly GPUFeatureName[];
  readonly settings: RenderProfileSettings;
  readonly timestampQuery: boolean;
  readonly indirectFirstInstance: boolean;
  readonly textureCompression: Readonly<{
    bc: boolean;
    etc2: boolean;
    astc: boolean;
  }>;
}

function settings(input: Partial<RenderProfileSettings>): RenderProfileSettings {
  return Object.freeze({
    materialBatching: false,
    frustumCulling: false,
    gpuDrivenBatches: false,
    gpuDrivenDrawCommands: false,
    gpuDrivenIndirectDraws: false,
    gpuDrivenCulling: false,
    gpuTimestampQuery: false,
    gpuCullingReadback: false,
    megaBatchSort: false,
    ...input,
  });
}

export const RENDER_PROFILES: Readonly<Record<RenderProfileName, RenderProfile>> = Object.freeze({
  simple: Object.freeze({
    name: 'simple',
    dimension: '3d',
    description: 'Direct rendering with the smallest GPU feature and memory footprint.',
    settings: settings({}),
  }),
  batched: Object.freeze({
    name: 'batched',
    dimension: '3d',
    description: 'CPU-visible culling and material/geometry batching without optional GPU features.',
    settings: settings({
      materialBatching: true,
      frustumCulling: true,
      gpuDrivenBatches: true,
      megaBatchSort: true,
    }),
  }),
  'gpu-driven': Object.freeze({
    name: 'gpu-driven',
    dimension: '3d',
    description: 'Indirect command generation and GPU culling, with an explicit batched fallback.',
    settings: settings({
      materialBatching: true,
      frustumCulling: true,
      gpuDrivenBatches: true,
      gpuDrivenDrawCommands: true,
      gpuDrivenIndirectDraws: true,
      gpuDrivenCulling: true,
      megaBatchSort: true,
    }),
  }),
  diagnostic: Object.freeze({
    name: 'diagnostic',
    dimension: '3d',
    description: 'GPU-driven rendering plus timestamp and culling readback diagnostics.',
    settings: settings({
      materialBatching: true,
      frustumCulling: true,
      gpuDrivenBatches: true,
      gpuDrivenDrawCommands: true,
      gpuDrivenIndirectDraws: true,
      gpuDrivenCulling: true,
      gpuTimestampQuery: true,
      gpuCullingReadback: true,
      megaBatchSort: true,
    }),
  }),
});

/** Conservative 3D-first default that works without optional WebGPU features. */
export const DEFAULT_RENDER_PROFILE: RenderProfileName = 'batched';

export function getRenderProfile(name: RenderProfileName = DEFAULT_RENDER_PROFILE): RenderProfile {
  return RENDER_PROFILES[name];
}

export function resolveRenderProfileFeatures(
  adapterFeatures: GPUSupportedFeatures,
  profileName: RenderProfileName,
  options: { timestampQuery?: boolean } = {},
): readonly GPUFeatureName[] {
  const profile = getRenderProfile(profileName);
  const requested = new Set<GPUFeatureName>();
  const wantsIndirect = profile.settings.gpuDrivenIndirectDraws;
  if (wantsIndirect && hasGpuFeature(adapterFeatures, GPU_FEATURE_INDIRECT_FIRST_INSTANCE)) {
    requested.add(GPU_FEATURE_INDIRECT_FIRST_INSTANCE);
  }
  if (
    profile.settings.gpuTimestampQuery &&
    options.timestampQuery !== false &&
    hasGpuFeature(adapterFeatures, GPU_FEATURE_TIMESTAMP_QUERY)
  ) {
    requested.add(GPU_FEATURE_TIMESTAMP_QUERY);
  }
  for (const feature of OPTIONAL_TEXTURE_COMPRESSION_FEATURES) {
    if (hasGpuFeature(adapterFeatures, feature)) requested.add(feature);
  }
  return Object.freeze([...requested]);
}

export function resolveRenderProfileSettings(
  profileName: RenderProfileName,
  deviceFeatures?: GPUSupportedFeatures | null,
): RenderProfileSettings {
  const requested = getRenderProfile(profileName).settings;
  return resolveSettings(requested, {
    indirectFirstInstance: hasGpuFeature(deviceFeatures, GPU_FEATURE_INDIRECT_FIRST_INSTANCE),
    timestampQuery: hasGpuFeature(deviceFeatures, GPU_FEATURE_TIMESTAMP_QUERY),
  });
}

export function createRenderCapabilities(
  profileName: RenderProfileName,
  adapter: Pick<GPUAdapter, 'features'>,
  device: Pick<GPUDevice, 'features'>,
  format: GPUTextureFormat,
): RenderCapabilities {
  const profile = getRenderProfile(profileName);
  const adapterFeatures = Object.freeze([...adapter.features] as GPUFeatureName[]);
  const deviceFeatures = Object.freeze([...device.features] as GPUFeatureName[]);
  const indirectFirstInstance = hasGpuFeature(device.features, GPU_FEATURE_INDIRECT_FIRST_INSTANCE);
  const timestampQuery = hasGpuFeature(device.features, GPU_FEATURE_TIMESTAMP_QUERY);
  const resolvedSettings = resolveSettings(profile.settings, { indirectFirstInstance, timestampQuery });
  const decisions = createCapabilityDecisions(profile.settings, resolvedSettings, adapter.features, device.features);
  const enabledProfile = resolveEnabledProfile(profileName, resolvedSettings);
  const report: RenderCapabilityReport = Object.freeze({
    requestedProfile: profileName,
    enabledProfile,
    degraded: decisions.some(decision => decision.requested && !decision.enabled),
    decisions: Object.freeze(decisions),
  });
  return Object.freeze({
    profile,
    report,
    format,
    adapterFeatures,
    deviceFeatures,
    settings: resolvedSettings,
    timestampQuery,
    indirectFirstInstance,
    textureCompression: Object.freeze({
      bc: hasGpuFeature(device.features, 'texture-compression-bc' as GPUFeatureName),
      etc2: hasGpuFeature(device.features, 'texture-compression-etc2' as GPUFeatureName),
      astc: hasGpuFeature(device.features, 'texture-compression-astc' as GPUFeatureName),
    }),
  });
}

function resolveSettings(
  requested: RenderProfileSettings,
  support: { indirectFirstInstance: boolean; timestampQuery: boolean },
): RenderProfileSettings {
  const indirect = requested.gpuDrivenIndirectDraws && support.indirectFirstInstance;
  return settings({
    ...requested,
    gpuDrivenDrawCommands: requested.gpuDrivenDrawCommands && indirect,
    gpuDrivenIndirectDraws: indirect,
    gpuDrivenCulling: requested.gpuDrivenCulling && indirect,
    gpuTimestampQuery: requested.gpuTimestampQuery && support.timestampQuery,
    gpuCullingReadback: requested.gpuCullingReadback && indirect,
  });
}

function resolveEnabledProfile(requested: RenderProfileName, resolved: RenderProfileSettings): RenderProfileName {
  if (requested === 'simple' || requested === 'batched') return requested;
  if (!resolved.gpuDrivenIndirectDraws) return 'batched';
  if (requested === 'diagnostic' && !resolved.gpuTimestampQuery) return 'gpu-driven';
  return requested;
}

function createCapabilityDecisions(
  requested: RenderProfileSettings,
  resolved: RenderProfileSettings,
  adapterFeatures: GPUSupportedFeatures,
  deviceFeatures: GPUSupportedFeatures,
): RenderCapabilityDecision[] {
  const entries: Array<{
    capability: RenderCapabilityName;
    requested: boolean;
    enabled: boolean;
    fallback?: string;
    unavailableReason?: string;
    notRequestedReason?: string;
  }> = [
    { capability: 'material-batching', requested: requested.materialBatching, enabled: resolved.materialBatching },
    { capability: 'frustum-culling', requested: requested.frustumCulling, enabled: resolved.frustumCulling },
    { capability: 'gpu-driven-batches', requested: requested.gpuDrivenBatches, enabled: resolved.gpuDrivenBatches },
    {
      capability: 'gpu-driven-draw-commands', requested: requested.gpuDrivenDrawCommands, enabled: resolved.gpuDrivenDrawCommands,
      fallback: 'material-batching', unavailableReason: 'indirect-first-instance is unavailable; using direct batched draws.',
    },
    {
      capability: 'gpu-driven-indirect-draws', requested: requested.gpuDrivenIndirectDraws, enabled: resolved.gpuDrivenIndirectDraws,
      fallback: 'material-batching', unavailableReason: 'indirect-first-instance is unavailable; using direct batched draws.',
    },
    {
      capability: 'gpu-driven-culling', requested: requested.gpuDrivenCulling, enabled: resolved.gpuDrivenCulling,
      fallback: 'frustum-culling', unavailableReason: 'indirect-first-instance is unavailable; using CPU frustum culling.',
    },
    {
      capability: 'gpu-timestamp-query', requested: requested.gpuTimestampQuery, enabled: resolved.gpuTimestampQuery,
      fallback: 'cpu-frame-timing', unavailableReason: 'timestamp-query is unavailable; using CPU frame timing.',
    },
    {
      capability: 'gpu-culling-readback', requested: requested.gpuCullingReadback, enabled: resolved.gpuCullingReadback,
      fallback: 'cpu-visible-count', unavailableReason: 'GPU indirect culling is unavailable; reporting CPU visible counts.',
    },
    textureDecision('texture-compression-bc', adapterFeatures, deviceFeatures, 'texture-compression-bc'),
    textureDecision('texture-compression-etc2', adapterFeatures, deviceFeatures, 'texture-compression-etc2'),
    textureDecision('texture-compression-astc', adapterFeatures, deviceFeatures, 'texture-compression-astc'),
  ];
  return entries.map(entry => Object.freeze({
    capability: entry.capability,
    requested: entry.requested,
    enabled: entry.enabled,
    fallback: entry.requested && !entry.enabled ? entry.fallback ?? null : null,
    reason: !entry.requested
      ? entry.notRequestedReason ?? 'Not requested by the selected RenderProfile.'
      : entry.enabled
        ? 'Requested and enabled.'
        : entry.unavailableReason ?? 'Requested capability is unavailable.',
  }));
}

function textureDecision(
  capability: RenderCapabilityName,
  adapterFeatures: GPUSupportedFeatures,
  deviceFeatures: GPUSupportedFeatures,
  feature: GPUFeatureName,
) {
  const requested = hasGpuFeature(adapterFeatures, feature);
  const enabled = requested && hasGpuFeature(deviceFeatures, feature);
  return {
    capability,
    requested,
    enabled,
    fallback: 'uncompressed-texture',
    notRequestedReason: `${feature} is unavailable on the adapter; uncompressed texture fallback remains enabled.`,
    unavailableReason: `${feature} is unavailable; transcoding or loading an uncompressed texture.`,
  };
}
