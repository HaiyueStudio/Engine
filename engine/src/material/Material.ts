let _matIdCounter = 0;

export type MaterialShadingModel = 'unlit' | 'blinn-phong' | 'metallic-roughness' | 'toon' | 'custom';

export interface MaterialShaderContract {
  /** Stable contract identifier used in pipeline/cache keys. */
  readonly id: string;
  readonly version: number;
  readonly shadingModel: MaterialShadingModel;
  readonly vertexSemantics: readonly ('POSITION' | 'NORMAL' | 'TEXCOORD_0' | 'TEXCOORD_1' | 'TANGENT' | 'JOINTS_0' | 'WEIGHTS_0')[];
  readonly features: readonly string[];
}

export abstract class Material {
  readonly id: number = ++_matIdCounter;
  abstract readonly type: string;
  private _revision = 0;
  private _mutationDepth = 0;
  private _mutationPending = false;

  /**
   * Monotonically increasing material-state revision.
   *
   * Renderers may use this value to invalidate CPU/GPU caches. Assignments made
   * through built-in material setters update it automatically. Call markDirty()
   * after mutating a nested mutable value (for example material.color.a).
   */
  get revision(): number {
    return this._revision;
  }

  markDirty(): this {
    this._stateChanged();
    return this;
  }

  /** Coalesce a group of property changes into one revision increment. */
  protected mutateState<T>(operation: () => T): T {
    this._mutationDepth++;
    try {
      return operation();
    } finally {
      this._mutationDepth--;
      if (this._mutationDepth === 0 && this._mutationPending) {
        this._mutationPending = false;
        this._revision++;
      }
    }
  }

  /** Record a validated state change without invoking an overridable hook. */
  protected _stateChanged(): void {
    if (this._mutationDepth > 0) {
      this._mutationPending = true;
      return;
    }
    this._revision++;
  }

  getShaderContract(): MaterialShaderContract {
    return Object.freeze({
      id: `haiyue.material.${this.type}`,
      version: 1,
      shadingModel: 'custom',
      vertexSemantics: Object.freeze(['POSITION'] as const),
      features: Object.freeze([]),
    }) satisfies MaterialShaderContract;
  }
}
