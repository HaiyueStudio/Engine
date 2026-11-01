import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import type { Transform2D } from '@haiyue/engine/components';
import type { Physics2DBody } from '@haiyue/engine/physics';
import type { Physics2DFixedStepEvent, Physics2DShapeCastHit, Physics2DSystem } from '@haiyue/engine/physics';
import type { Entity, World } from '@haiyue/engine/ecs';
import type { Character2DOptions, Character2DController, Character2DState } from './types.js';

type V = readonly [number, number];
type Impact = Extract<Physics2DShapeCastHit, { kind: 'impact' }>;
const controlled = new WeakSet<Physics2DBody>();
// The existing public unique symbols resolve the original components without
// importing their constructors and the unused matrix implementation at runtime.
const bodyKey = Symbol.for('Physics2DBody'), transformKey = Symbol.for('Transform2D');
const epsilon = 1e-8;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const pair = (x: number, y: number): V => Object.freeze([x, y]);
const invalid = (message: string) => new EngineError(EngineErrorCode.GameplayInvalidInput, message, { docsPath: 'errors/E_GAMEPLAY_INVALID_INPUT' });
const ownership = () => new EngineError(EngineErrorCode.CharacterBodyOwnership, 'Character2D requires an unclaimed kinematic box/circle body in the supplied physics world.', { docsPath: 'errors/E_CHARACTER_BODY_OWNERSHIP' });
const vector = (v: V) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

class Character implements Character2DController {
  private readonly physics: Physics2DSystem;
  private readonly entity: Entity;
  private readonly body: Physics2DBody;
  private readonly transform: Transform2D;
  private readonly world: World;
  private readonly up: V;
  private readonly maxSlides: number;
  private readonly slopeCosine: number;
  private readonly snap: number;
  private readonly margin: number;
  private readonly carry: boolean;
  private readonly unsubscribe: () => void;
  private requested: V = pair(0, 0);
  private platform: Physics2DShapeCastHit | null = null;
  private savedVelocity: V | undefined;
  private disposed = false;
  private snapshot: Character2DState;
  private pending: { tick: number; start: V; grounded: boolean; onWall: boolean; floor: Impact | null; stuck: boolean; seconds: number } | undefined;

  constructor(options: Character2DOptions) {
    if (!options?.physics?.capabilities.shapeCast) throw new EngineError(EngineErrorCode.PhysicsShapeCastUnsupported, 'The selected physics backend has no verified shape cast capability.', { docsPath: 'errors/E_PHYSICS_SHAPE_CAST_UNSUPPORTED' });
    const up = options.up ?? [0, 1];
    if (!vector(up) || Math.hypot(...up) < epsilon) throw invalid('Character up must be a finite nonzero vector.');
    this.up = pair(up[0] / Math.hypot(...up), up[1] / Math.hypot(...up));
    this.maxSlides = options.maxSlides ?? 4;
    const angle = options.maxSlopeAngle ?? Math.PI / 4;
    this.snap = options.floorSnap ?? 4;
    this.margin = options.safeMargin ?? options.physics.pixelsPerMeter * .008;
    this.carry = options.carryPlatformVelocity ?? true;
    if (!Number.isSafeInteger(this.maxSlides) || this.maxSlides < 1 || this.maxSlides > 16
      || !Number.isFinite(angle) || angle < 0 || angle > Math.PI / 2
      || !Number.isFinite(this.snap) || this.snap < 0 || !Number.isFinite(this.margin) || this.margin < 0 || typeof this.carry !== 'boolean') throw invalid('Invalid character slide, slope or clearance options.');
    this.slopeCosine = Math.cos(angle);
    this.physics = options.physics; this.entity = options.entity;
    const body = options.entity?.getComponent<Physics2DBody>(bodyKey), transform = options.entity?.getComponent<Transform2D>(transformKey);
    const world = options.physics.usedBy.find(w => w.entities.get(options.entity?.id) === options.entity);
    if (!body || !transform || !world || controlled.has(body) || body.type !== 'kinematic' || !['box', 'circle'].includes(body.shape) || options.entity.disabled) throw ownership();
    this.body = body; this.transform = transform; this.world = world;
    this.snapshot = this.makeState(0, pair(transform.x, transform.y), pair(transform.x, transform.y), pair(0, 0), false, false, null, false);
    controlled.add(body);
    this.unsubscribe = this.physics.onFixedStep(event => this.fixedStep(event));
  }

