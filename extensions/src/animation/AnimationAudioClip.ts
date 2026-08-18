import type { AnimationAudioComponent, AnimationNode } from '@haiyue/animation-spec';

/** HTML media-backed audio clip with composition-time seek and playback-rate synchronization. */
export class AnimationAudioClip {
  private readonly element: HTMLAudioElement | null;
  private readonly nodeStart: number;
  private readonly nodeEnd: number;
  private readonly startOffset: number;
  private readonly baseVolume: number;
  private readonly clipRate: number;
  private readonly loop: boolean;
  private playPending = false;
  private destroyed = false;
  private stateMachineActive = false;
  private playRequestEpoch = 0;

  constructor(uri: string, component: AnimationAudioComponent, node: Readonly<AnimationNode>, animationDuration: number) {
    this.nodeStart = node.start ?? 0;
    this.nodeEnd = this.nodeStart + (node.duration ?? animationDuration - this.nodeStart);
    this.startOffset = component.startOffset ?? 0;
    this.baseVolume = component.volume ?? 1;
    this.clipRate = component.playbackRate ?? 1;
    this.loop = component.loop ?? false;
    this.element = typeof Audio === 'undefined' ? null : new Audio(uri);
    if (this.element) {
      this.element.preload = 'auto';
      this.element.loop = this.loop;
    }
  }

  sync(compositionTime: number, playing: boolean, speed: number, opacity: number): void {
    const element = this.element;
    if (!element || this.destroyed) return;
    const active = compositionTime >= this.nodeStart && compositionTime <= this.nodeEnd;
    element.volume = clamp(this.baseVolume * opacity, 0, 1);
    element.playbackRate = clamp(this.clipRate * speed, 0.0625, 16);
    if (!active || !playing || speed <= 0) {
      this._cancelPendingPlay();
      return;
    }
    let target = this.startOffset + (compositionTime - this.nodeStart) * this.clipRate;
    if (this.loop && Number.isFinite(element.duration) && element.duration > 0) target %= element.duration;
    if (Number.isFinite(target) && Math.abs(element.currentTime - target) > 0.12) {
      try { element.currentTime = Math.max(0, target); } catch { /* Metadata may not be loaded yet. */ }
    }
    if (element.paused) this._requestPlay();
  }

  enterStateMachine(
    playing: boolean,
    speed: number,
    opacity: number,
    rejected: (reason: unknown) => void,
  ): void {
    const element = this.element;
    if (!element || this.destroyed) return;
    this.stateMachineActive = true;
    element.volume = clamp(this.baseVolume * opacity, 0, 1);
    element.playbackRate = clamp(this.clipRate * Math.max(speed, 0.0625), 0.0625, 16);
    try { element.currentTime = Math.max(0, this.startOffset); } catch { /* Metadata may not be loaded yet. */ }
    if (playing && speed > 0) this._requestPlay(rejected);
    else this._cancelPendingPlay();
  }

  restartStateMachine(
    playing: boolean,
    speed: number,
    opacity: number,
    rejected: (reason: unknown) => void,
  ): void {
    this.enterStateMachine(playing, speed, opacity, rejected);
  }

  setStateMachinePlaying(
    playing: boolean,
    speed: number,
    rejected: (reason: unknown) => void,
  ): void {
    const element = this.element;
    if (!element || this.destroyed || !this.stateMachineActive) return;
    element.playbackRate = clamp(this.clipRate * Math.max(speed, 0.0625), 0.0625, 16);
    if (playing && speed > 0) this._requestPlay(rejected);
    else this._cancelPendingPlay();
  }

  updateStateMachineProperties(speed: number, opacity: number): void {
    const element = this.element;
    if (!element || this.destroyed || !this.stateMachineActive) return;
    element.volume = clamp(this.baseVolume * opacity, 0, 1);
    element.playbackRate = clamp(this.clipRate * Math.max(speed, 0.0625), 0.0625, 16);
  }

  exitStateMachine(): void {
    this.stateMachineActive = false;
    this._cancelPendingPlay();
  }

  pause(): void { this._cancelPendingPlay(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stateMachineActive = false;
    const element = this.element;
    if (!element) return;
    this._cancelPendingPlay();
    element.removeAttribute('src');
    element.load();
  }

  private _requestPlay(rejected?: (reason: unknown) => void): void {
    const element = this.element;
    if (!element || this.playPending || this.destroyed) return;
    const epoch = ++this.playRequestEpoch;
    const stateMachineRequest = rejected !== undefined;
    this.playPending = true;
    void element.play()
      .then(() => {
        if (epoch !== this.playRequestEpoch
          || this.destroyed
          || (stateMachineRequest && !this.stateMachineActive)) element.pause();
      })
      .catch(reason => {
        if (epoch === this.playRequestEpoch) rejected?.(reason);
      })
      .finally(() => {
        if (epoch === this.playRequestEpoch) this.playPending = false;
      });
  }

  private _cancelPendingPlay(): void {
    this.playRequestEpoch++;
    this.playPending = false;
    this.element?.pause();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
