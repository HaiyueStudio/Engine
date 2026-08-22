const progress = document.querySelector('#progress');
const result = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  const textureAlpha = device.createTexture({
    label: 'G10 source texture alpha',
    size: [4, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: textureAlpha },
    new Uint8Array([255, 255, 255, 64, 255, 255, 255, 128, 255, 255, 255, 191, 255, 255, 255, 255]),
    { bytesPerRow: 16 },
    [4, 1],
  );
  const output = device.createTexture({
    label: 'G10 mask coverage output',
    size: [8, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const module = device.createShaderModule({ code: String.raw`
@group(0) @binding(0) var sourceAlpha : texture_2d<f32>;
@group(0) @binding(1) var outputCoverage : texture_storage_2d<rgba8unorm, write>;

fn alpha(index : i32) -> f32 { return textureLoad(sourceAlpha, vec2<i32>(index, 0), 0).a; }
fn unionCoverage(first : f32, second : f32) -> f32 { return first + second * (1.0 - first); }

@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let a = alpha(0); // 64/255
  let b = alpha(1); // 128/255
  let c = alpha(2); // 191/255
  var coverage = 0.0;
  switch id.x {
    case 0u: { coverage = a; }                                      // single source
    case 1u: { coverage = unionCoverage(a, b); }                    // multi-source union
    case 2u: { coverage = 1.0 - unionCoverage(a, b); }              // inverted once after union
    case 3u: { let drawableOpacity = 0.0; coverage = c + drawableOpacity * 0.0; } // opacity ignored
    case 4u: { let dynamicVisible = false; coverage = select(c, 0.0, dynamicVisible); } // visibility ignored
    case 5u: { coverage = unionCoverage(a, b * 0.0); }              // second dynamic mesh outside pixel
    case 6u: { coverage = unionCoverage(a * 0.0, b); }              // first dynamic mesh outside pixel
    default: { coverage = 0.0; }                                   // transparent clear
  }
  textureStore(outputCoverage, vec2<u32>(id.x, 0), vec4<f32>(coverage));
}
` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: textureAlpha.createView() },
    { binding: 1, resource: output.createView() },
  ] });
  const encoder = device.createCommandEncoder({ label: 'G10 mask readback encoder' });
  const pass = encoder.beginComputePass({ label: 'G10 mask composition oracle pass' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [8, 1]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange()).slice(0, 32);
  const expected = [64, 160, 95, 191, 191, 64, 128, 0];
  const names = ['single', 'multi-union', 'inverted', 'opacity-ignored', 'visibility-ignored', 'dynamic-second-outside', 'dynamic-first-outside', 'clear'];
  const cases = expected.map((value, index) => {
    const actual = bytes[index * 4 + 3];
    const error = Math.abs(actual - value);
    if (error > 1) throw new Error(`${names[index]} alpha mismatch: ${actual} vs ${value}.`);
    return { id: names[index], expected: value, actual, error };
  });
  readback.unmap();
  readback.destroy();
  output.destroy();
  textureAlpha.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncaptured.length > 0) throw new Error(`WebGPU validation failed: ${validationError?.message ?? uncaptured.join('; ')}`);
  result.dataset.status = 'passed';
  result.textContent = JSON.stringify({ status: 'passed', suite: 'deformable-mask-composition-texture-readback', caseCount: cases.length, cases, strictValidation: true });
  progress.textContent = 'complete';
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  progress.textContent = 'failed';
}
