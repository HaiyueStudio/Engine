import { Component, UniqueCheckType } from '../ecs/Component';
import type {
  ParticleBlendMode,
  ParticleColor,
  ParticleScalarRange,
  ParticleTextureSource,
} from './ParticleEmitter2D';

export type ParticleEmitterShape3D = 'point' | 'box' | 'sphere';
export type ParticleSortMode3D = 'none' | 'back-to-front';

export interface ParticleEmitter3DOptions {
  maxParticles?: number;
  emissionRate?: number;
  burst?: number;
  duration?: number;
  loop?: boolean;
  seed?: number;
  lifetime?: ParticleScalarRange;
  speed?: ParticleScalarRange;
  /** Local-space cone axis. It does not need to be normalized. */
  direction?: readonly [number, number, number];
  /** Cone half-angle in radians, in [0, PI]. */
  spread?: number;
  gravity?: readonly [number, number, number];
  startSize?: ParticleScalarRange;
  endSize?: ParticleScalarRange;
  rotation?: ParticleScalarRange;
  angularVelocity?: ParticleScalarRange;
  startColor?: ParticleColor;
  endColor?: ParticleColor;
  shape?: ParticleEmitterShape3D;
  shapeSize?: readonly [number, number, number];
  shapeRadius?: number;
  blendMode?: ParticleBlendMode;
  texture?: GPUTexture | null;
  textureSource?: ParticleTextureSource | null;
  radial?: boolean;
  playing?: boolean;
  emitting?: boolean;
  opacity?: number;
  depthTest?: boolean;
  depthWrite?: boolean;
  sortMode?: ParticleSortMode3D;
}

const MAX_PARTICLES = 1_000_000;
const INSTANCE_FLOATS = 12;
const TWO_PI = Math.PI * 2;

