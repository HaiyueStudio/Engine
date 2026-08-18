import { AnimationFormatError } from './errors';

export interface AnimationExtensionValidationContext {
  readonly extension: string;
  readonly path: string;
  fail(message: string, path?: string): never;
}

export interface AnimationExtensionHandler {
  /** Versioned identifier such as `org.example.particle@1`. */
  readonly id: string;
  validateComponent?(component: Readonly<Record<string, unknown>>, context: AnimationExtensionValidationContext): void;
  validateDocument?(data: unknown, context: AnimationExtensionValidationContext): void;
}

export class AnimationExtensionRegistry {
  private readonly _handlers = new Map<string, AnimationExtensionHandler>();

  register(handler: AnimationExtensionHandler): () => void {
    validateExtensionId(handler.id);
    if (this._handlers.has(handler.id)) {
      throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', `Extension "${handler.id}" is already registered.`, '$.extensions');
    }
    this._handlers.set(handler.id, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this._handlers.get(handler.id) === handler) this._handlers.delete(handler.id);
    };
  }

  get(id: string): AnimationExtensionHandler | undefined {
    return this._handlers.get(id);
  }

  has(id: string): boolean {
    return this._handlers.has(id);
  }
}

export function extensionIdFromComponentType(type: string): string | null {
  return type === 'shape2d' || type === 'path2d' || type === 'sprite2d'
    || type === 'text2d' || type === 'particle2d' || type === 'audio' ? null : type;
}

export function validateExtensionId(value: string): void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+@[1-9][0-9]*$/i.test(value)) {
    throw new AnimationFormatError(
      'E_ANIMATION_INVALID_FORMAT',
      `Extension id "${value}" must be a namespaced id with a major version suffix.`,
      '$.extensionsUsed',
    );
  }
}
