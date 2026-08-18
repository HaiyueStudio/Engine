import type { ComponentRegistration } from './EnginePlugin';

export class EngineRegistryHub {
  private readonly _components = new Map<string, ComponentRegistration>();

  registerComponent(registration: ComponentRegistration): this {
    this._components.set(registration.type, registration);
    return this;
  }

  unregisterComponent(type: string): this {
    this._components.delete(type);
    return this;
  }

  getRegisteredComponent(type: string): ComponentRegistration | undefined {
    return this._components.get(type);
  }

  clear(): void {
    this._components.clear();
  }
}
