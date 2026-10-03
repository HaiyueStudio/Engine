/** Diagnostics retain black frames as failures, including failures in the old production oracle. */
export function parseFrameGraphBlackFrameOptions(args) {
  if (args.length === 0) return { coverage: 'production' };
  if (args.length === 1 && args[0] === '--readback=atomic') return { coverage: 'production', readback: 'atomic' };
  if (args.length === 1 && ['--coverage=after-pipeline', '--coverage=arithmetic-chain'].includes(args[0])) return { coverage: args[0].split('=')[1] };
  throw Error('Expected no options, --readback=atomic, or --coverage=after-pipeline|arithmetic-chain (diagnostic only)');
}

/** Diagnostic module substitution only; generated production artifacts stay intact. */
export function arithmeticPostprocessProbe(source) {
  if (!source.startsWith('// haiyue:builtin-postprocess ') || !source.includes('positions[vertexIndex]')) return source;
  const start = source.indexOf('@vertex'), end = source.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw Error('Unrecognized builtin fullscreen vertex stage');
  return source.slice(0, start) + `@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var output : VertexOutput;
  output.pos = vec4<f32>(uv * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
  output.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return output;
}` + source.slice(end);
}

export function classifyFrameGraphBlackFrame(r) {
  const check = (v, m) => { if (!v) throw Error(m); };
  check(r?.schemaVersion === 1 && r.status === 'passed' && r.scope === 'black-frame-attribution-only', 'Incomplete probe');
  check(!r.deviceLoss, 'GPU device lost during probe');
  check(r.adapter?.isFallbackAdapter === false && r.adapter.vendor && r.adapter.architecture, 'Native probe required');
  check(r.width === 64 && r.height === 64 && r.warmup === 4 && r.frames === 1, 'Probe population changed');
  check(r.validationErrors?.length === 0 && r.cleanup?.ownerResidual === 0 && r.cleanup?.liveGpuResources === 0, 'Probe errors/residue');
  const pixels = values => {
    check(Array.isArray(values) && values.length === 64 * 64 * 4 && values.every(Number.isFinite), 'Missing/nonfinite pixels');
    let rgbMax = 0, alphaMin = Infinity, alphaMax = 0, coveredPixels = 0, sentinelPixels = 0, coloredPixels = 0;
    for (let i = 0; i < values.length; i += 4) {
      if (values[i] === 1 && values[i + 1] === 0 && values[i + 2] === 1 && values[i + 3] === 0) sentinelPixels++;
      if (values[i] > 0 || values[i + 1] > 0 || values[i + 2] > 0) coloredPixels++;
    }
    for (let i = 0; i < values.length; i++) {
      if (i % 4 === 3) { alphaMin = Math.min(alphaMin, values[i]); alphaMax = Math.max(alphaMax, values[i]); if (values[i] >= 1 - 1 / 255) coveredPixels++; }
      else rgbMax = Math.max(rgbMax, values[i]);
    }
    return { rgbMax, alphaMin, alphaMax, coveredPixels, sentinelPixels, coloredPixels, lit: rgbMax > .1 && coveredPixels === 4096 };
  };
  const computed = pixels(r.computed), copied = r.copySource ? pixels(r.copied) : null;
  const delta = copied ? Math.max(...r.computed.map((v, i) => Math.abs(v - r.copied[i]))) : null;
  const witnessValid = r.readbackWitness === undefined ? null : JSON.stringify(r.readbackWitness) === '[4660,64,64,22136,4660,64,64,22136]';
  return { status: witnessValid !== false && computed.lit && (!copied || copied.lit && delta <= 1 / 255) ? 'passed' : 'failed', witnessValid,
    computed, copied, source: r.sourcePixels ? pixels(r.sourcePixels) : null, maxReadbackDelta: delta, performanceQualified: false };
}

export function compareFrameGraphProbePixels(before, after) {
  if (before?.length !== 16384 || after?.length !== 16384 || !before.every(Number.isFinite) || !after.every(Number.isFinite)) throw Error('Missing paired probe pixels');
  let maxDelta = 0, changedComponents = 0;
  for (let i = 0; i < before.length; i++) {
    const delta = Math.abs(before[i] - after[i]); maxDelta = Math.max(maxDelta, delta);
    if (delta > 1 / 255) changedComponents++;
  }
  return { status: maxDelta <= 1 / 255 ? 'passed' : 'failed', maxDelta, changedComponents };
}
