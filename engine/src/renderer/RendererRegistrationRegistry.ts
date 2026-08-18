export type RendererRegistrationConstructor<T> = new (...args: never[]) => T;

export interface DestroyableRendererRegistration {
  destroy?: () => void;
}

export abstract class RendererRegistrationRegistry<
  TItem,
  TRegistration extends DestroyableRendererRegistration,
> {
  protected readonly registrations: TRegistration[] = [];
  protected readonly exact = new Map<Function, TRegistration>();
  private _revision = 0;

  /** Monotonic graph revision for consumers that cache resolved registrations. */
  get revision(): number { return this._revision; }

  protected registerType(type: RendererRegistrationConstructor<TItem>, registration: TRegistration): this {
    this.unregisterType(type);
    this.registrations.push(registration);
    this.exact.set(type, registration);
    this._markChanged();
    return this;
  }

  protected unregisterType(type: RendererRegistrationConstructor<TItem>): this {
    const current = this.exact.get(type);
    if (!current) return this;
    this.exact.delete(type);
    const index = this.registrations.indexOf(current);
    if (index >= 0) this.registrations.splice(index, 1);
    current.destroy?.();
    this._markChanged();
    return this;
  }

  protected resolveFor(item: TItem): TRegistration | null {
    const exact = this.exact.get((item as object).constructor);
    if (exact) return exact;
    for (const registration of this.registrations) {
      if (this.matches(item, registration)) return registration;
    }
    return null;
  }

  destroy(): void {
    if (this.registrations.length > 0) this._markChanged();
    for (const registration of this.registrations) registration.destroy?.();
    this.registrations.length = 0;
    this.exact.clear();
  }

  /** Releases device-bound registration state without changing graph membership. */
  releaseResources(): void {
    for (const registration of this.registrations) registration.destroy?.();
  }

  protected abstract matches(item: TItem, registration: TRegistration): boolean;

  protected _markChanged(): void {
    this._revision = (this._revision + 1) >>> 0;
  }
}