  get state(): Character2DState {
    if (!this.disposed && this.owned() && (this.transform.x !== this.snapshot.position[0] || this.transform.y !== this.snapshot.position[1])) {
      const position = pair(this.transform.x, this.transform.y);
      this.snapshot = this.makeState(this.snapshot.tick, position, position, pair(0, 0), false, false, null, false);
      this.platform = null;
    }
    if (!this.disposed && (this.physics.disabled || this.world.disabled || this.physics.interpolationAlpha === 1)
      && this.snapshot.previousPosition !== this.snapshot.position) this.snapshot = Object.freeze({ ...this.snapshot, previousPosition: this.snapshot.position });
    return this.snapshot;
  }

  setVelocity(velocity: V): void {
    this.assertLive();
    if (!vector(velocity)) throw invalid('Character velocity must be finite render units per second.');
    this.requested = pair(...velocity);
  }

  teleport(position: V): void {
    this.assertLive();
    if (!vector(position)) throw invalid('Character position must be finite render units.');
    if (this.physics.hasBody(this.body)) this.physics.teleportBody(this.body, position[0], position[1]);
    this.transform.x = position[0]; this.transform.y = position[1]; this.platform = null; this.pending = undefined;
    this.snapshot = this.makeState(this.snapshot.tick, pair(...position), pair(...position), pair(0, 0), false, false, null, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); controlled.delete(this.body); this.platform = null; this.pending = undefined;
    if (this.savedVelocity && this.physics.hasBody(this.body)) {
      const v = { x: 0, y: 0 }; this.physics.getLinearVelocity(this.body, v);
      if (v.x === 0 && v.y === 0) this.physics.setLinearVelocity(this.body, this.savedVelocity[0], this.savedVelocity[1], false);
    }
  }

  private fixedStep(event: Physics2DFixedStepEvent): void {
    if (this.disposed) return;
    if (event.phase === 'after') {
      if (!this.owned()) { this.dispose(); return; }
      const pending = this.pending;
      if (!pending || pending.tick !== event.tick) return;
      this.pending = undefined;
      const position = pair(this.transform.x, this.transform.y);
      this.snapshot = this.makeState(event.tick, position, pending.start, pair((position[0] - pending.start[0]) / pending.seconds, (position[1] - pending.start[1]) / pending.seconds), pending.grounded, pending.onWall, pending.floor, pending.stuck);
      this.platform = pending.floor;
      return;
    }
    if (!this.owned()) { this.dispose(); return; }
    if (!this.physics.hasBody(this.body)) throw ownership();
    const start = pair(this.transform.x, this.transform.y), dt = event.deltaSeconds;
    const overlap = this.cast(start, pair(0, 0), 0, false);
    if (overlap?.kind === 'overlap') {
      this.pending = { tick: event.tick, start, seconds: dt, grounded: false, onWall: false, floor: null, stuck: true };
      this.hold(start); return;
    }
    const carrier = this.carry && this.platform && this.world.entities.get(this.platform.entity.id) === this.platform.entity ? this.velocity(this.platform) : pair(0, 0);
    let position = start, remaining: V = pair(this.requested[0] * dt + carrier[0] * dt, this.requested[1] * dt + carrier[1] * dt), seconds = dt;
    let floor: Impact | null = null, onWall = false;
    for (let slide = 0; slide < this.maxSlides; slide++) {
      // A stationary character can still be met by a translating platform.
      const hit = this.cast(position, remaining, seconds);
      if (!hit) { position = pair(position[0] + remaining[0], position[1] + remaining[1]); break; }
      if (hit.kind === 'overlap') break;
      position = pair(position[0] + remaining[0] * hit.fraction, position[1] + remaining[1] * hit.fraction);
      const up = dot(hit.normal, this.up), walkable = up >= this.slopeCosine - epsilon;
      if (walkable) floor = hit;
      else if (Math.abs(up) < this.slopeCosine) onWall = true;
      seconds *= 1 - hit.fraction;
      const target = this.velocity(hit);
      const relative: V = pair(remaining[0] * (1 - hit.fraction) - target[0] * seconds, remaining[1] * (1 - hit.fraction) - target[1] * seconds);
      const inward = Math.min(0, dot(relative, hit.normal));
      let projected: V = pair(relative[0] - hit.normal[0] * inward, relative[1] - hit.normal[1] * inward);
      if (!walkable && up > 0 && dot(projected, this.up) > Math.max(0, dot(relative, this.up)) + epsilon) projected = pair(0, 0);
      remaining = pair(projected[0] + target[0] * seconds, projected[1] + target[1] * seconds);
      if (Math.hypot(...remaining) < epsilon || seconds < epsilon) break;
    }
    if (dot(this.requested, this.up) <= epsilon) {
      const snapped = this.findFloor(position, dt, floor ?? this.platform);
      if (snapped) { position = snapped.position; floor = snapped.hit; }
      else floor = null;
    } else if (dot(this.requested, this.up) > epsilon) floor = null;
    this.pending = { tick: event.tick, start, seconds: dt, grounded: !!floor, onWall, floor, stuck: false };
    this.hold(position);
  }

