import { EngineError, EngineErrorCode } from '../core/EngineError';
import { box2d, type B2Body, type B2Fixture, type B2World } from './Box2D';
import type { Physics2DBodyHandle, Physics2DShapeCastDesc, Physics2DShapeCastResult } from './Physics2DBackend';
import { validateShapeCast } from './Physics2DShapeCast';

const slop = box2d.b2_linearSlop;
const epsilon = 1e-10;

/** Geometry scratch only; the original Box2D world/maps remain the sole owners. */
export class Box2DShapeCast {
  private readonly input = new box2d.b2ShapeCastInput();
  private readonly output = new box2d.b2ShapeCastOutput();
  private readonly distanceInput = new box2d.b2DistanceInput();
  private readonly distance = new box2d.b2DistanceOutput();
  private readonly manifold = new box2d.b2Manifold();
  private readonly worldManifold = new box2d.b2WorldManifold();
  private readonly box = new box2d.b2PolygonShape();
  private readonly circle = new box2d.b2CircleShape(1);
  private readonly bounds = new box2d.b2AABB();
  private readonly candidates = new Set<B2Fixture>();

  cast(world: B2World, bodies: ReadonlyMap<Physics2DBodyHandle, B2Body>, handles: ReadonlyMap<B2Body, Physics2DBodyHandle>, desc: Physics2DShapeCastDesc): Physics2DShapeCastResult | null {
    validateShapeCast(desc);
    const excluded = new Set(desc.exclude ?? []), duration = desc.durationSeconds ?? 0;
    const input = this.input, mover = desc.shape === 'box' ? this.box : this.circle;
    if (desc.shape === 'box') this.box.SetAsBox(desc.width! / 2, desc.height! / 2);
    else this.circle.m_radius = desc.radius!;
    input.proxyB.SetShape(mover, 0);
    // b2ShapeCast's sigma subtracts polygonRadius from the combined radius.
    // Cancel that query-only deflation, otherwise a short sweep can finish
    // deeper than linearSlop before the native cast reports any impact.
    input.proxyB.m_radius += box2d.b2_polygonRadius;
    input.transformB.SetIdentity(); input.transformB.p.Set(desc.origin.x, desc.origin.y); input.transformB.q.SetAngle(desc.angle ?? 0);
    const angle = desc.angle ?? 0, cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
    const hx = desc.shape === 'box' ? (desc.width! * cosine + desc.height! * sine) / 2 + mover.m_radius : mover.m_radius;
    const hy = desc.shape === 'box' ? (desc.width! * sine + desc.height! * cosine) / 2 + mover.m_radius : mover.m_radius;
    const minX = Math.min(desc.origin.x, desc.origin.x + desc.translation.x) - hx - slop;
    const minY = Math.min(desc.origin.y, desc.origin.y + desc.translation.y) - hy - slop;
    const maxX = Math.max(desc.origin.x, desc.origin.x + desc.translation.x) + hx + slop;
    const maxY = Math.max(desc.origin.y, desc.origin.y + desc.translation.y) + hy + slop;
    this.bounds.lowerBound.Set(minX, minY); this.bounds.upperBound.Set(maxX, maxY);
    const collect = (fixture: B2Fixture) => {
      const handle = handles.get(fixture.GetBody()), filter = fixture.GetFilterData();
      if (handle === undefined || excluded.has(handle) || (!desc.includeSensors && fixture.IsSensor())
        || !(filter.categoryBits & (desc.maskBits ?? 0xffff)) || !((desc.categoryBits ?? 0xffff) & filter.maskBits)) return true;
      this.candidates.add(fixture);
      if (this.candidates.size > (desc.maxCandidates ?? 256)) throw new EngineError(EngineErrorCode.PhysicsQueryLimit, 'Physics shape cast candidate limit exceeded.', { docsPath: 'errors/E_PHYSICS_QUERY_LIMIT' });
      return true;
    };
    try {
      world.QueryAABB(null, this.bounds, collect);
      if (duration > 0) for (const body of bodies.values()) {
        if (body.GetType() !== box2d.b2BodyType.b2_kinematicBody) continue;
        const velocity = body.GetLinearVelocity(), dx = velocity.x * duration, dy = velocity.y * duration;
        for (let fixture = body.GetFixtureList(); fixture; fixture = fixture.GetNext()) {
          const a = fixture.GetAABB(0);
          if (Math.min(a.lowerBound.x, a.lowerBound.x + dx) <= maxX && Math.max(a.upperBound.x, a.upperBound.x + dx) >= minX
            && Math.min(a.lowerBound.y, a.lowerBound.y + dy) <= maxY && Math.max(a.upperBound.y, a.upperBound.y + dy) >= minY) collect(fixture);
        }
      }
      let nearest: Physics2DShapeCastResult | null = null;
      for (const fixture of this.candidates) {
        const body = fixture.GetBody(), handle = handles.get(body)!;
        const velocity = body.GetType() === box2d.b2BodyType.b2_kinematicBody ? body.GetLinearVelocity() : { x: 0, y: 0 };
        const targetX = velocity.x * duration, targetY = velocity.y * duration;
        input.proxyA.SetShape(fixture.GetShape(), 0); input.transformA.Copy(body.GetTransform());
        input.translationB.Set(desc.translation.x - targetX, desc.translation.y - targetY);
        const hit = this.against(fixture, mover, handle, desc, targetX, targetY);
        if (hit && (!nearest || hit.fraction < nearest.fraction - epsilon || (Math.abs(hit.fraction - nearest.fraction) <= epsilon && hit.body < nearest.body))) nearest = hit;
      }
      return nearest;
    } finally { this.clear(); }
  }

