import { GrayscalePass } from '/engine/dist/postprocess.js';
import { BUILTIN_POSTPROCESS_SHADER_ARTIFACT } from '/engine/dist/internal/postprocess-shader-artifact.js';
import { getPrecompiledShaderPassRuntime } from '/engine/dist/internal/precompiled-shader-runtime.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await runFixture();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
  });
  resultNode.dataset.status = 'failed';
}

async function runFixture() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  const counts = { shaderModules: 0, artifactLayouts: 0, pipelineLayouts: 0 };
  const trackedDevice = new Proxy(device, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'createShaderModule') return descriptor => {
        counts.shaderModules++;
        return target.createShaderModule(descriptor);
      };
      if (property === 'createBindGroupLayout') return descriptor => {
        counts.artifactLayouts++;
        return target.createBindGroupLayout(descriptor);
      };
      if (property === 'createPipelineLayout') return descriptor => {
        counts.pipelineLayouts++;
        return target.createPipelineLayout(descriptor);
      };
      return value.bind(target);
    },
  });

  const passIds = Object.keys(BUILTIN_POSTPROCESS_SHADER_ARTIFACT.passes);
  const compilationErrors = [];
  for (const [index, passId] of passIds.entries()) {
    progressNode.textContent = `stage8 ${index + 1}/${passIds.length} ${passId}: materializing artifact`;
    const runtime = getPrecompiledShaderPassRuntime(trackedDevice, BUILTIN_POSTPROCESS_SHADER_ARTIFACT, passId);
    progressNode.textContent = `stage8 ${index + 1}/${passIds.length} ${passId}: reading compilation info`;
    const info = await runtime.module.getCompilationInfo();
    for (const message of info.messages) {
      if (message.type === 'error') compilationErrors.push(`${passId}:${message.lineNum}:${message.linePos} ${message.message}`);
    }
    const targets = runtime.pass.renderTargets.map(() => ({ format: 'rgba8unorm' }));
    progressNode.textContent = `stage8 ${index + 1}/${passIds.length} ${passId}: creating render pipeline`;
    await trackedDevice.createRenderPipelineAsync({
      label: `shader-language-stage8-${passId}`,
      layout: runtime.pipelineLayout,
      vertex: { module: runtime.module, entryPoint: runtime.pass.entryPoints.vertex },
      fragment: { module: runtime.module, entryPoint: runtime.pass.entryPoints.fragment, targets },
      primitive: { topology: 'triangle-list' },
    });
    progressNode.textContent = `stage8 ${index + 1}/${passIds.length} ${passId}: complete`;
  }
  if (compilationErrors.length > 0) throw new Error(`Generated production WGSL failed:\n${compilationErrors.join('\n')}`);

  const width = 4;
  const height = 4;
  const source = trackedDevice.createTexture({
    label: 'stage8.source', size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const sourcePixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < sourcePixels.length; offset += 4) {
    sourcePixels.set([64, 128, 192, 255], offset);
  }
  trackedDevice.queue.writeTexture(
    { texture: source }, sourcePixels, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height],
  );
  const target = trackedDevice.createTexture({
    label: 'stage8.target', size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = 256;
  const readback = trackedDevice.createBuffer({
    label: 'stage8.readback', size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const grayscale = new GrayscalePass();
  grayscale.prepare(trackedDevice, 'rgba8unorm', width, height);
  const encoder = trackedDevice.createCommandEncoder();
  grayscale.apply(encoder, source, target.createView(), trackedDevice);
  encoder.copyTextureToBuffer(
    { texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height],
  );
  trackedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const centerOffset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
  const centerPixel = [...bytes.slice(centerOffset, centerOffset + 4)];
  readback.unmap();
  const expectedPixel = [119, 119, 119, 255];
  const pixelDelta = centerPixel.map((value, index) => Math.abs(value - expectedPixel[index]));
  if (pixelDelta.some(value => value > 1)) {
    throw new Error(`Unexpected production grayscale pixel ${centerPixel.join(',')}; expected ${expectedPixel.join(',')}.`);
  }
  if (counts.shaderModules !== passIds.length || counts.artifactLayouts !== passIds.length || counts.pipelineLayouts !== passIds.length) {
    throw new Error(`Production pass reused a handwritten GPU layout/module: ${JSON.stringify(counts)}.`);
  }

  grayscale.destroy();
  source.destroy();
  target.destroy();
  readback.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage8-builtin-postprocess',
    status: 'passed',
    artifactVersion: BUILTIN_POSTPROCESS_SHADER_ARTIFACT.version,
    compilerVersion: BUILTIN_POSTPROCESS_SHADER_ARTIFACT.compilerVersion,
    passCount: passIds.length,
    passIds,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    centerPixel,
    expectedPixel,
    pixelDelta,
    cache: counts,
  };
}
