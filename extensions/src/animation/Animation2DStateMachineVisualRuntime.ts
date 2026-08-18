import type { Entity } from '@haiyue/engine';
import type { AssetManager } from '@haiyue/engine/assets';
import type { ParsedAnimation } from '@haiyue/animation-spec';
import type { Animation2DExtensionRegistry } from './Animation2DExtensionRegistry.js';
import type { HyaAnimation2DEffectPayload } from './HyaAnimation2DClipAdapter.js';
import {
  Animation2DRuntime,
  type Animation2DRuntimeNode,
} from './Animation2DRuntime.js';
import type { Animation2DEffectEvent, Animation2DPose } from './runtime/mixer/index.js';
import {
  audioAutoplayRejectedDiagnostic,
  type AnimationStateMachineChannelDiagnostic,
} from '../animation-state-machine/AnimationStateMachineChannels.js';

/** State-machine-only pose writer kept out of the ordinary Animation2D bundle. */
export class Animation2DStateMachineVisualRuntime extends Animation2DRuntime {
  private readonly _particleOwners = new Map<string, string[]>();
  private readonly _audioOwners = new Map<string, string[]>();
  private readonly _effectPayloads = new Map<string, HyaAnimation2DEffectPayload>();
  private readonly _diagnostics: AnimationStateMachineChannelDiagnostic[] = [];
  private readonly _reportedAudioRejections = new Set<string>();

  constructor(
    owner: Entity,
    animation: ParsedAnimation,
    runtimeExtensions?: Animation2DExtensionRegistry,
    assetManager?: AssetManager,
  ) {
    super(owner, animation, runtimeExtensions, assetManager);
    for (const node of this._nodes) {
      for (const particle of node.particles) {
        particle.playing = false;
        particle.emitting = false;
        particle.clear();
      }
      for (const audio of node.audio) audio.exitStateMachine();
    }
  }

  get diagnostics(): readonly AnimationStateMachineChannelDiagnostic[] {
    return this._diagnostics;
  }

  get sideEffectOwnerCount(): number {
    return ownerCount(this._particleOwners) + ownerCount(this._audioOwners);
  }

  resetSideEffects(): void {
    this._particleOwners.clear();
    this._audioOwners.clear();
    this._effectPayloads.clear();
    for (const node of this._nodes) {
      for (const particle of node.particles) {
        particle.playing = false;
        particle.emitting = false;
        particle.clear();
      }
      for (const audio of node.audio) audio.exitStateMachine();
    }
  }

  applyPose(pose: Animation2DPose, playing = this._playing, speed = this._speed): void {
    this._playing = playing;
    this._speed = speed;
    this._opacityMemo.clear();
    for (const node of this._nodes) {
      node.entity.disabled = false;
      node.transform.setPosition(node.initialX, node.initialY);
      node.transform.rotation = node.initialRotation;
      node.transform.setScale(node.initialScaleX, node.initialScaleY);
      node.opacity = node.initialOpacity;
    }
    for (const channel of pose.channels) {
      const node = this._nodesById.get(channel.binding.targetId);
      if (!node) {
        throw new ReferenceError(`Animation2D pose references unknown node "${channel.binding.targetId}".`);
      }
      switch (channel.binding.path) {
        case 'transform.position': {
          const value = numericPoseValue(channel.value, channel.binding.id, 2);
          node.transform.setPosition(value[0]!, -value[1]!);
          break;
        }
        case 'transform.rotation': {
          const value = numericPoseValue(channel.value, channel.binding.id, 1);
          node.transform.rotation = -value[0]!;
          break;
        }
        case 'transform.scale': {
          const value = numericPoseValue(channel.value, channel.binding.id, 2);
          node.transform.setScale(value[0]!, value[1]!);
          break;
        }
        case 'opacity': {
          const value = numericPoseValue(channel.value, channel.binding.id, 1);
          node.opacity = clamp(value[0]!, 0, 1);
          break;
        }
        case 'visibility':
          if (typeof channel.value !== 'boolean') {
            throw new TypeError(`Animation2D visibility binding "${channel.binding.id}" requires a boolean.`);
          }
          node.entity.disabled = !channel.value;
          break;
        default:
          if (!this._applyStateMachineVisualChannel(node, channel.binding.path, channel.value)) {
            throw new RangeError(`Animation2D state-machine runtime does not support pose binding path "${channel.binding.path}".`);
          }
      }
    }
    for (const node of this._nodes) this._applyVisualOpacity(node);
    for (const [key, owners] of this._audioOwners) {
      if (owners.length === 0) continue;
      const target = parseEffectTargetKey(key);
      const node = this._nodesById.get(target.targetId);
      this._audioTarget(key)?.updateStateMachineProperties(
        speed,
        node ? this._resolveOpacity(node) : 1,
      );
    }
    for (const effect of pose.effects) this._applyEffect(effect, playing, speed);
    this._lastAppliedTime = Number.NaN;
  }

  override setPlaying(playing: boolean): void {
    this._playing = playing;
    for (const [key, owners] of this._particleOwners) {
      if (owners.length === 0) continue;
      const target = this._particleTarget(key);
      if (target) target.playing = playing;
    }
    for (const [key, owners] of this._audioOwners) {
      if (owners.length === 0) continue;
      const target = this._audioTarget(key);
      target?.setStateMachinePlaying(playing, this._speed, reason => this._reportAudioRejection(key, reason));
    }
  }