/** Fixed-capacity CPU simulation for camera-facing 3D particles. */
export class ParticleEmitter3D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('ParticleEmitter3D');

  readonly maxParticles: number;
  emissionRate: number;
  burst: number;
  duration: number;
  loop: boolean;
  lifetime: ParticleScalarRange;
  speed: ParticleScalarRange;
  direction: [number, number, number];
  spread: number;
  gravity: [number, number, number];
  startSize: ParticleScalarRange;
  endSize: ParticleScalarRange;
  rotation: ParticleScalarRange;
  angularVelocity: ParticleScalarRange;
  startColor: ParticleColor;
  endColor: ParticleColor;
  shape: ParticleEmitterShape3D;
  shapeSize: [number, number, number];
  shapeRadius: number;
  blendMode: ParticleBlendMode;
  radial: boolean;
  playing: boolean;
  emitting: boolean;
  opacity: number;
  depthTest: boolean;
  depthWrite: boolean;
  sortMode: ParticleSortMode3D;
  texture: GPUTexture | null;
  textureSource: ParticleTextureSource | null;

  private readonly _positions: Float32Array;
  private readonly _velocities: Float32Array;
  private readonly _ages: Float32Array;
  private readonly _lifetimes: Float32Array;
  private readonly _startSizes: Float32Array;
  private readonly _endSizes: Float32Array;
  private readonly _rotations: Float32Array;
  private readonly _angularVelocities: Float32Array;
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

  constructor(options: ParticleEmitter3DOptions = {}) {
    super('ParticleEmitter3D');
    this.maxParticles = positiveInteger(options.maxParticles ?? 2048, 'maxParticles', MAX_PARTICLES);
    this.emissionRate = nonNegative(options.emissionRate ?? 60, 'emissionRate');
    this.burst = nonNegativeInteger(options.burst ?? 0, 'burst', this.maxParticles);
    this.duration = positive(options.duration ?? Number.POSITIVE_INFINITY, 'duration', true);
    this.loop = options.loop ?? true;
    this._seed = normalizeSeed(options.seed ?? 0x6d2b79f5);
    this._randomState = this._seed;
    this.lifetime = range(options.lifetime ?? [1, 2], 'lifetime', 1e-4);
    this.speed = range(options.speed ?? [1, 3], 'speed', 0);
    this.direction = normalizedVec3(options.direction ?? [0, 1, 0], 'direction');
    this.spread = bounded(options.spread ?? Math.PI, 'spread', 0, Math.PI);
    this.gravity = vec3(options.gravity ?? [0, -1, 0], 'gravity');
    this.startSize = range(options.startSize ?? [0.08, 0.2], 'startSize', 0);
    this.endSize = range(options.endSize ?? [0, 0.06], 'endSize', 0);
    this.rotation = range(options.rotation ?? [0, TWO_PI], 'rotation');
    this.angularVelocity = range(options.angularVelocity ?? 0, 'angularVelocity');
    this.startColor = color(options.startColor ?? [1, 1, 1, 1], 'startColor');
    this.endColor = color(options.endColor ?? [1, 1, 1, 0], 'endColor');
    this.shape = enumValue(options.shape ?? 'point', ['point', 'box', 'sphere'] as const, 'shape');
    this.shapeSize = vec3(options.shapeSize ?? [0, 0, 0], 'shapeSize', 0);
    this.shapeRadius = nonNegative(options.shapeRadius ?? 0, 'shapeRadius');
    this.blendMode = enumValue(options.blendMode ?? 'normal', ['normal', 'additive'] as const, 'blendMode');
    this.texture = options.texture ?? null;
    this.textureSource = options.textureSource ?? null;
    this.radial = options.radial ?? true;
    this.playing = options.playing ?? true;
    this.emitting = options.emitting ?? true;
    this.opacity = bounded(options.opacity ?? 1, 'opacity', 0, 1);
    this.depthTest = options.depthTest ?? true;
    this.depthWrite = options.depthWrite ?? false;
    this.sortMode = enumValue(
      options.sortMode ?? (this.blendMode === 'normal' ? 'back-to-front' : 'none'),
      ['none', 'back-to-front'] as const,
      'sortMode',
    );
    this._pendingBurst = this.burst;

    this._positions = new Float32Array(this.maxParticles * 3);
    this._velocities = new Float32Array(this.maxParticles * 3);
    this._ages = new Float32Array(this.maxParticles);
    this._lifetimes = new Float32Array(this.maxParticles);
    this._startSizes = new Float32Array(this.maxParticles);
    this._endSizes = new Float32Array(this.maxParticles);
    this._rotations = new Float32Array(this.maxParticles);
    this._angularVelocities = new Float32Array(this.maxParticles);
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
      this.emit(Math.min(count, this.maxParticles));
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

  /** Deterministically rebuilds the current state without particle snapshots. */
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

  override clone(): ParticleEmitter3D {
    return new ParticleEmitter3D({
      maxParticles: this.maxParticles,
      emissionRate: this.emissionRate,
      burst: this.burst,
      duration: this.duration,
      loop: this.loop,
      seed: this._seed,
      lifetime: cloneRange(this.lifetime),
      speed: cloneRange(this.speed),
      direction: [...this.direction],
      spread: this.spread,
      gravity: [...this.gravity],
      startSize: cloneRange(this.startSize),
      endSize: cloneRange(this.endSize),
      rotation: cloneRange(this.rotation),
      angularVelocity: cloneRange(this.angularVelocity),
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
      opacity: this.opacity,
      depthTest: this.depthTest,
      depthWrite: this.depthWrite,
      sortMode: this.sortMode,
    });
  }

  private _simulate(seconds: number): void {
    const gx = this.gravity[0], gy = this.gravity[1], gz = this.gravity[2];
    let index = 0;
    while (index < this._count) {
      const age = this._ages[index]! + seconds;
      const lifetime = this._lifetimes[index]!;
      if (age >= lifetime) {
        this._remove(index);
        continue;
      }
      this._ages[index] = age;
      const offset3 = index * 3;
      const vx = this._velocities[offset3]! + gx * seconds;
      const vy = this._velocities[offset3 + 1]! + gy * seconds;
      const vz = this._velocities[offset3 + 2]! + gz * seconds;
      this._velocities[offset3] = vx;
      this._velocities[offset3 + 1] = vy;
      this._velocities[offset3 + 2] = vz;
      this._positions[offset3] = this._positions[offset3]! + vx * seconds;
      this._positions[offset3 + 1] = this._positions[offset3 + 1]! + vy * seconds;
      this._positions[offset3 + 2] = this._positions[offset3 + 2]! + vz * seconds;
      this._rotations[index] = this._rotations[index]! + this._angularVelocities[index]! * seconds;
      this._writeInstance(index, age / lifetime);
      index++;
    }
    this._revision++;
  }

  private _spawn(): void {
    const index = this._count++;
    const offset3 = index * 3;
    this._writeSpawnPosition(offset3);
    this._writeSpawnVelocity(offset3);
    this._ages[index] = 0;
    this._lifetimes[index] = sample(this.lifetime, () => this._random());
    this._startSizes[index] = sample(this.startSize, () => this._random());
    this._endSizes[index] = sample(this.endSize, () => this._random());
    this._rotations[index] = sample(this.rotation, () => this._random());
    this._angularVelocities[index] = sample(this.angularVelocity, () => this._random());
    this._startColors.set(this.startColor, index * 4);
    this._endColors.set(this.endColor, index * 4);
    this._writeInstance(index, 0);
    this._revision++;
  }

  private _writeSpawnPosition(offset: number): void {
    if (this.shape === 'box') {
      this._positions[offset] = (this._random() - 0.5) * this.shapeSize[0];
      this._positions[offset + 1] = (this._random() - 0.5) * this.shapeSize[1];
      this._positions[offset + 2] = (this._random() - 0.5) * this.shapeSize[2];
      return;
    }
    if (this.shape === 'sphere') {
      const z = this._random() * 2 - 1;
      const phi = this._random() * TWO_PI;
      const radial = Math.sqrt(Math.max(0, 1 - z * z));
      const radius = Math.cbrt(this._random()) * this.shapeRadius;
      this._positions[offset] = Math.cos(phi) * radial * radius;
      this._positions[offset + 1] = z * radius;
      this._positions[offset + 2] = Math.sin(phi) * radial * radius;
      return;
    }
    this._positions[offset] = 0;
    this._positions[offset + 1] = 0;
    this._positions[offset + 2] = 0;
  }

  private _writeSpawnVelocity(offset: number): void {
    let dx = this.direction[0], dy = this.direction[1], dz = this.direction[2];
    const directionLength = Math.hypot(dx, dy, dz);
    if (directionLength <= 1e-8) { dx = 0; dy = 1; dz = 0; }
    else { dx /= directionLength; dy /= directionLength; dz /= directionLength; }

    let tx: number, ty: number, tz: number;
    if (Math.abs(dy) < 0.999) {
      const inverse = 1 / Math.hypot(dz, dx);
      tx = -dz * inverse; ty = 0; tz = dx * inverse;
    } else {
      const inverse = 1 / Math.hypot(dy, dx);
      tx = dy * inverse; ty = -dx * inverse; tz = 0;
    }
    const bx = dy * tz - dz * ty;
    const by = dz * tx - dx * tz;
    const bz = dx * ty - dy * tx;
    const cosTheta = 1 - this._random() * (1 - Math.cos(this.spread));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = this._random() * TWO_PI;
    const tangent = Math.cos(phi) * sinTheta;
    const bitangent = Math.sin(phi) * sinTheta;
    const speed = sample(this.speed, () => this._random());
    this._velocities[offset] = (dx * cosTheta + tx * tangent + bx * bitangent) * speed;
    this._velocities[offset + 1] = (dy * cosTheta + ty * tangent + by * bitangent) * speed;
    this._velocities[offset + 2] = (dz * cosTheta + tz * tangent + bz * bitangent) * speed;
  }

  private _writeInstance(index: number, progress: number): void {
    const source3 = index * 3;
    const source4 = index * 4;
    const target = index * INSTANCE_FLOATS;
    const t = Math.min(1, Math.max(0, progress));
    this._instanceData[target] = this._positions[source3]!;
    this._instanceData[target + 1] = this._positions[source3 + 1]!;
    this._instanceData[target + 2] = this._positions[source3 + 2]!;
    this._instanceData[target + 3] = mix(this._startSizes[index]!, this._endSizes[index]!, t);
    this._instanceData[target + 4] = this._rotations[index]!;
    this._instanceData[target + 5] = 0;
    this._instanceData[target + 6] = 0;
    this._instanceData[target + 7] = 0;
    for (let channel = 0; channel < 4; channel++) {
      this._instanceData[target + 8 + channel] = mix(this._startColors[source4 + channel]!, this._endColors[source4 + channel]!, t);
    }
  }

  private _remove(index: number): void {
    const last = --this._count;
    if (index === last) return;
    copyStride(this._positions, last, index, 3);
    copyStride(this._velocities, last, index, 3);
    this._ages[index] = this._ages[last]!;
    this._lifetimes[index] = this._lifetimes[last]!;
    this._startSizes[index] = this._startSizes[last]!;
    this._endSizes[index] = this._endSizes[last]!;
    this._rotations[index] = this._rotations[last]!;
    this._angularVelocities[index] = this._angularVelocities[last]!;
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
function bounded(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be finite and in [${minimum}, ${maximum}].`);
  return value;
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
function vec3(value: readonly [number, number, number], label: string, minimum = -Infinity): [number, number, number] {
  if (value.length !== 3 || value.some(entry => !Number.isFinite(entry) || entry < minimum)) throw new RangeError(`${label} must contain three supported finite numbers.`);
  return [value[0], value[1], value[2]];
}
function normalizedVec3(value: readonly [number, number, number], label: string): [number, number, number] {
  const result = vec3(value, label);
  const length = Math.hypot(result[0], result[1], result[2]);
  if (length <= 1e-8) throw new RangeError(`${label} must not be a zero vector.`);
  result[0] /= length; result[1] /= length; result[2] /= length;
  return result;
}
function color(value: ParticleColor, label: string): ParticleColor {
  if (value.length !== 4 || value.some(entry => !Number.isFinite(entry) || entry < 0 || entry > 1)) throw new RangeError(`${label} must be RGBA in [0, 1].`);
  return Object.freeze([value[0], value[1], value[2], value[3]]);
}
function enumValue<const T extends readonly string[]>(value: string, values: T, label: string): T[number] {
  if (!values.includes(value)) throw new RangeError(`${label} must be one of ${values.join(', ')}.`);
  return value as T[number];
}
