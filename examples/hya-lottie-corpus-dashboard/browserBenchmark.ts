import { parseAnimation } from '@haiyue/animation-spec';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import type {
  BrowserBenchmarkResult,
  BrowserDeliveryMetric,
  BrowserInput,
  BrowserInputSample,
  BrowserSampleResult,
  FrameFidelityMetrics,
  HttpDeliveryMetric,
} from './types';

const CLOSE_CHANNEL_TOLERANCE = 2;
const ALPHA_PRESENT_THRESHOLD = 4;

export async function runBrowserBenchmark(): Promise<BrowserBenchmarkResult> {
  const result = requiredElement<HTMLPreElement>('result');
  const progress = requiredElement<HTMLElement>('progress');
  const canvas = requiredElement<HTMLCanvasElement>('benchmark-canvas');
  try {
    progress.textContent = '读取固定语料清单…';
    const input = await fetchJson<BrowserInput>('/animation-spec/corpus/.cache/browser-input.json');
    if (![1, 2].includes(input.schemaVersion) || !Array.isArray(input.samples)) {
      throw new Error('Invalid browser benchmark input.');
    }

    const initial = input.samples[0];
    if (!initial) throw new Error('HYA corpus is empty.');
    setCanvasSize(canvas, initial.width, initial.height);
    const engine = new HaiyueEngine({
      canvas,
      clearColor: { r: 0, g: 0, b: 0, a: 0 },
      alphaMode: 'premultiplied',
      devicePixelRatio: 1,
      timestampQuery: false,
      renderProfile: 'simple',
    });
    await engine.init();
    engine.context?.configure({
      device: engine.device,
      format: engine.format,
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const environment = {
      userAgent: navigator.userAgent,
      adapter: adapterInfo(engine.adapter),
      format: engine.format,
      devicePixelRatio: typeof engine.devicePixelRatio === 'function'
        ? engine.devicePixelRatio()
        : engine.devicePixelRatio,
    };
    const samples: BrowserSampleResult[] = [];
    try {
      progress.textContent = `预热共享 Animation2D pipeline · ${initial.id}`;
      await measureSample(engine, canvas, initial);
      for (let index = 0; index < input.samples.length; index++) {
        const sample = input.samples[index]!;
        progress.textContent = `${index + 1}/${input.samples.length} · ${sample.id}`;
        samples.push(await measureSample(engine, canvas, sample));
      }
    } finally {
      engine.destroy();
    }

    const output: BrowserBenchmarkResult = { schemaVersion: 2, environment, samples };
    result.textContent = JSON.stringify(output);
    result.dataset.status = 'passed';
    progress.textContent = `完成 ${samples.length} 个真实 Lottie 样本。`;
    return output;
  } catch (error) {
    const output = { error: error instanceof Error ? error.stack ?? error.message : String(error) };
    result.textContent = JSON.stringify(output);
    result.dataset.status = 'failed';
    progress.textContent = '浏览器测量失败。';
    throw error;
  }
}

async function measureSample(
  engine: HaiyueEngine,
  canvas: HTMLCanvasElement,
  sample: BrowserInputSample,
): Promise<BrowserSampleResult> {
  engine.switchScene(null, { destroyPrevious: true });
  setCanvasSize(canvas, sample.width, sample.height);
  engine.resizeToDisplaySize(true);

  const sourceDelivery = sample.sourceUrl
    ? await measureSourceDelivery(sample.sourceUrl, sample.externalResources ?? [])
    : null;
  const start = performance.now();
  const hyaFetch = await fetchStreamed(sample.hyaUrl);
  const fetchDone = performance.now();
  const animation = parseAnimation(hyaFetch.buffer);
  const parseDone = performance.now();

  const cameraEntity = new Entity(`Corpus camera: ${sample.id}`);
  cameraEntity.addComponent(new Camera2D({
    width: sample.width,
    height: sample.height,
    designWidth: sample.width,
    designHeight: sample.height,
    viewportMode: 'fixed',
  }));
  const scene = engine.createScene({
    name: `HYA corpus: ${sample.id}`,
    camera: { type: '2d', entity: cameraEntity },
    // Scene defaults are intentionally opaque for games. Fidelity references are
    // transparent AE exports, so pin the view clear instead of relying on the
    // engine-level clear color to win over SceneDefaults.
    view: { clearColor: { r: 0, g: 0, b: 0, a: 0 } },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: `HyaCorpus.${sample.id}`,
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  scene.addSystem(new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 16 }));
  const player = new Animation2DComponent(animation, { autoplay: false, loop: false, startTime: 0 });
  scene.add(new Entity(`Corpus player: ${sample.id}`).addComponent(new Transform2D()).addComponent(player));
  engine.switchScene(scene);
  await renderNextFrame(engine, undefined, `${sample.id}:first-frame`);
  if (player.runtimeStats.pendingResourceCount > 0) {
    await waitForRuntimeResources(player);
    await renderNextFrame(engine, undefined, `${sample.id}:resource-frame`);
  }
  const gpuDone = performance.now();
  const firstFrame = {
    totalMs: gpuDone - start,
    fetchMs: hyaFetch.metric.totalMs,
    parseMs: parseDone - fetchDone,
    runtimeAndGpuMs: gpuDone - parseDone,
    visualCount: player.runtimeStats.visualCount,
    network: hyaFetch.metric,
    pendingResourceCount: player.runtimeStats.pendingResourceCount,
    failedResourceCount: player.runtimeStats.failedResourceCount,
    externalResourceCount: sample.externalResources?.length ?? 0,
    externalResourceBytes: sum(sample.externalResources ?? [], resource => resource.bytes),
  };
  const delivery: BrowserDeliveryMetric | undefined = sourceDelivery
    ? {
        source: sourceDelivery.source,
        hya: { network: hyaFetch.metric, parseMs: firstFrame.parseMs },
        ...(sourceDelivery.externalResources.length > 0
          ? { externalResources: sourceDelivery.externalResources }
          : {}),
      }
    : undefined;

  const frames = [];
  for (const frame of sample.frames) {
    player.seek(Math.max(0, (frame.frame - sample.inFrame) / sample.frameRate));
    const [actual, expected] = await Promise.all([
      renderNextFrame(engine, { width: sample.width, height: sample.height }, `${sample.id}:frame-${frame.frame}`),
      readReferencePixels(frame.referenceUrl, sample.width, sample.height),
    ]);
    if (!actual) throw new Error(`WebGPU readback was omitted for ${sample.id} frame ${frame.frame}.`);
    frames.push({ frame: frame.frame, metrics: comparePixels(actual, expected) });
  }
  const scores = frames.map(frame => frame.metrics.score);
  const fidelity = {
    score: average(scores),
    minimumFrameScore: Math.min(...scores),
    rgbaSimilarity: average(frames.map(frame => frame.metrics.rgbaSimilarity)),
    alphaIoU: average(frames.map(frame => frame.metrics.alphaIoU)),
  };
  return { id: sample.id, ...(delivery ? { delivery } : {}), firstFrame, fidelity, frames };
}

async function measureSourceDelivery(
  url: string,
  resources: NonNullable<BrowserInputSample['externalResources']>,
): Promise<{
  source: BrowserDeliveryMetric['source'];
  externalResources: NonNullable<BrowserDeliveryMetric['externalResources']>;
}> {
  const [fetched, externalResources] = await Promise.all([
    fetchStreamed(url),
    Promise.all(resources.map(async resource => ({
      url: resource.url,
      kind: resource.kind,
      expectedBytes: resource.bytes,
      network: (await fetchStreamed(resource.url)).metric,
    }))),
  ]);
  const decodeStart = performance.now();
  const text = new TextDecoder().decode(fetched.buffer);
  JSON.parse(text);
  return {
    source: {
      network: fetched.metric,
      jsonParseMs: performance.now() - decodeStart,
    },
    externalResources,
  };
}

async function fetchStreamed(url: string): Promise<{ buffer: ArrayBuffer; metric: HttpDeliveryMetric }> {
  const start = performance.now();
  const response = await fetch(url, { cache: 'no-store' });
  const headersReceived = performance.now();
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let streamed = false;
  if (response.body) {
    streamed = true;
    const reader = response.body.getReader();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value || result.value.byteLength === 0) continue;
      chunks.push(result.value);
      byteLength += result.value.byteLength;
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 0) chunks.push(bytes);
    byteLength = bytes.byteLength;
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bodyReceived = performance.now();
  const rawContentLength = response.headers.get('content-length');
  const parsedContentLength = rawContentLength === null ? Number.NaN : Number(rawContentLength);
  return {
    buffer: combined.buffer,
    metric: {
      requestToHeadersMs: headersReceived - start,
      bodyDownloadMs: bodyReceived - headersReceived,
      totalMs: bodyReceived - start,
      bytes: byteLength,
      chunkCount: chunks.length,
      streamed,
      contentLength: Number.isSafeInteger(parsedContentLength) && parsedContentLength >= 0
        ? parsedContentLength
        : null,
      contentEncoding: response.headers.get('content-encoding'),
    },
  };
}

async function waitForRuntimeResources(player: Animation2DComponent): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (player.runtimeStats.pendingResourceCount > 0 && performance.now() < deadline) {
    await new Promise<void>(resolveWait => window.setTimeout(resolveWait, 8));
  }
  if (player.runtimeStats.pendingResourceCount > 0) {
    throw new Error('Timed out waiting for HYA external resources.');
  }
}