  override destroy(): void {
    this.resetSideEffects();
    super.destroy();
  }

  private _applyVisualOpacity(node: Animation2DRuntimeNode): void {
    const opacity = this._resolveOpacity(node);
    if (node.deferredVisuals.length > 0 && this._isNodeActive(node)) {
      for (const deferred of node.deferredVisuals.splice(0)) this._materializeCoreVisual(node, deferred);
    }
    for (const visual of node.visuals) {
      const alpha = visual.baseAlpha * opacity;
      if (Math.abs(alpha - visual.lastAlpha) < 1e-6) continue;
      visual.color[3] = alpha;
      visual.component.revision++;
      visual.lastAlpha = alpha;
    }
    for (const extension of node.extensions) extension.setOpacity?.(opacity);
  }

  private _applyEffect(effect: Animation2DEffectEvent, playing: boolean, speed: number): void {
    const payload = effect.cue.payload as HyaAnimation2DEffectPayload | undefined;
    if (!payload || typeof payload.targetId !== 'string' || !Number.isSafeInteger(payload.slot)) {
      throw new TypeError(`Animation2D effect cue "${effect.cue.id}" has an invalid HYA target payload.`);
    }
    const key = effectTargetKey(payload);
    this._effectPayloads.set(key, payload);
    const owners = effect.cue.kind === 'particle'
      ? this._particleOwners
      : this._audioOwners;
    const stack = owners.get(key) ?? [];
    if (!owners.has(key)) owners.set(key, stack);

    if (effect.lifecycle === 'enter') {
      const existing = stack.indexOf(effect.actionId);
      if (existing >= 0) stack.splice(existing, 1);
      stack.push(effect.actionId);
      if (effect.cue.kind === 'particle') {
        const particle = this._particleTarget(key);
        if (particle) {
          particle.emitting = true;
          particle.restart(true);
          particle.playing = playing;
        }
      } else {
        const audio = this._audioTarget(key);
        const node = this._nodesById.get(payload.targetId);
        const opacity = node ? this._resolveOpacity(node) : 1;
        audio?.enterStateMachine(playing, speed, opacity, reason => this._reportAudioRejection(key, reason));
      }
      return;
    }

    if (effect.lifecycle === 'exit') {
      const index = stack.indexOf(effect.actionId);
      const wasDominant = index === stack.length - 1;
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) {
        owners.delete(key);
        if (effect.cue.kind === 'particle') {
          const particle = this._particleTarget(key);
          if (particle) {
            particle.playing = false;
            particle.emitting = false;
            particle.clear();
          }
        } else this._audioTarget(key)?.exitStateMachine();
      } else if (wasDominant && effect.cue.kind === 'particle') {
        const particle = this._particleTarget(key);
        if (particle) {
          particle.emitting = true;
          particle.restart(true);
          particle.playing = playing;
        }
      }
      return;
    }

    if (stack[stack.length - 1] !== effect.actionId) return;
    if (effect.lifecycle === 'loop') return;
    if (effect.cue.kind === 'particle') {
      const particle = this._particleTarget(key);
      if (particle) {
        particle.emitting = true;
        particle.restart(true);
        particle.playing = playing;
      }
    } else {
      const audio = this._audioTarget(key);
      const node = this._nodesById.get(payload.targetId);
      const opacity = node ? this._resolveOpacity(node) : 1;
      audio?.restartStateMachine(playing, speed, opacity, reason => this._reportAudioRejection(key, reason));
    }
  }

  private _particleTarget(key: string) {
    const target = parseEffectTargetKey(key);
    return this._nodesById.get(target.targetId)?.particles[target.slot];
  }

  private _audioTarget(key: string) {
    const target = parseEffectTargetKey(key);
    return this._nodesById.get(target.targetId)?.audio[target.slot];
  }

  private _reportAudioRejection(key: string, reason: unknown): void {
    if (this._reportedAudioRejections.has(key)) return;
    this._reportedAudioRejections.add(key);
    const target = parseEffectTargetKey(key);
    const sourcePath = this._effectPayloads.get(key)?.sourcePath
      ?? `$.nodes[id=${JSON.stringify(target.targetId)}].components[audio=${target.slot}]`;
    this._diagnostics.push(audioAutoplayRejectedDiagnostic(sourcePath, reason));
  }
}

function effectTargetKey(payload: HyaAnimation2DEffectPayload): string {
  return `${payload.targetId}\u0000${payload.slot}`;
}

function parseEffectTargetKey(key: string): { readonly targetId: string; readonly slot: number } {
  const separator = key.lastIndexOf('\u0000');
  return {
    targetId: key.slice(0, separator),
    slot: Number(key.slice(separator + 1)),
  };
}

function ownerCount(owners: ReadonlyMap<string, readonly string[]>): number {
  let count = 0;
  for (const stack of owners.values()) count += stack.length;
  return count;
}

function numericPoseValue(value: unknown, bindingId: string, size: number): Readonly<Float32Array> {
  if (!(value instanceof Float32Array) || value.length < size) {
    throw new TypeError(`Animation2D numeric binding "${bindingId}" requires ${size} Float32 values.`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
