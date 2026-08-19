import type {
  AnimationComponent,
  AnimationNode,
  ParsedAnimation,
} from '@haiyue/animation-spec';
import type { Entity } from '@haiyue/engine';
import type { AssetManager } from '@haiyue/engine/assets';

export interface Animation2DExtensionContext {
  readonly animation: ParsedAnimation;
  readonly node: Readonly<AnimationNode>;
  readonly component: Readonly<AnimationComponent>;
  /** Anchor-adjusted parent for entities created by the extension. */
  readonly parent: Entity;
  /** Shared runtime asset manager; absent hosts must reject resource-backed handlers. */
  readonly assetManager?: AssetManager;
  /** Stable identity separating multiple instances of the same HYA document. */
  readonly instanceId: number;
  /** Aborted before the owning animation hierarchy is destroyed. */
  readonly signal: AbortSignal;
}

export interface Animation2DExtensionInstance {
  /** Deterministic composition-time update; implementations must tolerate seeks and loop wrap. */
  apply?(timeSeconds: number, opacity: number): void;
  setOpacity?(opacity: number): void;
  destroy?(): void;
}

export interface Animation2DExtensionHandler {
  /** Component type or namespaced extension id implemented by this handler. */
  readonly id: string;
  create(context: Animation2DExtensionContext): Animation2DExtensionInstance | void;
}

/** Instance-owned registry; unregister tokens only remove the handler that created them. */
export class Animation2DExtensionRegistry {
  private readonly _handlers = new Map<string, Animation2DExtensionHandler>();

  register(handler: Animation2DExtensionHandler): () => void {
    if (!handler.id.trim()) throw new TypeError('Animation runtime extension id must not be empty.');
    if (this._handlers.has(handler.id)) throw new Error(`Animation runtime extension "${handler.id}" is already registered.`);
    this._handlers.set(handler.id, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this._handlers.get(handler.id) === handler) this._handlers.delete(handler.id);
    };
  }

  get(id: string): Animation2DExtensionHandler | undefined {
    return this._handlers.get(id);
  }

  has(id: string): boolean {
    return this._handlers.has(id);
  }
}
