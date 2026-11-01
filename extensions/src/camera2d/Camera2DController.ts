import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import type { Camera2D, Transform2D } from '@haiyue/engine/components';
import type { Entity } from '@haiyue/engine/ecs';
import type { Camera2DController, Camera2DControllerOptions, Camera2DControllerState } from './types.js';
import { centerLimits, constrain, follow, point, shakeOffset } from './follow.js';
import type { Limits, Point, Rect } from './follow.js';

const cameraKey = Symbol.for('Camera2D'), transformKey = Symbol.for('Transform2D'), transform3DKey = Symbol.for('Transform3D');
const claimed = new WeakSet<Transform2D>();
const invalid = (message: string) => new EngineError(EngineErrorCode.GameplayInvalidInput, message, { docsPath: 'errors/E_GAMEPLAY_INVALID_INPUT' });
const vector = (v: Point) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
type Basis = Readonly<{ a: number; b: number; c: number; d: number; x: number; y: number; determinant: number }>;
const identity: Basis = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0, determinant: 1 };
const worldPoint = (v: Point, m: Basis): Point => point(m.a * v[0] + m.c * v[1] + m.x, m.b * v[0] + m.d * v[1] + m.y);
const localPoint = (v: Point, m: Basis): Point => point((m.d * (v[0] - m.x) - m.c * (v[1] - m.y)) / m.determinant,
  (-m.b * (v[0] - m.x) + m.a * (v[1] - m.y)) / m.determinant);

/** Explicitly updated by the caller; owns no listeners, render loop or physics clock. */
class CameraController implements Camera2DController {
  private entity: Entity | undefined;
  private camera: Camera2D | undefined;
  private transform: Transform2D | undefined;
  private target: Camera2DControllerOptions['target'] | undefined;
  private interpolation: Camera2DControllerOptions['interpolation'];
  private readonly damping: number;
  private readonly zone: Point;
  private readonly bounds: Rect | undefined;
  private baseLocal: Point;
  private writtenLocal: Point;
  private snapshot: Camera2DControllerState;
  private vibration: { amplitude: number; durationMs: number; elapsedMs: number; seed: number } | undefined;
  private suspended = false;
  private disposed = false;

