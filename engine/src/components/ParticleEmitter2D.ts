import { Component, UniqueCheckType } from '../ecs/Component';

export type ParticleScalarRange = number | readonly [number, number];
export type ParticleColor = readonly [number, number, number, number];
export type ParticleEmitterShape2D = 'point' | 'box' | 'circle';
export type ParticleBlendMode = 'normal' | 'additive';

export interface ParticleTextureSource {
  readonly value: GPUTexture;
}

export interface ParticleEmitter2DOptions {
  maxParticles?: number;
  emissionRate?: number;
  burst?: number;
  duration?: number;
  loop?: boolean;
  seed?: number;
  lifetime?: ParticleScalarRange;
  speed?: ParticleScalarRange;
  angle?: ParticleScalarRange;
  gravity?: readonly [number, number];
  startSize?: ParticleScalarRange;
  endSize?: ParticleScalarRange;
  startColor?: ParticleColor;
  endColor?: ParticleColor;
  shape?: ParticleEmitterShape2D;
  shapeSize?: readonly [number, number];
  shapeRadius?: number;
  blendMode?: ParticleBlendMode;
  texture?: GPUTexture | null;
  textureSource?: ParticleTextureSource | null;
  radial?: boolean;
  playing?: boolean;
  emitting?: boolean;
}

const MAX_PARTICLES = 1_000_000;
const INSTANCE_FLOATS = 8;

