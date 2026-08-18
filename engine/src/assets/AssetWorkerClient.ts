import { isWorkerChannelResponse, WorkerChannel, type WorkerChannelLike } from '../async/WorkerChannel';

export type AssetWorkerRequestType = 'fetchArrayBuffer' | 'fetchText' | 'fetchJson';

export interface AssetWorkerRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  signal?: AbortSignal;
}

export interface AssetWorkerRequest {
  version: 1;
  id: number;
  type: AssetWorkerRequestType;
  url: string;
  init?: AssetWorkerRequestInit | undefined;
}

export interface AssetWorkerSuccessResponse {
  version: 1;
  id: number;
  ok: true;
  value: unknown;
}

export interface AssetWorkerFailureResponse {
  version: 1;
  id: number;
  ok: false;
  error: import('../core/EngineError').SerializedEngineError;
}

export type AssetWorkerResponse = AssetWorkerSuccessResponse | AssetWorkerFailureResponse;

export type AssetWorkerLike = WorkerChannelLike;

export class AssetWorkerClient {
  private readonly channel: WorkerChannel;

  constructor(_worker: AssetWorkerLike, private readonly _objectUrl: string | null = null) {
    this.channel = new WorkerChannel(_worker, {
      label: 'asset worker',
      path: 'assetWorker',
      context: { resourceType: 'asset' },
    });
  }

  fetchArrayBuffer(url: string, init?: AssetWorkerRequestInit): Promise<ArrayBuffer> {
    return this._request<ArrayBuffer>('fetchArrayBuffer', url, init);
  }

  fetchText(url: string, init?: AssetWorkerRequestInit): Promise<string> {
    return this._request<string>('fetchText', url, init);
  }

  fetchJson<T = unknown>(url: string, init?: AssetWorkerRequestInit): Promise<T> {
    return this._request<T>('fetchJson', url, init);
  }

  dispose(options: { terminate?: boolean } = {}): void {
    const alreadyDisposed = this.channel.isDisposed;
    this.channel.dispose(options);
    if (!alreadyDisposed && this._objectUrl) URL.revokeObjectURL(this._objectUrl);
  }

  private _request<T>(type: AssetWorkerRequestType, url: string, init?: AssetWorkerRequestInit): Promise<T> {
    const messageInit = init ? { ...init } : undefined;
    if (messageInit) delete messageInit.signal;
    const transfer = init?.body instanceof ArrayBuffer ? [init.body] : undefined;
    return this.channel.request<T>(type, { url, init: messageInit }, {
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(transfer ? { transfer } : {}),
      context: { url, resourceType: type },
      abortMessage: `Asset worker request aborted: ${url}`,
      validate: (value: unknown): value is T => isAssetWorkerValue(type, value),
    });
  }
}

export function isAssetWorkerResponse(value: unknown): value is AssetWorkerResponse {
  return isWorkerChannelResponse(value);
}

function isAssetWorkerValue(type: AssetWorkerRequestType, value: unknown): boolean {
  if (type === 'fetchArrayBuffer') return value instanceof ArrayBuffer;
  if (type === 'fetchText') return typeof value === 'string';
  return true;
}

export function createAssetWorkerSource(): string {
  return `
self.__haiyueAssetRequests = new Map();
self.addEventListener('message', async event => {
  const request = event.data;
  if (!request || request.version !== 1 || typeof request.id !== 'number') return;
  if (request.type === 'cancel') {
    self.__haiyueAssetRequests.get(request.id)?.abort('cancelled');
    self.__haiyueAssetRequests.delete(request.id);
    return;
  }
  const controller = new AbortController();
  self.__haiyueAssetRequests.set(request.id, controller);
  try {
    const response = await fetch(request.url, { ...(request.init || {}), signal: controller.signal });
    if (!response.ok) {
      throw new Error('Failed to fetch "' + request.url + '": ' + response.status + ' ' + response.statusText);
    }
    if (request.type === 'fetchArrayBuffer') {
      const value = await response.arrayBuffer();
      self.postMessage({ version: 1, id: request.id, ok: true, value }, [value]);
      return;
    }
    if (request.type === 'fetchText') {
      self.postMessage({ version: 1, id: request.id, ok: true, value: await response.text() });
      return;
    }
    if (request.type === 'fetchJson') {
      self.postMessage({ version: 1, id: request.id, ok: true, value: await response.json() });
      return;
    }
    throw new Error('Unknown asset worker request type: ' + request.type);
  } catch (error) {
    if (controller.signal.aborted) return;
    const cause = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : undefined;
    self.postMessage({
      version: 1, id: request.id,
      ok: false,
      error: {
        name: 'EngineError',
        domain: 'asset',
        code: 'E_ASSET_LOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
        recovery: 'retry',
        context: { url: request.url, resourceType: request.type },
        path: 'assetWorker.request',
        cause,
      },
    });
  } finally {
    self.__haiyueAssetRequests.delete(request.id);
  }
});
`.trim();
}

export function createAssetWorkerClientFromUrl(url: string | URL, options?: WorkerOptions): AssetWorkerClient {
  return new AssetWorkerClient(new Worker(url, options));
}

export function createInlineAssetWorkerClient(options?: WorkerOptions): AssetWorkerClient {
  const blob = new Blob([createAssetWorkerSource()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module', ...options });
  return new AssetWorkerClient(worker, url);
}
