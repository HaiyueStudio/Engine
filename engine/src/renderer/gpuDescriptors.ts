export function createColorTargetState(
  format: GPUTextureFormat,
  blend?: GPUBlendState,
  writeMask?: GPUColorWriteFlags,
): GPUColorTargetState {
  return {
    format,
    ...(blend === undefined ? {} : { blend }),
    ...(writeMask === undefined ? {} : { writeMask }),
  };
}

export function createPrimitiveState(
  topology: GPUPrimitiveTopology,
  cullMode: GPUCullMode,
  frontFace: GPUFrontFace = 'ccw',
  stripIndexFormat?: GPUIndexFormat,
): GPUPrimitiveState {
  return {
    topology,
    cullMode,
    frontFace,
    ...(stripIndexFormat === undefined ? {} : { stripIndexFormat }),
  };
}
