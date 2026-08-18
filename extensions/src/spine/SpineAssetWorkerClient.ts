import { WorkerChannel, type WorkerChannelLike } from '@haiyue/engine/experimental/async';
import type { SpineParsedAsset } from './SpineAssetParser';
import type { SpineAssetWorker } from './SpineAssetWorkerContract';

type SpineWorkerLike = WorkerChannelLike;

export class SpineAssetWorkerClient implements SpineAssetWorker {
  private readonly channel: WorkerChannel;

  constructor(worker: SpineWorkerLike, private readonly objectUrl: string | null = null) {
    this.channel = new WorkerChannel(worker, {
      label: 'Spine asset worker',
      path: 'spine.worker',
      context: { resourceType: 'skeleton/spine' },
    });
  }

  loadParsedAsset(jsonUrl: string, atlasUrl: string, options: { signal?: AbortSignal } = {}): Promise<SpineParsedAsset> {
    return this.channel.request('loadParsedSpineAsset', { jsonUrl, atlasUrl }, {
      ...(options.signal ? { signal: options.signal } : {}),
      context: { url: jsonUrl },
      abortMessage: 'Spine load aborted.',
      validate: isSpineParsedAsset,
    });
  }

  dispose(options: { terminate?: boolean } = {}): void {
    const alreadyDisposed = this.channel.isDisposed;
    this.channel.dispose(options);
    if (!alreadyDisposed && this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

function isSpineParsedAsset(value: unknown): value is SpineParsedAsset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { data?: unknown; regions?: unknown };
  const data = candidate.data as { bones?: unknown } | null | undefined;
  return !!data && typeof data === 'object'
    && Array.isArray(data.bones)
    && Array.isArray(candidate.regions);
}


export function createSpineAssetWorkerSource(extensionSpineModuleUrl: string): string {
  return `
const parserModulePromise = import(${JSON.stringify(extensionSpineModuleUrl)});
const requests = new Map();
const assetError = (message, code, path, recovery, context, cause) => Object.assign(new Error(message), {
  domain: 'component', code, path, recovery, recoverable: recovery === 'retry', context, cause,
});
self.addEventListener('message', async event => {
  const request = event.data;
  if (!request || request.version !== 1 || typeof request.id !== 'number') return;
  if (request.type === 'cancel') { requests.get(request.id)?.abort('cancelled'); requests.delete(request.id); return; }
  if (request.type !== 'loadParsedSpineAsset') return;
  const controller = new AbortController();
  requests.set(request.id, controller);
  try {
    const [parser, jsonResponse, atlasResponse] = await Promise.all([
      parserModulePromise,
      fetch(request.jsonUrl, { signal: controller.signal }),
      request.atlasUrl ? fetch(request.atlasUrl, { signal: controller.signal }) : Promise.resolve(null),
    ]);
    if (!jsonResponse.ok) throw assetError(
      'Failed to load Spine JSON: ' + jsonResponse.status + ' ' + jsonResponse.statusText,
      'E_ASSET_LOAD_FAILED', 'spine.json', 'retry',
      { url: request.jsonUrl, resourceType: 'skeleton/spine-json', status: jsonResponse.status },
    );
    if (atlasResponse && !atlasResponse.ok) throw assetError(
      'Failed to load Spine atlas: ' + atlasResponse.status + ' ' + atlasResponse.statusText,
      'E_ASSET_LOAD_FAILED', 'spine.atlas', 'retry',
      { url: request.atlasUrl, resourceType: 'skeleton/spine-atlas', status: atlasResponse.status },
    );
    let json;
    try { json = await jsonResponse.json(); }
    catch (cause) {
      throw assetError(
        'Spine JSON is not valid JSON.', 'E_ASSET_INVALID_DATA', 'spine.json', 'release-resource',
        { url: request.jsonUrl, resourceType: 'skeleton/spine-json' }, cause,
      );
    }
    const value = parser.parseSpineAssetPayload({
      json,
      atlasText: atlasResponse ? await atlasResponse.text() : '',
    });
    self.postMessage({ version: 1, id: request.id, ok: true, value });
  } catch (error) {
    if (controller.signal.aborted) return;
    const serialized = error && typeof error.toJSON === 'function' ? error.toJSON() : {
      name: 'EngineError', domain: error && error.domain || 'asset', code: error && error.code || 'E_ASSET_INVALID_DATA',
      message: error instanceof Error ? error.message : String(error),
      recovery: error && error.recovery || 'release-resource',
      recoverable: error && typeof error.recoverable === 'boolean' ? error.recoverable : false,
      context: Object.assign({ url: request.jsonUrl, resourceType: 'skeleton/spine' }, error && error.context || {}),
      path: error && error.path || 'spine.parse',
      cause: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
    };
    self.postMessage({ version: 1, id: request.id, ok: false, error: serialized });
  } finally { requests.delete(request.id); }
});
`.trim();
}

export function createInlineSpineAssetWorkerClient(extensionSpineModuleUrl: string, options?: WorkerOptions): SpineAssetWorkerClient {
  const blob = new Blob([createSpineAssetWorkerSource(extensionSpineModuleUrl)], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  return new SpineAssetWorkerClient(new Worker(url, { type: 'module', ...options }), url);
}

export function createSpineAssetWorkerClientFromUrl(url: string | URL, options?: WorkerOptions): SpineAssetWorkerClient {
  return new SpineAssetWorkerClient(new Worker(url, options));
}
