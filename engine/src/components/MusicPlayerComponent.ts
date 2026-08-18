import { ComponentLifecycleFlags, ComponentWithData, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { requiredItemAt } from '../math/arrayAccess';

export interface MusicPlayerOptions {
  urls: string[];
  volume?: number;
  autoplay?: boolean;
  loop?: boolean;
}

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext ?? null;
}

export class MusicPlayerComponent extends ComponentWithData<Required<MusicPlayerOptions>> {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('MusicPlayerComponent');
  static override Lifecycle =
    ComponentLifecycleFlags.EntityAddToWorld |
    ComponentLifecycleFlags.EntityRemoveFromWorld;

  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers: AudioBuffer[] = [];
  private source: AudioBufferSourceNode | null = null;
  private loading: Promise<void> | null = null;
  private currentIndex = 0;
  private wantsPlay = false;
  private stopping = false;
  private unlocked = false;

  constructor(options: MusicPlayerOptions) {
    super({
      urls: [...options.urls],
      volume: options.volume ?? 0.55,
      autoplay: options.autoplay ?? true,
      loop: options.loop ?? true,
    }, 'MusicPlayerComponent');
  }

  get volume(): number {
    return this.data.volume;
  }

  set volume(value: number) {
    const data = this.data;
    data.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = data.volume;
  }

  async play(index = this.currentIndex): Promise<void> {
    this.wantsPlay = true;
    await this.ensureReady();
    if (!this.context || !this.gain || this.buffers.length === 0) return;
    if (this.context.state === 'suspended') {
      await this.context.resume().catch((): undefined => undefined);
      if (this.context.state === 'suspended') {
        this.installUnlockListeners();
        return;
      }
    }
    this.startBuffer(index);
  }

  pause(): void {
    this.wantsPlay = false;
    void this.context?.suspend();
  }

  stop(): void {
    this.wantsPlay = false;
    this.stopSource();
    this.currentIndex = 0;
  }

  onEntityAddToWorld(_entity: Entity, _world: World): void {
    if (this.data.autoplay) void this.play(0);
  }

  onEntityRemoveFromWorld(): void {
    this.removeUnlockListeners();
    this.stop();
  }

  override destroy(): void {
    this.removeUnlockListeners();
    this.stop();
    void this.context?.close();
    this.context = null;
    this.gain = null;
    this.buffers = [];
    super.destroy();
  }

  override clone(): MusicPlayerComponent {
    const data = this.data;
    return new MusicPlayerComponent({
      urls: [...data.urls],
      volume: data.volume,
      autoplay: data.autoplay,
      loop: data.loop,
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.buffers.length > 0) return;
    if (this.loading) return this.loading;
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const ContextCtor = getAudioContextConstructor();
    if (!ContextCtor || !this.data.urls.length) return;
    const urls = [...this.data.urls];
    this.context = this.context ?? new ContextCtor();
    this.gain = this.gain ?? this.context.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.context.destination);
    const buffers = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load audio: ${url}`);
      const data = await response.arrayBuffer();
      return this.context!.decodeAudioData(data);
    }));
    this.buffers = buffers;
  }

  private startBuffer(index: number): void {
    if (!this.context || !this.gain || this.buffers.length === 0) return;
    this.stopSource();
    this.currentIndex = ((index % this.buffers.length) + this.buffers.length) % this.buffers.length;
    const source = this.context.createBufferSource();
    source.buffer = requiredItemAt(this.buffers, this.currentIndex, 'MusicPlayer decoded buffers');
    source.connect(this.gain);
    source.onended = () => {
      if (this.stopping || !this.wantsPlay) return;
      const next = this.currentIndex + 1;
      if (next >= this.buffers.length && !this.data.loop) {
        this.wantsPlay = false;
        return;
      }
      this.startBuffer(next);
    };
    this.source = source;
    source.start();
  }

  private stopSource(): void {
    if (!this.source) return;
    this.stopping = true;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // The source may already have ended.
    }
    this.source.disconnect();
    this.source = null;
    this.stopping = false;
  }

  private installUnlockListeners(): void {
    if (this.unlocked || typeof window === 'undefined') return;
    window.addEventListener('pointerdown', this.unlock, { once: true });
    window.addEventListener('keydown', this.unlock, { once: true });
    this.unlocked = true;
  }

  private removeUnlockListeners(): void {
    if (!this.unlocked || typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    this.unlocked = false;
  }

  private readonly unlock = (): void => {
    this.removeUnlockListeners();
    if (this.wantsPlay) void this.play(this.currentIndex);
  };
}
