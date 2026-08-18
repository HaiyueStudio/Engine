import { prepareKtx2TexturePayload } from '../assets/Ktx2TextureLoader';

interface Ktx2WorkerRequest {
  version: number;
  id: number;
  type: string;
  buffer?: unknown;
  label?: unknown;
  deviceFeatures?: unknown;
  options?: unknown;
}

interface Ktx2WorkerScope {
  addEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage?(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as Ktx2WorkerScope;
const cancelled = new Set<number>();

scope.addEventListener?.('message', event => { void handleRequest(event.data); });

async function handleRequest(value: unknown): Promise<void> {
  if (!isRequest(value)) return;
  if (value.type === 'cancel') {
    cancelled.add(value.id);
    return;
  }
  if (value.type !== 'prepareKtx2TexturePayload' || !(value.buffer instanceof ArrayBuffer)) return;
  const label = typeof value.label === 'string' ? value.label : 'KTX2Texture';
  try {
    const payload = await prepareKtx2TexturePayload(
      Array.isArray(value.deviceFeatures) ? value.deviceFeatures.filter(isString) : [],
      value.buffer,
      label,
      isRecord(value.options) ? value.options : {},
    );
    if (cancelled.has(value.id)) return;
    const transfer = payload.levels.map(level => level.data.buffer);
    scope.postMessage?.({ version: 1, id: value.id, ok: true, value: payload }, transfer);
  } catch (error) {
    if (cancelled.has(value.id)) return;
    scope.postMessage?.({
      version: 1,
      id: value.id,
      ok: false,
      error: serializeWorkerError(error, label),
    });
  } finally {
    cancelled.delete(value.id);
  }
}

function isRequest(value: unknown): value is Ktx2WorkerRequest {
  return isRecord(value)
    && value.version === 1
    && typeof value.id === 'number'
    && typeof value.type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string { return typeof value === 'string'; }

function serializeWorkerError(error: unknown, label: string): Record<string, unknown> {
  if (isRecord(error) && typeof error.toJSON === 'function') {
    return (error.toJSON as () => Record<string, unknown>)();
  }
  return {
    name: 'EngineError',
    domain: isRecord(error) && typeof error.domain === 'string' ? error.domain : 'asset',
    code: isRecord(error) && typeof error.code === 'string' ? error.code : 'E_ASSET_LOAD_FAILED',
    message: error instanceof Error ? error.message : String(error),
    recoverable: isRecord(error) && typeof error.recoverable === 'boolean' ? error.recoverable : false,
    recovery: isRecord(error) && typeof error.recovery === 'string' ? error.recovery : 'release-resource',
    context: { label, resourceType: 'texture/ktx2' },
    path: isRecord(error) && typeof error.path === 'string' ? error.path : 'ktx2.worker',
    cause: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
  };
}
