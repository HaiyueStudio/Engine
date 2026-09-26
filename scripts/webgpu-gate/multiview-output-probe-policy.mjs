export const OUTPUT_PROBE_VARIANTS = ['original', 'explicit-state', 'arithmetic-vertex', 'vertex-buffer'];

export function parseOutputProbeOptions(args) {
  const options = { preference: 'high-performance', variant: 'original', frames: 512 };
  const seen = new Set();
  for (const arg of args) {
    const [key, value] = arg.split('=');
    if (seen.has(key)) throw new Error(`Duplicate output probe option: ${key}`);
    seen.add(key);
    if (arg === '--integrated') options.preference = 'low-power';
    else if (key === '--variant' && OUTPUT_PROBE_VARIANTS.includes(value) && arg === `${key}=${value}`) options.variant = value;
    else if (key === '--frames' && arg === `${key}=${value}` && /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 16384) options.frames = Number(value);
    else throw new Error(`Unknown or invalid output probe option: ${arg}`);
  }
  return options;
}

/** Diagnostic alternatives only: never rewrite the generated production shader. */
export function outputProbeShader(source, variant) {
  if (!OUTPUT_PROBE_VARIANTS.includes(variant)) throw new Error(`Unknown output variant: ${variant}`);
  if (variant === 'original' || variant === 'explicit-state') return source;
  const start = source.indexOf('@vertex');
  const end = source.indexOf('struct OutputParams');
  if (start < 0 || end <= start) throw new Error('Unrecognized output vertex shader');
  const vertex = variant === 'vertex-buffer' ? `
@vertex fn vs_main(@location(0) position : vec2<f32>, @location(1) uv : vec2<f32>) -> VertexOutput {
  var output : VertexOutput;
  output.pos = vec4<f32>(position, 0.0, 1.0);
  output.uv = uv;
  return output;
}
` : `
@vertex fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output : VertexOutput;
  output.pos = vec4<f32>(uv * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
  output.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return output;
}
`;
  return source.slice(0, start) + vertex + source.slice(end);
}

/** A completed diagnostic must include every requested case on a native adapter. */
export function validateOutputProbeEvidence(result, options, shaderSha256) {
  if (result.status !== 'passed' || result.schemaVersion !== 1) throw new Error('Output probe did not pass its schema.');
  if (result.variant !== options.variant || result.requestedFrames !== options.frames || result.shaderSha256 !== shaderSha256) {
    throw new Error('Output probe workload or shader provenance mismatch.');
  }
  if (result.adapter?.isFallbackAdapter !== false || !result.adapter.vendor || !result.adapter.architecture) {
    throw new Error('Output probe requires an identified native adapter.');
  }
  if (result.failure !== null || !Array.isArray(result.validationErrors) || result.validationErrors.length) {
    throw new Error('Output probe has missing or failed pixel/validation diagnostics.');
  }
  const expected = ['clear-only', 'shared-hdr', 'isolated-hdr'].map(mode => ({ mode, completedFrames: options.frames }));
  if (JSON.stringify(result.cases) !== JSON.stringify(expected)) throw new Error('Output probe case matrix is incomplete.');
}
