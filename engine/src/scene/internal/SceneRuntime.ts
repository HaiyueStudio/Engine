import { EngineError, EngineErrorCode } from '../../core/EngineError';
import type { GPUResourceScope } from '../../core/GPUResourceTracker';
import type { IEngine } from '../../core/IEngine';
import { getEngineGPUResourceTracker } from '../../core/EngineDiagnosticsAccess';
import type { SceneLifecycleState } from '../../core/Lifecycle';
import { World } from '../../ecs/World';

export class SceneRuntime {
  readonly world: World;
  private _state: SceneLifecycleState = 'created';
  private readonly _resourceScope: GPUResourceScope | null;

  constructor(engine: IEngine, name = 'Scene') {
    this.world = new World(name);
    this._resourceScope = getEngineGPUResourceTracker(engine)?.createScope('scene', name) ?? null;
  }

  get state(): SceneLifecycleState { return this._state; }

  update(time = performance.now(), delta = 0): void {
    this.assertUsable('update');
    this.world.update(time, delta);
  }

  activate(): void {
    this.assertUsable('activate');
    this._state = 'active';
    this.world.disabled = false;
  }

  deactivate(): void {
    this.assertUsable('deactivate');
    this._state = 'inactive';
    this.world.disabled = true;
  }

  beginDestroy(): boolean {
    if (this._state === 'destroyed' || this._state === 'destroying') return false;
    this._state = 'destroying';
    return true;
  }

  finishDestroy(): void {
    this.world.destroy();
    this._resourceScope?.release();
    this._state = 'destroyed';
  }

  assertUsable(operation: string): void {
    if (this._state === 'destroyed' || this._state === 'destroying') throw this.createDestroyedError(operation);
  }

  createDestroyedError(operation: string): EngineError {
    return new EngineError(
      EngineErrorCode.SceneDestroyed,
      `Cannot call Scene.${operation}() after scene destruction has started.`,
      { context: { operation, state: this._state, scene: this.world.name } },
    );
  }
}