/** Fixed-capacity, allocation-free particle simulation state. Rendering is handled by Particle2DRenderSystem. */
export class ParticleEmitter2D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('ParticleEmitter2D');

  readonly maxParticles: number;
  emissionRate: number;
  burst: number;
  duration: number;
  loop: boolean;
  lifetime: ParticleScalarRange;
  speed: ParticleScalarRange;
  angle: ParticleScalarRange;
  gravity: [number, number];
  startSize: ParticleScalarRange;
  endSize: ParticleScalarRange;
  startColor: ParticleColor;
  endColor: ParticleColor;
  shape: ParticleEmitterShape2D;
  shapeSize: [number, number];
  shapeRadius: number;
  blendMode: ParticleBlendMode;
  radial: boolean;
  playing: boolean;
  emitting: boolean;
  opacity = 1;
  texture: GPUTexture | null;
  textureSource: ParticleTextureSource | null;

  private readonly _positions: Float32Array;
  private readonly _velocities: Float32Array;
  private readonly _ages: Float32Array;
  private readonly _lifetimes: Float32Array;
  private readonly _startSizes: Float32Array;
  private readonly _endSizes: Float32Array;
  private readonly _startColors: Float32Array;
  private readonly _endColors: Float32Array;
  private readonly _instanceData: Float32Array;
  private _count = 0;
  private _time = 0;
  private _emissionCarry = 0;
  private _pendingBurst: number;
  private _randomState: number;
  private readonly _seed: number;
  private _revision = 0;

  constructor(options: ParticleEmitter2DOptions = {}) {
    super('ParticleEmitter2D');
    this.maxParticles = positiveInteger(options.maxParticles ?? 1024, 'maxParticles', MAX_PARTICLES);
    this.emissionRate = nonNegative(options.emissionRate ?? 30, 'emissionRate');
    this.burst = nonNegativeInteger(options.burst ?? 0, 'burst', this.maxParticles);
    this.duration = positive(options.duration ?? Number.POSITIVE_INFINITY, 'duration', true);
    this.loop = options.loop ?? true;
    this._seed = normalizeSeed(options.seed ?? 0x6d2b79f5);
    this._randomState = this._seed;
    this.lifetime = range(options.lifetime ?? [0.8, 1.6], 'lifetime', 1e-4);
    this.speed = range(options.speed ?? [40, 100], 'speed', 0);
    this.angle = range(options.angle ?? [0, Math.PI * 2], 'angle');
    this.gravity = vec2(options.gravity ?? [0, -20], 'gravity');
    this.startSize = range(options.startSize ?? [8, 18], 'startSize', 0);
    this.endSize = range(options.endSize ?? [0, 4], 'endSize', 0);
    this.startColor = color(options.startColor ?? [1, 1, 1, 1], 'startColor');
    this.endColor = color(options.endColor ?? [1, 1, 1, 0], 'endColor');
    this.shape = enumValue(options.shape ?? 'point', ['point', 'box', 'circle'] as const, 'shape');
    this.shapeSize = vec2(options.shapeSize ?? [0, 0], 'shapeSize', 0);
    this.shapeRadius = nonNegative(options.shapeRadius ?? 0, 'shapeRadius');
    this.blendMode = enumValue(options.blendMode ?? 'normal', ['normal', 'additive'] as const, 'blendMode');
    this.texture = options.texture ?? null;
    this.textureSource = options.textureSource ?? null;
    this.radial = options.radial ?? true;
    this.playing = options.playing ?? true;
    this.emitting = options.emitting ?? true;
    this._pendingBurst = this.burst;

    this._positions = new Float32Array(this.maxParticles * 2);
    this._velocities = new Float32Array(this.maxParticles * 2);
    this._ages = new Float32Array(this.maxParticles);
    this._lifetimes = new Float32Array(this.maxParticles);
    this._startSizes = new Float32Array(this.maxParticles);
    this._endSizes = new Float32Array(this.maxParticles);
    this._startColors = new Float32Array(this.maxParticles * 4);
    this._endColors = new Float32Array(this.maxParticles * 4);
    this._instanceData = new Float32Array(this.maxParticles * INSTANCE_FLOATS);
  }

  get activeParticles(): number { return this._count; }
  get simulationTime(): number { return this._time; }
  get revision(): number { return this._revision; }
  get instanceData(): Float32Array { return this._instanceData; }

  resolveTexture(): GPUTexture | null {
    if (!this.textureSource) return this.texture;
    try { return this.textureSource.value; } catch { return null; }
  }

  emit(count: number): this {
    const requested = nonNegativeInteger(count, 'emit count', this.maxParticles);
    for (let index = 0; index < requested && this._count < this.maxParticles; index++) this._spawn();
    return this;
  }

  advance(seconds: number): this {
    if (!this.playing || !Number.isFinite(seconds) || seconds <= 0) return this;
    this._time += seconds;
    this._simulate(seconds);
    if (this.emitting && (this.loop || this._time <= this.duration)) {
      if (this._pendingBurst > 0) {
        const burst = this._pendingBurst;
        this._pendingBurst = 0;
        this.emit(burst);
      }
      this._emissionCarry += this.emissionRate * seconds;
      const count = Math.floor(this._emissionCarry);
      this._emissionCarry -= count;
      this.emit(count);
    }
    return this;
  }

  restart(clear = true): this {
    if (clear) this.clear();
    this._time = 0;
    this._emissionCarry = 0;
    this._pendingBurst = this.burst;
    this._randomState = this._seed;
    this.playing = true;
    return this;
  }

  /** Deterministically rebuilds state without retaining per-particle history snapshots. */
  seek(seconds: number, maxSteps = 3600): this {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('seek seconds must be finite and non-negative.');
    positiveInteger(maxSteps, 'maxSteps', 1_000_000);
    const wasPlaying = this.playing;
    this.restart(true);
    const step = seconds > 0 ? Math.max(1 / 60, seconds / maxSteps) : 1 / 60;
    let remaining = seconds;
    while (remaining > 1e-8) {
      const delta = Math.min(step, remaining);
      this.advance(delta);
      remaining -= delta;
    }
    this.playing = wasPlaying;
    return this;
  }

  clear(): this {
    if (this._count > 0) this._revision++;
    this._count = 0;
    return this;
  }

  override clone(): ParticleEmitter2D {
    return new ParticleEmitter2D({
      maxParticles: this.maxParticles,
      emissionRate: this.emissionRate,
      burst: this.burst,
      duration: this.duration,
      loop: this.loop,
      seed: this._seed,
      lifetime: cloneRange(this.lifetime),
      speed: cloneRange(this.speed),
      angle: cloneRange(this.angle),
      gravity: [...this.gravity],
      startSize: cloneRange(this.startSize),
      endSize: cloneRange(this.endSize),
      startColor: [...this.startColor],
      endColor: [...this.endColor],
      shape: this.shape,
      shapeSize: [...this.shapeSize],
      shapeRadius: this.shapeRadius,
      blendMode: this.blendMode,
      texture: this.texture,
      textureSource: this.textureSource,
      radial: this.radial,
      playing: this.playing,
      emitting: this.emitting,
    });
  }

  private _simulate(seconds: number): void {
    const gx = this.gravity[0], gy = this.gravity[1];
    let index = 0;
    while (index < this._count) {
      const age = this._ages[index]! + seconds;
      const lifetime = this._lifetimes[index]!;
      if (age >= lifetime) {
        this._remove(index);
        continue;
      }
      this._ages[index] = age;
      const offset2 = index * 2;
      const vx = this._velocities[offset2]! + gx * seconds;
      const vy = this._velocities[offset2 + 1]! + gy * seconds;
      this._velocities[offset2] = vx;
      this._velocities[offset2 + 1] = vy;
      this._positions[offset2] = this._positions[offset2]! + vx * seconds;
      this._positions[offset2 + 1] = this._positions[offset2 + 1]! + vy * seconds;
      this._writeInstance(index, age / lifetime);
      index++;
    }
    this._revision++;
  }

  private _spawn(): void {
    const index = this._count++;
    const offset2 = index * 2;
    const position = this._spawnPosition();
    this._positions[offset2] = position[0];
    this._positions[offset2 + 1] = position[1];
    const angle = sample(this.angle, () => this._random());
    const speed = sample(this.speed, () => this._random());
    this._velocities[offset2] = Math.cos(angle) * speed;
    this._velocities[offset2 + 1] = Math.sin(angle) * speed;
    this._ages[index] = 0;
    this._lifetimes[index] = sample(this.lifetime, () => this._random());
    this._startSizes[index] = sample(this.startSize, () => this._random());
    this._endSizes[index] = sample(this.endSize, () => this._random());
    this._startColors.set(this.startColor, index * 4);
    this._endColors.set(this.endColor, index * 4);
    this._writeInstance(index, 0);
    this._revision++;
  }

  private _spawnPosition(): [number, number] {
    if (this.shape === 'box') return [(this._random() - 0.5) * this.shapeSize[0], (this._random() - 0.5) * this.shapeSize[1]];
    if (this.shape === 'circle') {
      const angle = this._random() * Math.PI * 2;
      const radius = Math.sqrt(this._random()) * this.shapeRadius;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    }
    return [0, 0];
  }

  private _writeInstance(index: number, progress: number): void {
    const source2 = index * 2;
    const source4 = index * 4;
    const target = index * INSTANCE_FLOATS;
    const t = Math.min(1, Math.max(0, progress));
    this._instanceData[target] = this._positions[source2]!;
    this._instanceData[target + 1] = this._positions[source2 + 1]!;
    this._instanceData[target + 2] = mix(this._startSizes[index]!, this._endSizes[index]!, t);
    this._instanceData[target + 3] = Math.atan2(this._velocities[source2 + 1]!, this._velocities[source2]!);
    for (let channel = 0; channel < 4; channel++) {
      this._instanceData[target + 4 + channel] = mix(this._startColors[source4 + channel]!, this._endColors[source4 + channel]!, t);
    }
  }

  private _remove(index: number): void {
    const last = --this._count;
    if (index === last) return;
    copyStride(this._positions, last, index, 2);
    copyStride(this._velocities, last, index, 2);
    this._ages[index] = this._ages[last]!;
    this._lifetimes[index] = this._lifetimes[last]!;
    this._startSizes[index] = this._startSizes[last]!;
    this._endSizes[index] = this._endSizes[last]!;
    copyStride(this._startColors, last, index, 4);
    copyStride(this._endColors, last, index, 4);
    copyStride(this._instanceData, last, index, INSTANCE_FLOATS);
  }

  private _random(): number {
    let value = this._randomState;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this._randomState = value >>> 0;
    return this._randomState / 0x1_0000_0000;
  }
}

