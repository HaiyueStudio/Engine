import type { ScriptComponentScripts, ScriptLifecycleName } from '../components/ScriptComponent';

let _scriptResourceId = 0;

export class ScriptResource {
  readonly id: number = ++_scriptResourceId;
  name: string;
  readonly scripts: Required<ScriptComponentScripts>;
  readonly sourcePath: string;
  private _version = 0;
  private readonly _listeners = new Set<(resource: ScriptResource, lifecycle: ScriptLifecycleName) => void>();

  constructor(options: { name?: string; sourcePath?: string; scripts?: ScriptComponentScripts } = {}) {
    this.name = options.name ?? `Script ${this.id}`;
    this.sourcePath = options.sourcePath ?? `scripts/${this.name.replace(/[^a-z0-9._-]+/gi, '-') || this.id}.js`;
    const scripts = options.scripts ?? {};
    this.scripts = {
      onUpdate: scripts.onUpdate ?? '',
      onEntityAddComponent: scripts.onEntityAddComponent ?? '',
      onEntityRemoveComponent: scripts.onEntityRemoveComponent ?? '',
      onEntityAddToWorld: scripts.onEntityAddToWorld ?? '',
      onEntityRemoveFromWorld: scripts.onEntityRemoveFromWorld ?? '',
    };
  }

  setScript(lifecycle: ScriptLifecycleName, code: string): this {
    if (this.scripts[lifecycle] === code) return this;
    this.scripts[lifecycle] = code;
    this._version++;
    for (const listener of this._listeners) listener(this, lifecycle);
    return this;
  }

  getScript(lifecycle: ScriptLifecycleName): string {
    return this.scripts[lifecycle];
  }

  get version(): number { return this._version; }

  onChange(listener: (resource: ScriptResource, lifecycle: ScriptLifecycleName) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}