  private hold(position: V): void {
    const v = { x: 0, y: 0 }; this.physics.getLinearVelocity(this.body, v);
    this.savedVelocity ??= pair(v.x, v.y);
    if (v.x || v.y) this.physics.setLinearVelocity(this.body, 0, 0, false);
    if ((position[0] !== this.transform.x || position[1] !== this.transform.y)
      && !this.physics.teleportBody(this.body, position[0], position[1], this.transform.rotation, false)) throw ownership();
  }

  private findFloor(position: V, seconds: number, preferred: Physics2DShapeCastHit | null): { position: V; hit: Impact } | null {
    let reference = preferred;
    const distance = this.snap || Math.max(this.margin, this.physics.pixelsPerMeter * .008);
    for (let attempt = 0; attempt < Math.max(2, this.maxSlides); attempt++) {
      const v = reference ? this.velocity(reference) : pair(0, 0), offset = pair(v[0] * seconds, v[1] * seconds);
      const origin = pair(position[0] - offset[0], position[1] - offset[1]), down = pair(-this.up[0] * distance, -this.up[1] * distance);
      let hit = this.cast(origin, down, 0);
      if (!hit) { hit = this.cast(position, down, seconds); if (!hit || hit.kind !== 'impact') return null; reference = hit; continue; }
      if (hit.kind !== 'impact' || dot(hit.normal, this.up) < this.slopeCosine - epsilon) return null;
      if ((!reference || hit.body !== reference.body) && Math.hypot(...this.velocity(hit)) > epsilon) { reference = hit; continue; }
      if (this.snap === 0) return { position, hit };
      let end = pair(position[0] + down[0] * hit.fraction, position[1] + down[1] * hit.fraction);
      return { position: end, hit };
    }
    return null;
  }

  private cast(origin: V, translation: V, durationSeconds: number, clearance = true): Physics2DShapeCastHit | null {
    // Query an expanded shape; native hull radii and tolerances stay in the
    // original backend. Existing contact inside the margin may still slide.
    const margin = clearance ? this.margin : 0;
    const hit = this.physics.castShape({ shape: this.body.shape, width: this.body.width + 2 * margin, height: this.body.height + 2 * margin, radius: this.body.radius + margin,
      angle: this.transform.rotation, origin, translation, durationSeconds, categoryBits: this.body.categoryBits, maskBits: this.body.maskBits, exclude: [this.body] });
    return margin > 0 && hit?.kind === 'overlap' ? this.cast(origin, translation, durationSeconds, false) : hit;
  }
  private velocity(hit: Physics2DShapeCastHit): V {
    if (hit.body.type !== 'kinematic' || !this.physics.hasBody(hit.body)) return pair(0, 0);
    const v = { x: 0, y: 0 }; this.physics.getLinearVelocity(hit.body, v);
    return pair(v.x * this.physics.pixelsPerMeter, v.y * this.physics.pixelsPerMeter);
  }
  private assertLive(): void {
    if (!this.owned()) throw ownership();
  }
  private owned(): boolean {
    return !this.disposed && !this.world.destroyed && !this.entity.disabled && this.world.entities.get(this.entity.id) === this.entity
      && this.entity.getComponent<Physics2DBody>(bodyKey) === this.body && this.entity.getComponent<Transform2D>(transformKey) === this.transform && this.body.type === 'kinematic';
  }
  private makeState(tick: number, position: V, previousPosition: V, velocity: V, grounded: boolean, onWall: boolean, floor: Impact | null, stuck: boolean): Character2DState {
    return Object.freeze({ tick, position, previousPosition, velocity, grounded, onWall, floorNormal: floor?.normal ?? null, platformEntityId: floor?.body.type === 'kinematic' ? floor.entity.id : null, stuck });
  }
}

/** Owns only the controller/listener; the supplied ECS entity and body stay borrowed. */
export function createCharacter2D(options: Character2DOptions): Character2DController { return new Character(options); }