  constructor(options: Camera2DControllerOptions) {
    const camera = options?.camera?.getComponent<Camera2D>(cameraKey), transform = options?.camera?.getComponent<Transform2D>(transformKey);
    const damping = options?.damping ?? 8, zone = options?.deadZone ?? { width: 0, height: 0 }, bounds = options?.bounds;
    if (!camera || !transform || options.camera.destroyed || options.camera.getComponent(transform3DKey) || claimed.has(transform)) throw invalid('Camera2D controller requires an unclaimed original Camera2D and Transform2D on one live entity.');
    if (typeof options.target !== 'function' || (options.interpolation !== undefined && typeof options.interpolation !== 'function')
      || !Number.isFinite(damping) || damping < 0 || !zone || ![zone.width, zone.height].every(v => Number.isFinite(v) && v >= 0)
      || (bounds !== undefined && (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0))) throw invalid('Invalid camera target, damping, dead zone or bounds.');
    this.entity = options.camera; this.camera = camera; this.transform = transform;
    this.target = options.target; this.interpolation = options.interpolation; this.damping = damping;
    this.zone = point(zone.width, zone.height);
    this.bounds = bounds ? Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }) : undefined;
    const basis = this.basis(); this.limits(basis);
    this.baseLocal = this.writtenLocal = point(transform.x, transform.y);
    this.snapshot = Object.freeze({ position: worldPoint(this.baseLocal, basis), offset: point(0, 0) });
    claimed.add(transform);
  }

  get state(): Camera2DControllerState { return this.snapshot; }

  update(deltaMs: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw invalid('Camera deltaMs must be finite and nonnegative.');
    if (!this.owned()) { this.dispose(); return; }
    if (this.inactive()) { this.suspended = true; return; }
    if (deltaMs === 0) return;
    if (this.suspended) { this.reset(); return; }
    const basis = this.basis(), limits = this.limits(basis), target = this.sample(true);
    if (!this.owned() || this.disposed) { this.dispose(); return; }
    const transform = this.transform!;
    const externallyMoved = transform.x !== this.writtenLocal[0] || transform.y !== this.writtenLocal[1];
    const current = worldPoint(externallyMoved ? point(transform.x, transform.y) : this.baseLocal, basis);
    const position = follow(current, target, this.zone, this.damping, deltaMs, limits);
    const vibration = externallyMoved ? undefined : this.vibration;
    const elapsed = vibration ? Math.min(vibration.durationMs, vibration.elapsedMs + deltaMs) : 0;
    const offset = vibration ? shakeOffset(vibration.amplitude, vibration.durationMs, elapsed, vibration.seed) : point(0, 0);
    this.commit(position, offset, basis, limits);
    if (vibration && elapsed < vibration.durationMs) this.vibration = { ...vibration, elapsedMs: elapsed };
    else this.vibration = undefined;
  }

  reset(): void {
    this.assertLive();
    const basis = this.basis(), limits = this.limits(basis), target = this.sample(false);
    if (!this.owned() || this.disposed) { this.dispose(); return; }
    this.commit(constrain(target, limits), point(0, 0), basis, limits);
    this.vibration = undefined; this.suspended = false;
  }

  shake(options: Readonly<{ amplitude: number; durationMs: number; seed?: number }>): void {
    this.assertLive();
    const seed = options?.seed ?? 0;
    if (!options || !Number.isFinite(options.amplitude) || options.amplitude < 0 || !Number.isFinite(options.durationMs) || options.durationMs < 0 || !Number.isSafeInteger(seed)) throw invalid('Camera shake requires finite nonnegative amplitude/duration and an integer seed.');
    if (!options.amplitude || !options.durationMs) {
      const basis = this.basis(), limits = this.limits(basis);
      this.commit(constrain(worldPoint(this.baseLocal, basis), limits), point(0, 0), basis, limits); this.vibration = undefined;
      return;
    }
    this.vibration = { amplitude: options.amplitude, durationMs: options.durationMs, elapsedMs: 0, seed };
  }

  dispose(): void {
    if (this.disposed) return;
    // Remove only our presentation offset; preserve a newer external transform.
    const transform = this.transform;
    if (this.owned() && transform && transform.x === this.writtenLocal[0] && transform.y === this.writtenLocal[1]) {
      transform.x = this.baseLocal[0]; transform.y = this.baseLocal[1];
    }
    if (transform) claimed.delete(transform);
    this.disposed = true; this.entity = undefined; this.camera = undefined; this.transform = undefined;
    this.target = undefined; this.interpolation = undefined; this.vibration = undefined;
    this.snapshot = Object.freeze({ position: this.snapshot.position, offset: point(0, 0) });
  }

  private sample(interpolated: boolean): Point {
    if (interpolated && this.interpolation) {
      const pose = this.interpolation();
      if (!pose || !vector(pose.previous) || !vector(pose.current) || !Number.isFinite(pose.alpha) || pose.alpha < 0 || pose.alpha > 1) throw invalid('Camera interpolation must supply finite previous/current points and alpha in [0,1].');
      return point(pose.previous[0] * (1 - pose.alpha) + pose.current[0] * pose.alpha, pose.previous[1] * (1 - pose.alpha) + pose.current[1] * pose.alpha);
    }
    const target = this.target!();
    if (!vector(target)) throw invalid('Camera target must return a finite world-space point.');
    return point(...target);
  }

  private basis(): Basis {
    const entity = this.entity!, transform = this.transform!;
    if (![transform.x, transform.y, transform.rotation, transform.scaleX, transform.scaleY].every(Number.isFinite) || transform.scaleX === 0 || transform.scaleY === 0) throw invalid('Camera Transform2D must be finite and invertible.');
    if (!entity.parent) return identity;
    const world = entity.world;
    if (!world || entity.parent.world !== world) throw invalid('A parented camera must belong to its original ECS world.');
    // The original transform store resolves hierarchy; no copied matrix/projection system.
    // Before the first World frame only initialize its existing transform store;
    // do not start a World/physics frame or advance any application clock.
    if (world.frameData.transforms.phaseRevision === 0) world.frameData.transforms.beginPhase(world);
    world.frameData.transforms.flushDirtyWorldVersions();
    const m = world.frameData.getWorldMatrix2D(entity.parent);
    const a = m[0]!, b = m[1]!, c = m[4]!, d = m[5]!, x = m[12]!, y = m[13]!, determinant = a * d - b * c;
    if (![a, b, c, d, x, y, determinant].every(Number.isFinite) || Math.abs(determinant) < 1e-12 || Math.abs(m[2]!) > 1e-8 || Math.abs(m[6]!) > 1e-8 || Math.abs(m[8]!) > 1e-8 || Math.abs(m[9]!) > 1e-8) throw invalid('Camera parent must have an invertible planar transform.');
    return { a, b, c, d, x, y, determinant };
  }

  private limits(basis: Basis): Limits {
    const camera = this.camera!, transform = this.transform!;
    if (![camera.width, camera.height, camera.zoom].every(v => Number.isFinite(v) && v > 0)) throw invalid('Camera width, height and zoom must be finite and positive.');
    const cos = Math.cos(transform.rotation), sin = Math.sin(transform.rotation);
    const x0 = (basis.a * cos + basis.c * sin) * transform.scaleX, x1 = (basis.b * cos + basis.d * sin) * transform.scaleX;
    const y0 = (-basis.a * sin + basis.c * cos) * transform.scaleY, y1 = (-basis.b * sin + basis.d * cos) * transform.scaleY;
    const halfWidth = (Math.abs(x0) * camera.width + Math.abs(y0) * camera.height) / camera.zoom / 2;
    const halfHeight = (Math.abs(x1) * camera.width + Math.abs(y1) * camera.height) / camera.zoom / 2;
    if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) throw invalid('Camera viewport extent is not finite.');
    return centerLimits(this.bounds, halfWidth, halfHeight);
  }

  private commit(position: Point, offset: Point, basis: Basis, limits: Limits): void {
    const presented = constrain(point(position[0] + offset[0], position[1] + offset[1]), limits);
    const baseLocal = localPoint(position, basis), writtenLocal = localPoint(presented, basis);
    if (!vector(baseLocal) || !vector(writtenLocal)) throw invalid('Camera pose is not finite.');
    this.transform!.x = writtenLocal[0]; this.transform!.y = writtenLocal[1];
    this.baseLocal = baseLocal; this.writtenLocal = writtenLocal;
    this.snapshot = Object.freeze({ position, offset: point(presented[0] - position[0], presented[1] - position[1]) });
  }

  private owned(): boolean {
    const entity = this.entity;
    return !!entity && !entity.destroyed && entity.getComponent(cameraKey) === this.camera && entity.getComponent(transformKey) === this.transform && !entity.getComponent(transform3DKey);
  }
  private inactive(): boolean {
    if (this.camera!.disabled || this.transform!.disabled || this.entity!.world?.disabled) return true;
    for (let entity: Entity | null = this.entity!; entity; entity = entity.parent) if (entity.disabled) return true;
    return false;
  }
  private assertLive(): void {
    if (this.disposed || !this.owned()) throw invalid('Camera controller is disposed or its original components were replaced.');
  }
}

export function createCamera2DController(options: Camera2DControllerOptions): Camera2DController { return new CameraController(options); }
