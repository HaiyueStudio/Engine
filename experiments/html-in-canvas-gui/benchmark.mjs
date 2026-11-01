const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'native' ? 'native' : 'html';
const widgetCount = positiveInteger(params.get('widgets'), 256);
const updateRatio = boundedNumber(params.get('updateRatio'), 0.1, 0, 1);
const warmupFrames = positiveInteger(params.get('warmup'), 30);
const sampleFrames = positiveInteger(params.get('frames'), 120);
const queueProbeFrames = nonNegativeInteger(params.get('queueProbes'), 8);
const width = positiveInteger(params.get('width'), 1280);
const height = positiveInteger(params.get('height'), 720);
const canvas = document.querySelector('#stage');
const domRoot = document.querySelector('#dom-root');
const resultNode = document.querySelector('#result');

canvas.width = width;
canvas.height = height;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;
domRoot.style.width = `${width}px`;
domRoot.style.height = `${height}px`;

window.__benchmarkReady = Object.freeze({ mode, widgetCount, updateRatio, warmupFrames, sampleFrames });
window.__runGuiBenchmark = runBenchmark;

async function runBenchmark() {
  if (resultNode.dataset.status === 'running') return;
  resultNode.dataset.status = 'running';
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('A WebGPU high-performance adapter is required.');
    const timestampQuery = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timestampQuery ? ['timestamp-query'] : [] });
    const uncapturedErrors = [];
    device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
    device.pushErrorScope('validation');
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not acquire a WebGPU canvas context.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });

    const memoryBeforeSetup = await memorySnapshot();
    const setupStartedAt = performance.now();
    const scenario = mode === 'html'
      ? await createHtmlScenario({ device, context, format })
      : await createNativeScenario({ device, context, format });
    const setupMs = performance.now() - setupStartedAt;

    for (let frame = 0; frame < warmupFrames; frame++) await executeFrame(scenario, frame, null);
    await device.queue.onSubmittedWorkDone();
    const memoryAfterSetup = await memorySnapshot();

    const querySet = timestampQuery
      ? device.createQuerySet({ type: 'timestamp', count: sampleFrames * 2 })
      : null;
    scenario.setTimestampQuery(querySet);
    const frameRecords = [];
    for (let frame = 0; frame < sampleFrames; frame++) {
      frameRecords.push(await executeFrame(scenario, warmupFrames + frame, frame));
    }
    await device.queue.onSubmittedWorkDone();
    const gpuFrameMs = querySet
      ? await resolveTimestampQueries(device, querySet, sampleFrames)
      : [];

    scenario.setTimestampQuery(null);
    const queueCompletionMs = [];
    for (let frame = 0; frame < queueProbeFrames; frame++) {
      const startedAt = performance.now();
      await executeFrame(scenario, warmupFrames + sampleFrames + frame, null);
      await device.queue.onSubmittedWorkDone();
      queueCompletionMs.push(performance.now() - startedAt);
    }
    const memoryAfterRun = await memorySnapshot(false);
    const resourceMetrics = scenario.resourceMetrics();
    const scenarioMetrics = scenario.metrics();
    const validationError = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    scenario.destroy();
    context.unconfigure();
    device.destroy();
    await nextTask();
    const memoryAfterTeardown = await memorySnapshot(false);

    const frameIntervals = frameRecords.slice(1).map((record, index) => record.rafTimestamp - frameRecords[index].rafTimestamp);
    const frameWindowMs = frameRecords.length > 1
      ? frameRecords.at(-1).rafTimestamp - frameRecords[0].rafTimestamp
      : 0;
    const artifact = {
      schemaVersion: 1,
      status: validationError || uncapturedErrors.length ? 'failed' : 'passed',
      generatedAt: new Date().toISOString(),
      mode,
      browser: navigator.userAgent,
      crossOriginIsolated,
      adapter: plainAdapterInfo(adapter.info),
      configuration: { widgetCount, updateRatio, warmupFrames, sampleFrames, queueProbeFrames, width, height },
      support: {
        htmlInCanvas: htmlInCanvasSupport(),
        timestampQuery,
        userAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
      },
      timing: {
        setupMs,
        effectiveFps: frameWindowMs > 0 ? (frameRecords.length - 1) * 1000 / frameWindowMs : null,
        frameIntervalMs: summarize(frameIntervals),
        missedFrameRatio: frameIntervals.length
          ? frameIntervals.filter(value => value > 20.84).length / frameIntervals.length
          : 0,
        updateCpuMs: summarize(frameRecords.map(record => record.updateCpuMs)),
        layoutOrUploadCpuMs: summarize(frameRecords.map(record => record.layoutOrUploadCpuMs)),
        encodeSubmitCpuMs: summarize(frameRecords.map(record => record.encodeSubmitCpuMs)),
        callbackCpuMs: summarize(frameRecords.map(record => record.callbackCpuMs)),
        gpuRenderPassMs: gpuFrameMs.length ? summarize(gpuFrameMs) : null,
        endToEndQueueCompletionMs: summarize(queueCompletionMs),
      },
      memory: {
        beforeSetup: memoryBeforeSetup,
        afterSetup: memoryAfterSetup,
        afterRun: memoryAfterRun,
        afterTeardown: memoryAfterTeardown,
        setupUaBytesDelta: memoryDelta(memoryBeforeSetup, memoryAfterSetup, 'uaBytes'),
        setupJsHeapBytesDelta: memoryDelta(memoryBeforeSetup, memoryAfterSetup, 'jsHeapUsedBytes'),
        retainedUaBytesDelta: memoryDelta(memoryBeforeSetup, memoryAfterTeardown, 'uaBytes'),
      },
      resources: resourceMetrics,
      scenario: scenarioMetrics,
      validation: {
        scopedError: validationError?.message ?? null,
        uncapturedErrors,
      },
    };
    if (artifact.status !== 'passed') throw new Error(JSON.stringify(artifact.validation));
    resultNode.textContent = JSON.stringify(artifact);
    resultNode.dataset.status = 'passed';
    return artifact;
  } catch (error) {
    const failure = { status: 'failed', mode, error: String(error?.stack ?? error) };
    resultNode.textContent = JSON.stringify(failure);
    resultNode.dataset.status = 'failed';
    throw error;
  }
}

