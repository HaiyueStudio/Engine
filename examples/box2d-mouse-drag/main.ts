import { Camera2D, ColorSRGB, Entity, Material2D, Mesh2D, Transform2D, HaiyueEngine } from '@haiyue/engine';
import { createCircle2D, createRect2D } from '@haiyue/engine/geometry';
import { type ColorValue } from '@haiyue/engine/color';
import { Physics2DBody, Physics2DSystem } from '@haiyue/engine/physics';

type MouseJoint = ReturnType<Physics2DSystem['createMouseJoint']>;

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const debugEl = document.getElementById('debug') as HTMLElement;
  const engine = new HaiyueEngine({ canvas });
  await engine.init();

  const camera = new Entity('Camera');
  camera.addComponent(new Camera2D());

  const scene = engine.createScene({
    name: 'Box2DMouseDrag',
    camera: { type: '2d', entity: camera },
    render3D: false,
    render2D: { loadOp: 'clear', priority: 10 },
    pipelineLabel: 'Box2DMouseDrag.render',
  });
  const world = scene.world;

  const physics = new Physics2DSystem({ gravity: [0, -980], priority: 0 });
  scene.addSystem(physics, false);

  function addBox(name: string, x: number, y: number, width: number, height: number, color: [number, number, number, number], type: 'static' | 'dynamic' = 'dynamic') {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createRect2D({ width, height }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type,
      shape: 'box',
      width,
      height,
      density: type === 'dynamic' ? 1 : 0,
      friction: 0.45,
      restitution: 0.14,
      angularDamping: 0.15,
    }));
    world.addEntity(entity);
    return entity;
  }

  function addBall(name: string, x: number, y: number, radius: number, color: [number, number, number, number]) {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createCircle2D({ radius, segments: 40 }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type: 'dynamic',
      shape: 'circle',
      radius,
      density: 1,
      friction: 0.28,
      restitution: 0.32,
      linearDamping: 0.05,
      angularDamping: 0.08,
    }));
    world.addEntity(entity);
    return entity;
  }

  addBox('ground', 0, -260, 780, 34, [0.34, 0.38, 0.43, 1], 'static');
  addBox('left-wall', -392, -80, 32, 330, [0.24, 0.28, 0.34, 1], 'static');
  addBox('right-wall', 392, -80, 32, 330, [0.24, 0.28, 0.34, 1], 'static');
  addBox('crate-a', -190, 150, 80, 80, [0.2, 0.58, 1, 1]);
  addBox('crate-b', -80, 250, 96, 56, [0.17, 0.72, 0.48, 1]);
  addBox('crate-c', 90, 330, 70, 96, [0.95, 0.68, 0.18, 1]);
  addBall('ball-a', 190, 160, 40, [0.96, 0.26, 0.3, 1]);
  addBall('ball-b', 15, 450, 34, [0.72, 0.42, 0.95, 1]);

  let activePointerId = -1;
  let mouseJoint: MouseJoint = null;
  let highlighted: { entity: Entity; base: ColorValue } | null = null;

  function setDebug(text: string) {
    debugEl.textContent = `Debug: ${text}`;
  }

  function nearestDynamicBody(x: number, y: number): string {
    let nearest = '';
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entity of world.entities.values()) {
      const body = entity.getComponent(Physics2DBody);
      const transform = entity.getComponent(Transform2D);
      if (!body || body.type !== 'dynamic' || !transform) continue;
      const distance = Math.hypot(transform.x - x, transform.y - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = entity.name;
      }
    }
    return nearest ? `${nearest} ${Math.round(nearestDistance)}px` : 'none';
  }

  function clearHighlight() {
    if (!highlighted) return;
    const mesh = highlighted.entity.getComponent(Mesh2D);
    if (mesh) {
      mesh.material.color = highlighted.base;
      mesh.material.blending = 'normal';
    }
    highlighted = null;
  }

  function highlightEntity(entity: Entity) {
    clearHighlight();
    const mesh = entity.getComponent(Mesh2D);
    if (!mesh) return;
    highlighted = { entity, base: mesh.material.color.clone() };
    mesh.material.color = new ColorSRGB(1, 1, 0.1, 1);
    mesh.material.blending = 'additive';
  }

  function clientToWorld(event: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const camera2D = camera.getComponent(Camera2D)!;
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * camera2D.width / camera2D.zoom;
    const y = (0.5 - (event.clientY - rect.top) / rect.height) * camera2D.height / camera2D.zoom;
    return [x, y];
  }

  function pickDynamic(target: [number, number]): { entity: Entity; target: [number, number] } | null {
    for (const entity of world.entities.values()) {
      const body = entity.getComponent(Physics2DBody);
      const transform = entity.getComponent(Transform2D);
      if (!body || body.type !== 'dynamic' || !transform) continue;
      const dx = target[0] - transform.x;
      const dy = target[1] - transform.y;
      const cos = Math.cos(-transform.rotation);
      const sin = Math.sin(-transform.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      if (body.shape === 'circle') {
        if (localX * localX + localY * localY <= body.radius * body.radius) return { entity, target };
      } else if (Math.abs(localX) <= body.width * 0.5 && Math.abs(localY) <= body.height * 0.5) {
        return { entity, target };
      }
    }

    const physicsHit = physics.hitTest(world, target[0], target[1], (_entity, body) => body.type === 'dynamic');
    if (physicsHit) return { entity: physicsHit, target };
    return null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    const target = clientToWorld(event);
    setDebug(`down (${Math.round(target[0])}, ${Math.round(target[1])})`);
    const picked = pickDynamic(target);
    const body = picked?.entity.getComponent(Physics2DBody);
    if (!picked || !body) {
      setDebug(`miss (${Math.round(target[0])}, ${Math.round(target[1])}), nearest ${nearestDynamicBody(target[0], target[1])}`);
      clearHighlight();
      return;
    }
    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    highlightEntity(picked.entity);
    mouseJoint = physics.createMouseJoint(body, picked.target, { maxForce: 9000, frequencyHz: 7, dampingRatio: 0.9 });
    setDebug(mouseJoint ? `selected ${picked.entity.name}` : `selected ${picked.entity.name}, joint failed`);
    canvas.style.cursor = 'grabbing';
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    const target = clientToWorld(event);
    const picked = pickDynamic(target);
    if (activePointerId < 0) canvas.style.cursor = picked ? 'grab' : 'default';
    if (event.pointerId !== activePointerId || !mouseJoint) return;
    const dragTarget = picked?.target ?? target;
    physics.updateMouseJoint(mouseJoint, dragTarget);
    setDebug(`dragging (${Math.round(dragTarget[0])}, ${Math.round(dragTarget[1])})`);
    event.preventDefault();
  });

  function releasePointer(event: PointerEvent) {
    if (event.pointerId !== activePointerId) return;
    physics.destroyMouseJoint(mouseJoint);
    mouseJoint = null;
    activePointerId = -1;
    clearHighlight();
    setDebug('released');
    canvas.style.cursor = 'default';
    event.preventDefault();
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  engine.switchScene(scene);
  engine.run();
}

main();