async function readReferencePixels(url: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not fetch reference ${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new Error(`Reference ${url} is ${bitmap.width}x${bitmap.height}; expected ${width}x${height}.`);
    }
    const target = new OffscreenCanvas(width, height);
    const context = target.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas2D is unavailable for reference readback.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
  }
}

function comparePixels(actual: Uint8ClampedArray, expected: Uint8ClampedArray): FrameFidelityMetrics {
  if (actual.length !== expected.length || actual.length % 4 !== 0) throw new Error('Fidelity buffers differ in size.');
  let absoluteError = 0;
  let squaredError = 0;
  let closePixels = 0;
  let alphaIntersection = 0;
  let alphaUnion = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    let close = true;
    for (let channel = 0; channel < 4; channel++) {
      const difference = Math.abs(actual[offset + channel]! - expected[offset + channel]!);
      absoluteError += difference;
      squaredError += difference * difference;
      if (difference > CLOSE_CHANNEL_TOLERANCE) close = false;
    }
    if (close) closePixels++;
    const actualPresent = actual[offset + 3]! > ALPHA_PRESENT_THRESHOLD;
    const expectedPresent = expected[offset + 3]! > ALPHA_PRESENT_THRESHOLD;
    if (actualPresent && expectedPresent) alphaIntersection++;
    if (actualPresent || expectedPresent) alphaUnion++;
  }
  const pixelCount = actual.length / 4;
  const rgbaSimilarity = 1 - absoluteError / (actual.length * 255);
  const alphaIoU = alphaUnion === 0 ? 1 : alphaIntersection / alphaUnion;
  return {
    score: rgbaSimilarity * 0.75 + alphaIoU * 0.25,
    rgbaSimilarity,
    alphaIoU,
    normalizedRmse: Math.sqrt(squaredError / actual.length) / 255,
    closePixelRatio: closePixels / pixelCount,
  };
}

function setCanvasSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

async function renderNextFrame(
  engine: HaiyueEngine,
  readback?: { width: number; height: number },
  label = 'unknown',
): Promise<Uint8ClampedArray | null> {
  return new Promise<Uint8ClampedArray | null>((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
    const fail = (error: unknown): void => {
      engine.stop();
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onError = (event: ErrorEvent): void => fail(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent): void => fail(event.reason);
    const timeout = window.setTimeout(() => {
      fail(new Error(`Timed out waiting for HYA WebGPU frame ${label}.`));
    }, 10_000);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    engine.once('after-update', () => {
      engine.stop();
      const pending = readback ? copyCurrentTexture(engine, readback.width, readback.height) : null;
      void (pending ?? engine.device.queue.onSubmittedWorkDone().then(() => null)).then(pixels => {
        cleanup();
        resolve(pixels);
      }, fail);
    });
    engine.run();
  });
}

async function copyCurrentTexture(
  engine: HaiyueEngine,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  const context = engine.context;
  if (!context) throw new Error('WebGPU canvas context is unavailable for fidelity readback.');
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = engine.device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = engine.device.createCommandEncoder({ label: 'HyaCorpus.fidelityReadback' });
  encoder.copyTextureToBuffer(
    { texture: context.getCurrentTexture() },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  engine.device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  try {
    const source = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    const bgra = engine.format.startsWith('bgra');
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const sourceOffset = row * bytesPerRow + column * 4;
        const targetOffset = (row * width + column) * 4;
        const alpha = source[sourceOffset + 3]!;
        const red = source[sourceOffset + (bgra ? 2 : 0)]!;
        const green = source[sourceOffset + 1]!;
        const blue = source[sourceOffset + (bgra ? 0 : 2)]!;
        pixels[targetOffset] = unpremultiply(red, alpha);
        pixels[targetOffset + 1] = unpremultiply(green, alpha);
        pixels[targetOffset + 2] = unpremultiply(blue, alpha);
        pixels[targetOffset + 3] = alpha;
      }
    }
    return pixels;
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}

function unpremultiply(channel: number, alpha: number): number {
  if (alpha === 0 || alpha === 255) return channel;
  return Math.min(255, Math.round(channel * 255 / alpha));
}

function adapterInfo(adapter: GPUAdapter | null): Record<string, unknown> | null {
  if (!adapter) return null;
  const info = adapter.info;
  return {
    architecture: info.architecture,
    description: info.description,
    device: info.device,
    vendor: info.vendor,
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function sum<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element as T;
}