async function executeFrame(scenario, frame, queryIndex) {
  const rafTimestamp = await nextAnimationFrame();
  const updateStartedAt = performance.now();
  scenario.mutate(frame, updateRatio);
  const updateCpuMs = performance.now() - updateStartedAt;
  const render = await scenario.render(queryIndex);
  return { rafTimestamp, updateCpuMs, ...render };
}

async function createHtmlScenario({ device, context, format }) {
  const support = htmlInCanvasSupport();
  if (!support.supported) throw new Error(`HTML-in-Canvas is unavailable: ${JSON.stringify(support)}`);
  const columns = gridColumns(widgetCount, width, height);
  const rows = Math.ceil(widgetCount / columns);
  domRoot.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  domRoot.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  const labels = [];
  const fills = [];
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < widgetCount; index++) {
    const item = document.createElement('div');
    item.className = 'gui-item';
    const label = document.createElement('span');
    label.className = 'gui-label';
    label.textContent = `GUI ${index % 10_000}`;
    const track = document.createElement('span');
    track.className = 'gui-track';
    const fill = document.createElement('i');
    fill.className = 'gui-fill';
    fill.style.transform = `scaleX(${(index % 100) / 100})`;
    track.append(fill);
    item.append(label, track);
    fragment.append(item);
    labels.push(label);
    fills.push(fill);
  }
  domRoot.replaceChildren(fragment);

  const htmlTexture = device.createTexture({
    label: 'HTML-in-Canvas GUI texture',
    size: { width, height },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const shader = device.createShaderModule({ code: `
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
      var p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
      return vec4f(p[i],0.0,1.0);
    }
    @group(0) @binding(0) var uiSampler:sampler;
    @group(0) @binding(1) var uiTexture:texture_2d<f32>;
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
      let uv=vec2f(p.x/${width}.0,p.y/${height}.0);
      return textureSample(uiTexture,uiSampler,uv);
    }
  ` });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs' },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: htmlTexture.createView() },
    ],
  });
  let timestampQuery = null;
  let pendingPaint = null;
  let paintEvents = 0;
  let changedElementsTotal = 0;
  let geometrySynchronized = false;
  let textureUploads = 0;
  const submitFrame = (queryIndex, layoutOrUploadCpuMs, callbackStartedAt) => {
    const encodeStartedAt = performance.now();
    const encoder = device.createCommandEncoder({ label: 'HTML-in-Canvas GUI frame' });
    const descriptor = {
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.027, g: 0.067, b: 0.118, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      ...(timestampQuery && queryIndex !== null ? {
        timestampWrites: {
          querySet: timestampQuery,
          beginningOfPassWriteIndex: queryIndex * 2,
          endOfPassWriteIndex: queryIndex * 2 + 1,
        },
      } : {}),
    };
    const pass = encoder.beginRenderPass(descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const encodeSubmitCpuMs = performance.now() - encodeStartedAt;
    return {
      layoutOrUploadCpuMs,
      encodeSubmitCpuMs,
      callbackCpuMs: performance.now() - callbackStartedAt,
    };
  };
  const onPaint = event => {
    paintEvents++;
    changedElementsTotal += event.changedElements?.length ?? 0;
    const pending = pendingPaint;
    if (!pending) return;
    pendingPaint = null;
    try {
      const callbackStartedAt = performance.now();
      const uploadStartedAt = performance.now();
      device.queue.drawElementImageToTexture(
        { source: domRoot },
        { texture: htmlTexture, size: { width, height } },
      );
      textureUploads++;
      const layoutOrUploadCpuMs = performance.now() - uploadStartedAt;
      if (!geometrySynchronized) {
        canvas.updateElementGeometry(domRoot, { canvasTransform: new DOMMatrix() });
        geometrySynchronized = true;
      }
      pending.resolve(submitFrame(pending.queryIndex, layoutOrUploadCpuMs, callbackStartedAt));
    } catch (error) {
      pending.reject(error);
    }
  };
  canvas.addEventListener('paint', onPaint);

  return {
    mutate(frame, ratio) {
      mutateRange(widgetCount, ratio, frame, index => {
        labels[index].textContent = `GUI ${(index + frame) % 10_000}`;
        fills[index].style.transform = `scaleX(${((index * 13 + frame * 7) % 101) / 100})`;
      });
    },
    render(queryIndex) {
      if (updateRatio === 0 && geometrySynchronized) {
        const callbackStartedAt = performance.now();
        return Promise.resolve(submitFrame(queryIndex, 0, callbackStartedAt));
      }
      if (pendingPaint) throw new Error('HTML paint requests must not overlap.');
      return new Promise((resolve, reject) => {
        pendingPaint = { resolve, reject, queryIndex };
        canvas.requestPaint();
      });
    },
    setTimestampQuery(value) { timestampQuery = value; },
    resourceMetrics() {
      return {
        explicitGpuTextureBytes: width * height * 4,
        retainedCpuGeometryBytes: 0,
        domElementCount: domRoot.querySelectorAll('*').length + 1,
      };
    },
    metrics() {
      return {
        paintEvents,
        changedElementsTotal,
        drawCallsPerFrame: 1,
        textureUploads,
        htmlTextureUploadsPerFrame: textureUploads / (warmupFrames + sampleFrames + queueProbeFrames),
      };
    },
    destroy() {
      canvas.removeEventListener('paint', onPaint);
      htmlTexture.destroy();
      domRoot.replaceChildren();
    },
  };
}

