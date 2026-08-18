export const AO_COST_RESOLUTIONS = Object.freeze([
  Object.freeze({ id: '720p', width: 1280, height: 720 }),
  Object.freeze({ id: '1080p', width: 1920, height: 1080 }),
  Object.freeze({ id: '4k', width: 3840, height: 2160 }),
]);

export const AO_COST_QUALITIES = Object.freeze([
  Object.freeze({ id: 'low', sampleCount: 8 }),
  Object.freeze({ id: 'medium', sampleCount: 16 }),
  Object.freeze({ id: 'high', sampleCount: 32 }),
]);

export const AO_COST_SCRATCH_FORMATS = Object.freeze([
  Object.freeze({
    id: 'r8unorm',
    bytesPerPixel: 1,
    crossDeviceRisk: 'lower',
    rationale: 'core normalized render target; no optional float filtering capability is required',
  }),
  Object.freeze({
    id: 'r16float',
    bytesPerPixel: 2,
    crossDeviceRisk: 'higher',
    rationale: 'core render target, but half-float throughput and driver behavior are less uniform; sampled with textureLoad',
  }),
]);

const LEGACY_SCRATCH_BYTES_PER_PIXEL = 8;
const DEPTH_BYTES_PER_TEXEL = 4;
const NORMAL_BYTES_PER_TEXEL = 8;
const COLOR_BYTES_PER_TEXEL = 4;
const DENOISE_TAP_COUNT = 16;
const UPSCALE_CANDIDATE_COUNT = 4;

export function createAoCostMatrix() {
  const cases = [];
  for (const resolution of AO_COST_RESOLUTIONS) {
    for (const quality of AO_COST_QUALITIES) {
      for (const scratchFormat of AO_COST_SCRATCH_FORMATS) {
        cases.push(createAoCostCase({ resolution, quality, scratchFormat }));
      }
    }
  }
  return Object.freeze(cases);
}

export function createAoCostCase({
  resolution,
  quality,
  scratchFormat,
  resolutionScale = 0.5,
}) {
  const resolvedResolution = resolveEntry(AO_COST_RESOLUTIONS, resolution, 'resolution');
  const resolvedQuality = resolveEntry(AO_COST_QUALITIES, quality, 'quality');
  const resolvedFormat = resolveEntry(AO_COST_SCRATCH_FORMATS, scratchFormat, 'scratch format');
  if (resolutionScale !== 0.5 && resolutionScale !== 1) {
    throw new RangeError(`AO resolutionScale must be 0.5 or 1; received ${resolutionScale}.`);
  }
  const width = resolvedResolution.width;
  const height = resolvedResolution.height;
  const scratchWidth = Math.max(1, Math.ceil(width * resolutionScale));
  const scratchHeight = Math.max(1, Math.ceil(height * resolutionScale));
  const outputPixels = width * height;
  const scratchPixels = scratchWidth * scratchHeight;
  const scratchBytesPerPixel = resolvedFormat.bytesPerPixel;
  const rawTextureBytes = scratchPixels * scratchBytesPerPixel;
  const denoisedTextureBytes = rawTextureBytes;
  const legacyRawTextureBytes = outputPixels * LEGACY_SCRATCH_BYTES_PER_PIXEL;
  const aoProbeCount = gtaoProbeCount(resolvedQuality.sampleCount);
  const bandwidth = Object.freeze({
    occlusion: phaseBandwidth(
      scratchPixels * ((aoProbeCount + 1) * DEPTH_BYTES_PER_TEXEL + NORMAL_BYTES_PER_TEXEL),
      rawTextureBytes,
    ),
    denoise: phaseBandwidth(
      scratchPixels * (DENOISE_TAP_COUNT + 1)
        * (DEPTH_BYTES_PER_TEXEL + NORMAL_BYTES_PER_TEXEL + scratchBytesPerPixel),
      denoisedTextureBytes,
    ),
    upscale: phaseBandwidth(
      outputPixels * (
        COLOR_BYTES_PER_TEXEL + DEPTH_BYTES_PER_TEXEL + NORMAL_BYTES_PER_TEXEL
        + UPSCALE_CANDIDATE_COUNT * (scratchBytesPerPixel + DEPTH_BYTES_PER_TEXEL + NORMAL_BYTES_PER_TEXEL)
      ),
      outputPixels * COLOR_BYTES_PER_TEXEL,
    ),
  });
  const totalReadBytes = bandwidth.occlusion.readBytes + bandwidth.denoise.readBytes + bandwidth.upscale.readBytes;
  const totalWriteBytes = bandwidth.occlusion.writeBytes + bandwidth.denoise.writeBytes + bandwidth.upscale.writeBytes;
  return Object.freeze({
    id: `${resolvedResolution.id}.${resolvedQuality.id}.${resolvedFormat.id}`,
    resolution: resolvedResolution,
    quality: resolvedQuality,
    scratchFormat: resolvedFormat,
    resolutionScale,
    aoProbeCount,
    scratch: Object.freeze({
      width: scratchWidth,
      height: scratchHeight,
      rawTextureBytes,
      denoisedTextureBytes,
      totalBytes: rawTextureBytes + denoisedTextureBytes,
      legacyRawTextureBytes,
      rawTextureReduction: legacyRawTextureBytes / rawTextureBytes,
      totalScratchReduction: legacyRawTextureBytes / (rawTextureBytes + denoisedTextureBytes),
    }),
    estimatedBandwidth: Object.freeze({
      ...bandwidth,
      totalReadBytes,
      totalWriteBytes,
      totalBytes: totalReadBytes + totalWriteBytes,
      model: 'logical shader bytes; excludes caches, compression, attachment tiling, and transaction granularity',
    }),
  });
}

function gtaoProbeCount(sampleCount) {
  const directionCount = sampleCount >= 30 ? 5 : 3;
  return directionCount * Math.ceil(sampleCount / directionCount) * 2;
}

function phaseBandwidth(readBytes, writeBytes) {
  return Object.freeze({ readBytes, writeBytes, totalBytes: readBytes + writeBytes });
}

function resolveEntry(entries, value, label) {
  const id = typeof value === 'string' ? value : value?.id;
  const resolved = entries.find(entry => entry.id === id);
  if (!resolved) throw new RangeError(`Unknown AO ${label} ${String(id)}.`);
  return resolved;
}
