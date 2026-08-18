import { Entity, System, Transform2D, type World } from '@haiyue/engine';
import { Tween2DComponent, type Tween2DProperties } from './Tween2DComponent';

export interface Tween2DSystemOptions {
  priority?: number;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function readTransform(transform: Transform2D, out: Required<Tween2DProperties>): Required<Tween2DProperties> {
  out.x = transform.x;
  out.y = transform.y;
  out.rotation = transform.rotation;
  out.scaleX = transform.scaleX;
  out.scaleY = transform.scaleY;
  return out;
}

export class Tween2DSystem extends System {
  private readonly completedEntities: Entity[] = [];
  private readonly transformScratch: Required<Tween2DProperties> = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

  constructor(options: Tween2DSystemOptions = {}) {
    super({ all: [Tween2DComponent, Transform2D] });
    this.name = 'Tween2DSystem';
    if (options.priority !== undefined) this.priority = options.priority;
  }

  override update(world: World, _time: number, delta: number): this {
    if (this.disabled) return this;
    this.completedEntities.length = 0;
    const entities = this.entitySet.get(world);
    if (entities) {
      for (const entity of entities) this.updateEntity(entity, delta);
    }
    for (const entity of this.completedEntities) {
      const tween = entity.getComponent(Tween2DComponent);
      if (tween?.completed && tween.removeOnComplete) entity.removeComponent(tween);
    }
    return this;
  }

  private updateEntity(entity: Entity, delta: number): void {
    const tween = entity.getComponent(Tween2DComponent);
    const transform = entity.getComponent(Transform2D);
    if (!tween || !transform || tween.completed) return;

    tween.elapsed += delta;
    if (tween.elapsed < tween.delay) return;

    const from = tween.resolveFrom(readTransform(transform, this.transformScratch));
    if (!tween.started) {
      tween.started = true;
      this.apply(transform, from, 0);
    }

    const duration = Math.max(1, tween.duration);
    const raw = Math.min((tween.elapsed - tween.delay) / duration, 1);
    const progress = tween.getEasingFunction()(raw);
    this.apply(transform, from, progress, tween.to);

    if (raw >= 1) {
      tween.completed = true;
      this.apply(transform, from, 1, tween.to);
      if (tween.removeOnComplete) this.completedEntities.push(entity);
    }
  }

  private apply(transform: Transform2D, from: Tween2DProperties, progress: number, to: Tween2DProperties = from): void {
    if (to.x !== undefined) transform.x = lerp(from.x ?? transform.x, to.x, progress);
    if (to.y !== undefined) transform.y = lerp(from.y ?? transform.y, to.y, progress);
    if (to.rotation !== undefined) transform.rotation = lerp(from.rotation ?? transform.rotation, to.rotation, progress);
    if (to.scaleX !== undefined) transform.scaleX = lerp(from.scaleX ?? transform.scaleX, to.scaleX, progress);
    if (to.scaleY !== undefined) transform.scaleY = lerp(from.scaleY ?? transform.scaleY, to.scaleY, progress);
  }
}
