import type {
  HyaStateMachineExtension,
  ParsedAnimation,
} from '@haiyue/animation-spec';
import type { Entity } from '@haiyue/engine';
import type { AssetManager } from '@haiyue/engine/assets';
import type {
  AnimationStateMachineDefinition,
} from '../animation-state-machine/AnimationStateMachine.js';
import type {
  AnimationStateMachineController,
  AnimationStateMachineLayerSnapshot,
} from '../animation-state-machine/runtime/index.js';
import {
  Animation2DStateMachineMixerAdapter,
  runAnimationStateMachineControllerUpdateTransaction,
  type Animation2DStateMachineActionRuntimeHandle,
} from '../animation-state-machine/runtime/index.js';
import type { AnimationStateMachineChannelDiagnostic } from '../animation-state-machine/AnimationStateMachineChannels.js';
import { createAnimation2DStateMachineController } from './Animation2DStateMachine.js';
import type { Animation2DExtensionRegistry } from './Animation2DExtensionRegistry.js';
import { Animation2DStateMachineVisualRuntime } from './Animation2DStateMachineVisualRuntime.js';
import { createHyaAnimation2DClips } from './HyaAnimation2DClipAdapter.js';
import {
  Animation2DMixerRuntime,
  Animation2DPoseBuffer,
} from './runtime/mixer/index.js';
import type { Animation2DRuntimeStats } from './Animation2DComponent.js';

export type Animation2DStateMachineParameterValue = number | boolean;

export class Animation2DStateMachineRuntime {
  private readonly _mixer: Animation2DMixerRuntime;
  private readonly _adapter: Animation2DStateMachineMixerAdapter;
  private readonly _pose = new Animation2DPoseBuffer();
  private readonly _visual!: Animation2DStateMachineVisualRuntime;
  private _destroyed = false;

  readonly controller!: AnimationStateMachineController<Animation2DStateMachineActionRuntimeHandle>;

  constructor(
    owner: Entity,
    animation: ParsedAnimation,
    readonly extension: HyaStateMachineExtension,
    parameterValues: ReadonlyMap<string, Animation2DStateMachineParameterValue>,
    runtimeExtensions?: Animation2DExtensionRegistry,
    assetManager?: AssetManager,
  ) {
    const clips = createHyaAnimation2DClips(animation, extension);
    this._mixer = new Animation2DMixerRuntime(clips);
    this._adapter = new Animation2DStateMachineMixerAdapter(this._mixer);
    let visual: Animation2DStateMachineVisualRuntime | undefined;
    try {
      this.controller = createAnimation2DStateMachineController(
        extension.stateMachine as AnimationStateMachineDefinition,
        this._adapter,
      );
      applyParameterValues(this.controller, extension, parameterValues);
      this.controller.update(0);
      visual = new Animation2DStateMachineVisualRuntime(
        owner,
        animation,
        runtimeExtensions,
        assetManager,
      );
      this._visual = visual;
    } catch (error) {
      visual?.destroy();
      this.controller?.destroy();
      this._adapter.destroy();
      this._mixer.destroy();
      throw error;
    }
  }

  get stats(): Animation2DRuntimeStats { return this._visual.stats; }
  get diagnostics(): readonly AnimationStateMachineChannelDiagnostic[] { return this._visual.diagnostics; }
  get liveActionCount(): number { return this._adapter.liveActionCount; }
  get liveBindingCount(): number { return this._adapter.liveBindingCount; }
  get sideEffectOwnerCount(): number { return this._visual.sideEffectOwnerCount; }
  get layerSnapshots(): readonly AnimationStateMachineLayerSnapshot[] {
    return this.controller.layerSnapshots;
  }

  update(deltaSeconds: number, playing: boolean, speed: number): void {
    this._requireActive();
    const pose = runAnimationStateMachineControllerUpdateTransaction(
      this.controller,
      playing ? deltaSeconds * speed : 0,
      () => undefined,
      () => this._mixer.evaluate(this._pose),
    );
    this._visual.applyPose(pose, playing, speed);
  }

  setPlaying(playing: boolean): void {
    this._requireActive();
    this._visual.setPlaying(playing);
  }

  reset(): void {
    this._requireActive();
    this._visual.resetSideEffects();
    this.controller.reset();
    const pose = runAnimationStateMachineControllerUpdateTransaction(
      this.controller,
      0,
      () => undefined,
      () => this._mixer.evaluate(this._pose),
    );
    this._visual.applyPose(pose, false, 1);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.controller.destroy();
    this._adapter.destroy();
    this._mixer.destroy();
    this._visual.destroy();
  }

  private _requireActive(): void {
    if (this._destroyed) throw new Error('Animation2D state-machine runtime has been destroyed.');
  }
}

function applyParameterValues(
  controller: Animation2DStateMachineRuntime['controller'],
  extension: HyaStateMachineExtension,
  values: ReadonlyMap<string, Animation2DStateMachineParameterValue>,
): void {
  for (const parameter of extension.stateMachine.parameters) {
    if (!values.has(parameter.name)) continue;
    const value = values.get(parameter.name)!;
    if (parameter.type === 'float') controller.setFloat(parameter.name, value as number);
    else if (parameter.type === 'integer') controller.setInteger(parameter.name, value as number);
    else if (parameter.type === 'boolean') controller.setBoolean(parameter.name, value as boolean);
    else if (value) controller.setTrigger(parameter.name);
  }
}
