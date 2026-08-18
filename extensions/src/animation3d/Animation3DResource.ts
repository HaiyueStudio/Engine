import type {
  AssetHandle,
  AssetJobPriority,
  AssetOwnerScope,
} from '@haiyue/engine/assets';
import type { Animation3DClip } from './Animation3DClip';
import type {
  Animation3DStateMachineDefinition,
} from './Animation3DStateMachine';

export type Animation3DClipHandle =
  AssetHandle<Animation3DClip>;

export type Animation3DStateMachineHandle =
  AssetHandle<Animation3DStateMachineDefinition>;

export type Animation3DResourceSource =
  | Readonly<{
      kind: 'url';
      url: string;
      cacheKey?: string;
    }>
  | Readonly<{
      kind: 'buffer';
      data: ArrayBuffer;
      /** Required because ArrayBuffer identity is not a persistent cache key. */
      cacheKey: string;
    }>;

export interface Animation3DResourceLoadOptions {
  readonly signal?: AbortSignal;
  readonly owner?: AssetOwnerScope;
  readonly priority?: AssetJobPriority | number;
}

/**
 * Contract for an AssetManager-backed loader. Implementations must return a
 * distinct handle per acquisition and make handle.release() idempotent.
 */
export interface Animation3DResourceLoader {
  loadClip(
    source: Animation3DResourceSource,
    options?: Animation3DResourceLoadOptions,
  ): Promise<Animation3DClipHandle>;
  loadStateMachine(
    source: Animation3DResourceSource,
    options?: Animation3DResourceLoadOptions,
  ): Promise<Animation3DStateMachineHandle>;
}