function sample(value: ParticleScalarRange, random: () => number): number {
  return typeof value === 'number' ? value : value[0] + (value[1] - value[0]) * random();
}
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function copyStride(array: Float32Array, source: number, target: number, stride: number): void {
  for (let index = 0; index < stride; index++) array[target * stride + index] = array[source * stride + index]!;
}
function cloneRange(value: ParticleScalarRange): ParticleScalarRange { return typeof value === 'number' ? value : [value[0], value[1]]; }
function normalizeSeed(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('seed must be a safe integer.');
  return (value >>> 0) || 1;
}
function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} must be an integer in [1, ${maximum}].`);
  return value;
}
function nonNegativeInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`${label} must be an integer in [0, ${maximum}].`);
  return value;
}
function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative.`);
  return value;
}
function positive(value: number, label: string, allowInfinity = false): number {
  if ((allowInfinity && value === Number.POSITIVE_INFINITY) || (Number.isFinite(value) && value > 0)) return value;
  throw new RangeError(`${label} must be positive${allowInfinity ? ' or Infinity' : ''}.`);
}
function range(value: ParticleScalarRange, label: string, minimum = -Infinity): ParticleScalarRange {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < minimum) throw new RangeError(`${label} is outside its supported range.`);
    return value;
  }
  if (value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < minimum || value[1] < value[0]) {
    throw new RangeError(`${label} range must be finite, ascending, and above ${minimum}.`);
  }
  return Object.freeze([value[0], value[1]] as [number, number]);
}
function vec2(value: readonly [number, number], label: string, minimum = -Infinity): [number, number] {
  if (value.length !== 2 || value.some(entry => !Number.isFinite(entry) || entry < minimum)) throw new RangeError(`${label} must contain two supported finite numbers.`);
  return [value[0], value[1]];
}
function color(value: ParticleColor, label: string): ParticleColor {
  if (value.length !== 4 || value.some(entry => !Number.isFinite(entry) || entry < 0 || entry > 1)) throw new RangeError(`${label} must be RGBA in [0, 1].`);
  return Object.freeze([value[0], value[1], value[2], value[3]]);
}
function enumValue<const T extends readonly string[]>(value: string, values: T, label: string): T[number] {
  if (!values.includes(value)) throw new RangeError(`${label} must be one of ${values.join(', ')}.`);
  return value as T[number];
}
