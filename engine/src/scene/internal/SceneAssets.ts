import type { AssetHandle } from '../../assets/AssetManager';
import { AssetOwnerScope } from '../../assets/AssetJob';
import { EngineError, EngineErrorCode } from '../../core/EngineError';
import type { IEngine } from '../../core/IEngine';
import type { ScenePluginScene } from '../../core/EnginePlugin';
import type { SceneAssetRequest, SceneLoadedAssets } from './SceneContracts';
import type { SceneRuntime } from './SceneRuntime';

type NormalizedSceneAssetRequest<T = unknown> = Exclude<SceneAssetRequest<T>, string>;

export class SceneAssets {
  private readonly _handles = new Set<AssetHandle<unknown>>();
  private _owner = new AssetOwnerScope('scene-assets');

  constructor(
    private readonly _engine: IEngine,
    private readonly _runtime: SceneRuntime,
  ) {}

  async load<T>(request: SceneAssetRequest<T>, scene: ScenePluginScene): Promise<T> {
    this._runtime.assertUsable('load');
    const normalized = normalizeSceneAssetRequest(request);
    const owner = this._owner;
    const handle = await this._loadHandle(normalized, owner);
    if (!this._canCommit(owner)) {
      handle.release();
      throw this._runtime.createDestroyedError('load');
    }
    this._handles.add(handle as AssetHandle<unknown>);
    normalized.assign?.(handle.value, scene);
    return handle.value;
  }

  async loadMany<T>(requests: readonly SceneAssetRequest<T>[], scene: ScenePluginScene): Promise<SceneLoadedAssets<T>> {
    this._runtime.assertUsable('loadMany');
    const owner = this._owner;
    const entries: [string, T][] = [];
    const acquired: AssetHandle<unknown>[] = [];
    try {
      for (const request of requests) {
        const normalized = normalizeSceneAssetRequest(request);
        const handle = await this._loadHandle(normalized, owner);
        if (!this._canCommit(owner)) {
          handle.release();
          throw this._runtime.createDestroyedError('loadMany');
        }
        acquired.push(handle as AssetHandle<unknown>);
        normalized.assign?.(handle.value, scene);
        entries.push([normalized.key ?? normalized.url, handle.value]);
      }
    } catch (error) {
      for (const handle of acquired) handle.release();
      throw error;
    }
    for (const handle of acquired) this._handles.add(handle);
    return new Map(entries);
  }

  releaseAll(): void {
    for (const handle of this._handles) handle.release();
    this._handles.clear();
  }

  suspendForDeviceLoss(): void {
    this._owner.abort('device-lost');
  }

  recoverDevice(): void {
    this._owner = new AssetOwnerScope('scene-assets');
  }

  destroy(): void {
    this._owner.abort('scene-destroyed');
    this.releaseAll();
  }

  private _canCommit(owner: AssetOwnerScope): boolean {
    return owner === this._owner
      && !owner.signal.aborted
      && this._runtime.state !== 'destroying'
      && this._runtime.state !== 'destroyed';
  }

  private async _loadHandle<T>(normalized: NormalizedSceneAssetRequest<T>, owner: AssetOwnerScope): Promise<AssetHandle<T>> {
    const assets = this._engine.assetManager;
    if (!assets) {
      throw new EngineError(
        EngineErrorCode.AssetLoadFailed,
        'Scene.load() requires an initialized AssetManager.',
        {
          hint: 'Call engine.init() before loading scene assets, or provide assets manually through AssetManager.setAsset().',
          docsPath: 'errors/E_ASSET_LOAD_FAILED',
        },
      );
    }
    const inferredType = normalized.type
      ?? assets.resolveType(normalized.url, { mimeType: normalized.mimeType, alias: normalized.alias })
      ?? null;
    return inferredType
      ? await assets.loadUrl<T>(normalized.url, {
          type: inferredType,
          mimeType: normalized.mimeType,
          alias: normalized.alias ?? normalized.key,
          signal: normalized.signal,
          owner,
        })
      : await assets.loadTexture(normalized.url, { ...normalized.options, signal: combineAbortSignals(owner.signal, normalized.signal) }) as AssetHandle<T>;
  }
}

function combineAbortSignals(owner: AbortSignal, request?: AbortSignal): AbortSignal {
  if (!request || owner.aborted) return owner;
  if (request.aborted) return request;
  return AbortSignal.any([owner, request]);
}

function normalizeSceneAssetRequest<T>(request: SceneAssetRequest<T>): NormalizedSceneAssetRequest<T> {
  return typeof request === 'string' ? { url: request } : request;
}