async function createNativeScenario({ device, context, format }) {
  domRoot.remove();
  const { GuiElement, GuiLabel, GuiProgress, GuiRenderer, GuiRoot } = await import('/engine/dist/gui.js');
  const columns = gridColumns(widgetCount, width, height);
  const rows = Math.ceil(widgetCount / columns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const fontSize = Math.max(6, Math.min(12, Math.floor(cellHeight * 0.36)));
  const root = new GuiRoot({
    style: { backgroundColor: '#07111e', radius: 0 },
    theme: { fontSize, radius: 2, colors: { primary: '#64c7ff', surface: '#10233d', border: '#446487' } },
  });
  const labels = [];
  const progress = [];
  for (let index = 0; index < widgetCount; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const card = root.add(new GuiElement({
      x: column * cellWidth + 1,
      y: row * cellHeight + 1,
      width: Math.max(1, cellWidth - 2),
      height: Math.max(1, cellHeight - 2),
      pointerFilter: 'ignore',
      style: { backgroundColor: '#10233d', borderColor: '#446487', radius: 2 },
    }));
    labels.push(card.add(new GuiLabel({
      x: 2,
      y: 1,
      width: Math.max(1, cellWidth - 6),
      height: Math.max(1, cellHeight - 7),
      text: `GUI ${index % 10_000}`,
      fontSize,
      style: { color: '#dcecff' },
    })));
    progress.push(card.add(new GuiProgress({
      x: 2,
      y: Math.max(1, cellHeight - 7),
      width: Math.max(1, cellWidth - 6),
      height: 3,
      value: index % 100,
      min: 0,
      max: 100,
      showText: false,
    })));
  }
  const renderer = new GuiRenderer({
    chars: 'GUI 0123456789%',
    fontSize: Math.max(12, fontSize),
    atlasSize: 256,
  });
  const engine = {
    device,
    format,
    displayWidth: width,
    displayHeight: height,
    reverseZ: false,
    msaaSamples: 1,
    getDepthFormat: () => 'depth24plus',
  };
  const depth = device.createTexture({
    label: 'Haiyue GUI benchmark depth',
    size: { width, height },
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  root.layout(width, height);
  let timestampQuery = null;
  let rebuildFrames = 0;

  return {
    mutate(frame, ratio) {
      mutateRange(widgetCount, ratio, frame, index => {
        labels[index].setText(`GUI ${(index + frame) % 10_000}`);
        progress[index].setValue((index * 13 + frame * 7) % 101);
      });
    },
    async render(queryIndex) {
      const callbackStartedAt = performance.now();
      const layoutStartedAt = performance.now();
      const wasDirty = root.dirty;
      root.layout(width, height);
      const layoutOrUploadCpuMs = performance.now() - layoutStartedAt;
      if (wasDirty) rebuildFrames++;
      const encodeStartedAt = performance.now();
      const encoder = device.createCommandEncoder({ label: 'Haiyue native GUI frame' });
      const descriptor = {
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.027, g: 0.067, b: 0.118, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
        ...(timestampQuery && queryIndex !== null ? {
          timestampWrites: {
            querySet: timestampQuery,
            beginningOfPassWriteIndex: queryIndex * 2,
            endOfPassWriteIndex: queryIndex * 2 + 1,
          },
        } : {}),
      };
      const pass = encoder.beginRenderPass(descriptor);
      renderer.render(pass, [root], engine, false, 1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      root.clearDirty();
      const encodeSubmitCpuMs = performance.now() - encodeStartedAt;
      return {
        layoutOrUploadCpuMs,
        encodeSubmitCpuMs,
        callbackCpuMs: performance.now() - callbackStartedAt,
      };
    },
    setTimestampQuery(value) { timestampQuery = value; },
    resourceMetrics() {
      let retainedCpuGeometryBytes = 0;
      for (const cache of renderer.rootCaches?.values?.() ?? []) {
        for (const key of ['batch', 'textBatch', 'popupBatch', 'popupTextBatch', 'modalBatch', 'modalTextBatch']) {
          retainedCpuGeometryBytes += cache[key]?.vertexData?.byteLength ?? 0;
        }
      }
      return {
        explicitGpuTextureBytes: width * height * 4,
        retainedCpuGeometryBytes,
        guiElementCount: 1 + widgetCount * 3,
      };
    },
    metrics() { return { rebuildFrames, drawCallsPerFrame: 2, htmlTextureUploadsPerFrame: 0 }; },
    destroy() {
      renderer.destroy();
      root.destroy();
      depth.destroy();
    },
  };
}

function htmlInCanvasSupport() {
  return {
    supported: typeof canvas.requestPaint === 'function'
      && typeof canvas.updateElementGeometry === 'function'
      && typeof deviceQueuePrototypeMethod('drawElementImageToTexture') === 'function',
    requestPaint: typeof canvas.requestPaint,
    updateElementGeometry: typeof canvas.updateElementGeometry,
    drawElementImageToTexture: typeof deviceQueuePrototypeMethod('drawElementImageToTexture'),
  };
}

function deviceQueuePrototypeMethod(name) {
  return globalThis.GPUQueue?.prototype?.[name] ?? null;
}

async function resolveTimestampQueries(device, querySet, frameCount) {
  const byteLength = frameCount * 16;
  const resolveBuffer = device.createBuffer({
    label: 'GUI timestamp resolve',
    size: byteLength,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    label: 'GUI timestamp readback',
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.resolveQuerySet(querySet, 0, frameCount * 2, resolveBuffer, 0);
  encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(GPUMapMode.READ);
  const timestamps = new BigUint64Array(readBuffer.getMappedRange()).slice();
  const durations = [];
  for (let index = 0; index < frameCount; index++) {
    durations.push(Number(timestamps[index * 2 + 1] - timestamps[index * 2]) / 1_000_000);
  }
  readBuffer.unmap();
  readBuffer.destroy();
  resolveBuffer.destroy();
  querySet.destroy();
  return durations;
}

async function memorySnapshot(includeUaMemory = true) {
  globalThis.gc?.();
  await nextTask();
  let uaBytes = null;
  let breakdown = null;
  if (includeUaMemory && typeof performance.measureUserAgentSpecificMemory === 'function') {
    try {
      const measured = await performance.measureUserAgentSpecificMemory();
      uaBytes = measured.bytes;
      breakdown = measured.breakdown?.map(item => ({ bytes: item.bytes, types: item.types })) ?? null;
    } catch (error) {
      breakdown = [{ error: String(error) }];
    }
  }
  return {
    uaBytes,
    jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    jsHeapTotalBytes: performance.memory?.totalJSHeapSize ?? null,
    breakdown,
  };
}

function memoryDelta(before, after, key) {
  return Number.isFinite(before?.[key]) && Number.isFinite(after?.[key]) ? after[key] - before[key] : null;
}

function mutateRange(count, ratio, frame, callback) {
  if (ratio <= 0) return;
  const changed = Math.max(1, Math.floor(count * ratio));
  const start = (frame * changed) % count;
  for (let offset = 0; offset < changed; offset++) callback((start + offset) % count);
}

function gridColumns(count, viewportWidth, viewportHeight) {
  return Math.max(1, Math.ceil(Math.sqrt(count * viewportWidth / viewportHeight)));
}

function summarize(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return { samples: 0, min: null, mean: null, p50: null, p95: null, max: null };
  return {
    samples: finite.length,
    min: finite[0],
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.at(-1),
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function plainAdapterInfo(info) {
  if (!info) return {};
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
  };
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function nextTask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
