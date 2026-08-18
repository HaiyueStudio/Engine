import { WorkerChannel, type WorkerChannelLike } from '@haiyue/engine/experimental/async';
import { isGltfParsedAsset, type DracoDecoderConfig, type GltfAssetWorker } from './GltfLoaderContract';

type GltfAssetWorkerLike = WorkerChannelLike;

export class GltfAssetWorkerClient implements GltfAssetWorker {
  private readonly channel: WorkerChannel;

  constructor(worker: GltfAssetWorkerLike, private readonly objectUrl: string | null = null) {
    this.channel = new WorkerChannel(worker, {
      label: 'glTF asset worker',
      path: 'gltf.worker',
      context: { resourceType: 'model/gltf' },
    });
  }

  loadParsedAsset(
    src: string,
    options: { signal?: AbortSignal; dracoDecoderConfig?: DracoDecoderConfig } = {},
  ): Promise<Awaited<ReturnType<GltfAssetWorker['loadParsedAsset']>>> {
    return this.channel.request('loadParsedGltfAsset', {
      src,
      dracoDecoderConfig: toWorkerDracoDecoderConfig(options.dracoDecoderConfig),
    }, {
      ...(options.signal ? { signal: options.signal } : {}),
      context: { url: src },
      abortMessage: 'glTF load aborted.',
      validate: isGltfParsedAsset,
    });
  }

  dispose(options: { terminate?: boolean } = {}): void {
    const alreadyDisposed = this.channel.isDisposed;
    this.channel.dispose(options);
    if (!alreadyDisposed && this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

function toWorkerDracoDecoderConfig(config: DracoDecoderConfig | undefined): Pick<DracoDecoderConfig, 'scriptUrl' | 'wasmBinary'> | undefined {
  if (!config) return undefined;
  return {
    ...(config.scriptUrl === undefined ? {} : { scriptUrl: config.scriptUrl }),
    ...(config.wasmBinary === undefined ? {} : { wasmBinary: config.wasmBinary }),
  };
}

/** The worker imports the same production parser used by the main-thread fallback. */
export function createGltfAssetWorkerSource(extensionGltfModuleUrl: string): string {
  return `
const parserModulePromise = import(${JSON.stringify(extensionGltfModuleUrl)});
const requests = new Map();
self.addEventListener('message', async event => {
  const request = event.data;
  if (!request || request.version !== 1 || typeof request.id !== 'number') return;
  if (request.type === 'cancel') {
    requests.get(request.id)?.abort('cancelled');
    requests.delete(request.id);
    return;
  }
  if (request.type !== 'loadParsedGltfAsset') return;
  const controller = new AbortController();
  requests.set(request.id, controller);
  try {
    const parser = await parserModulePromise;
    const value = await parser.loadParsedGltfAsset(request.src, controller.signal);
    const geometryStartedAt = performance.now();
    let dracoDecodeMs = 0;
    value.geometryPayloads = await parser.prepareGltfGeometryPayloads(value.gltf, value.buffers, {
      signal: controller.signal,
      dracoDecoderConfig: request.dracoDecoderConfig,
      diagnostics: {
        onDracoDecode(durationMs) { dracoDecodeMs += durationMs; },
      },
    });
    const geometryPreparationMs = performance.now() - geometryStartedAt;
    if (!requiresRuntimeSourceBuffers(value.gltf)) {
      value.binaryChunk = null;
      value.buffers = [];
    }
    const transfer = [];
    const seen = new Set();
    const add = buffer => { if (buffer && !seen.has(buffer)) { seen.add(buffer); transfer.push(buffer); } };
    add(value.binaryChunk);
    for (const buffer of value.buffers || []) add(buffer);
    for (const mesh of value.geometryPayloads || []) for (const payload of mesh || []) if (payload) {
      for (const array of [payload.positions, payload.indices, payload.normals, payload.joints, payload.weights]) add(array && array.buffer);
      for (const entry of payload.textureCoordinates || []) add(entry.data && entry.data.buffer);
      for (const array of payload.positionTargets || []) add(array.buffer);
      for (const array of payload.normalTargets || []) add(array.buffer);
    }
    const workerTransferBytes = transfer.reduce((total, buffer) => total + buffer.byteLength, 0);
    const baseMetrics = value.metrics || {};
    value.metrics = {
      fetchMs: baseMetrics.fetchMs || 0,
      parseMs: baseMetrics.parseMs || 0,
      workerParseMs: (baseMetrics.parseMs || 0) + Math.max(0, geometryPreparationMs - dracoDecodeMs),
      dracoDecodeMs,
      geometryPreparationMs,
      sourceBytes: baseMetrics.sourceBytes || 0,
      workerTransferBytes,
      workerTransferBufferCount: transfer.length,
    };
    self.postMessage({ version: 1, id: request.id, ok: true, value }, transfer);
  } catch (error) {
    if (controller.signal.aborted) return;
    const serialized = error && typeof error.toJSON === 'function' ? error.toJSON() : {
      name: 'EngineError', domain: 'asset', code: 'E_ASSET_INVALID_DATA',
      message: error instanceof Error ? error.message : String(error), recoverable: false,
      recovery: 'release-resource', context: { url: request.src, resourceType: 'model/gltf' },
      path: error && error.path || 'gltf.parse',
      cause: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
    };
    self.postMessage({ version: 1, id: request.id, ok: false, error: serialized });
  } finally {
    requests.delete(request.id);
  }
});

function requiresRuntimeSourceBuffers(gltf) {
  if ((gltf.animations || []).length > 0) return true;
  if ((gltf.images || []).some(image => image.bufferView !== undefined)) return true;
  return (gltf.skins || []).some(skin => skin.inverseBindMatrices !== undefined);
}
`.trim();
}

export function createGltfAssetWorkerClientFromUrl(url: string | URL, options?: WorkerOptions): GltfAssetWorkerClient {
  return new GltfAssetWorkerClient(new Worker(url, options));
}

export function createInlineGltfAssetWorkerClient(extensionGltfModuleUrl: string, options?: WorkerOptions): GltfAssetWorkerClient {
  const blob = new Blob([createGltfAssetWorkerSource(extensionGltfModuleUrl)], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module', ...options });
  return new GltfAssetWorkerClient(worker, url);
}
