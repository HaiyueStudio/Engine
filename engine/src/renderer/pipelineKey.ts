const TOPOLOGY_BITS: Record<GPUPrimitiveTopology, number> = {
  'point-list': 0,
  'line-list': 1,
  'line-strip': 2,
  'triangle-list': 3,
  'triangle-strip': 4,
};

const CULL_MODE_BITS: Record<GPUCullMode, number> = {
  none: 0,
  front: 1,
  back: 2,
};

const FRONT_FACE_BITS: Record<GPUFrontFace, number> = {
  ccw: 0,
  cw: 1,
};

const STRIP_INDEX_FORMAT_BITS: Record<GPUIndexFormat | 'none', number> = {
  none: 0,
  uint16: 1,
  uint32: 2,
};

const COMPARE_BITS: Record<GPUCompareFunction, number> = {
  never: 0,
  less: 1,
  equal: 2,
  'less-equal': 3,
  greater: 4,
  'not-equal': 5,
  'greater-equal': 6,
  always: 7,
};

export function encodePrimitivePipelineKey(
  topology: GPUPrimitiveTopology,
  cullMode: GPUCullMode,
  frontFace: GPUFrontFace,
  stripIndexFormat: GPUIndexFormat | undefined,
  reverseZ: boolean,
  msaaSamples: number,
  flags = 0,
): number {
  return TOPOLOGY_BITS[topology]
    | (CULL_MODE_BITS[cullMode] << 3)
    | (FRONT_FACE_BITS[frontFace] << 5)
    | (STRIP_INDEX_FORMAT_BITS[stripIndexFormat ?? 'none'] << 6)
    | ((reverseZ ? 1 : 0) << 8)
    | ((msaaSamples > 1 ? 1 : 0) << 9)
    | (flags << 10);
}

export function encodeCompare(compare: GPUCompareFunction): number {
  return COMPARE_BITS[compare];
}

/** Keeps the exact composed shader feature set visible in renderer pipeline caches. */
export function encodeShaderPipelineKey(baseKey: string | number, featureSetKey: string): string {
  return `${baseKey}|shader:${featureSetKey}`;
}