  clear(): void {
    this.candidates.clear();
    // Proxies may reference a fixture's vertices. Keep only our own scratch shape.
    this.input.proxyA.SetShape(this.circle, 0); this.distanceInput.proxyA.SetShape(this.circle, 0);
  }

  private against(fixture: B2Fixture, mover: InstanceType<typeof box2d.b2Shape>, body: Physics2DBodyHandle, desc: Physics2DShapeCastDesc, targetX: number, targetY: number): Physics2DShapeCastResult | null {
    const i = this.input, a = fixture.GetShape(), m = this.manifold;
    m.pointCount = 0;
    let swapped = false;
    if (a instanceof box2d.b2PolygonShape && mover instanceof box2d.b2PolygonShape) box2d.b2CollidePolygons(m, a, i.transformA, mover, i.transformB);
    else if (a instanceof box2d.b2CircleShape && mover instanceof box2d.b2CircleShape) box2d.b2CollideCircles(m, a, i.transformA, mover, i.transformB);
    else if (a instanceof box2d.b2PolygonShape && mover instanceof box2d.b2CircleShape) box2d.b2CollidePolygonAndCircle(m, a, i.transformA, mover, i.transformB);
    else if (a instanceof box2d.b2CircleShape && mover instanceof box2d.b2PolygonShape) { swapped = true; box2d.b2CollidePolygonAndCircle(m, mover, i.transformB, a, i.transformA); }
    else throw new EngineError(EngineErrorCode.PhysicsShapeCastUnsupported, 'This fixture shape is not supported by the box/circle shape cast.');
    const d = this.distanceInput;
    d.proxyA.Copy(i.proxyA); d.proxyB.Copy(i.proxyB); d.transformA.Copy(i.transformA); d.transformB.Copy(i.transformB); d.useRadii = false;
    if (m.pointCount) {
      const w = this.worldManifold;
      w.Initialize(m, swapped ? i.transformB : i.transformA, swapped ? mover.m_radius : a.m_radius, swapped ? i.transformA : i.transformB, swapped ? a.m_radius : mover.m_radius);
      if (w.separations.slice(0, m.pointCount).some(v => v < -slop - epsilon)) return Object.freeze({ kind: 'overlap', body, fraction: 0, distance: 0, point: null, normal: null });
      const nx = w.normal.x * (swapped ? -1 : 1), ny = w.normal.y * (swapped ? -1 : 1);
      if (i.translationB.x * nx + i.translationB.y * ny >= -epsilon) return null;
      const point = w.points[0]!;
      return this.impact(body, 0, desc, nx, ny, point.x, point.y);
    }
    box2d.b2Distance(this.distance, new box2d.b2SimplexCache(), d);
    const separation = this.distance.distance - (a.m_radius + mover.m_radius);
    if (separation <= slop + epsilon && this.distance.distance > epsilon) {
      const nx = (this.distance.pointB.x - this.distance.pointA.x) / this.distance.distance;
      const ny = (this.distance.pointB.y - this.distance.pointA.y) / this.distance.distance;
      if (i.translationB.x * nx + i.translationB.y * ny >= -epsilon) return null;
      return this.impact(body, 0, desc, nx, ny, this.distance.pointA.x + a.m_radius * nx, this.distance.pointA.y + a.m_radius * ny);
    }
    if (!box2d.b2ShapeCast(this.output, i)) return null;
    const f = this.output.lambda, length = Math.hypot(this.output.normal.x, this.output.normal.y);
    if (length < epsilon || !Number.isFinite(f) || f < 0 || f > 1) return null;
    const nx = this.output.normal.x / length, ny = this.output.normal.y / length;
    d.transformB.p.Set(desc.origin.x + i.translationB.x * f, desc.origin.y + i.translationB.y * f);
    box2d.b2Distance(this.distance, new box2d.b2SimplexCache(), d);
    return this.impact(body, f, desc, nx, ny, this.distance.pointA.x + a.m_radius * nx + targetX * f, this.distance.pointA.y + a.m_radius * ny + targetY * f);
  }

  private impact(body: Physics2DBodyHandle, fraction: number, desc: Physics2DShapeCastDesc, nx: number, ny: number, x: number, y: number): Physics2DShapeCastResult {
    return Object.freeze({ kind: 'impact', body, fraction, distance: Math.hypot(desc.translation.x, desc.translation.y) * fraction, normal: Object.freeze({ x: nx, y: ny }), point: Object.freeze({ x, y }) });
  }
}
