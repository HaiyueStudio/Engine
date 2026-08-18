import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BasicMaterial,
  Camera3D,
  Camera2D,
  CartesianTransform3D,
  Component,
  ComponentLifecycleFlags,
  ComponentWithData,
  DirectionalLight,
  EcsIds,
  Entity,
  EngineErrorCode,
  Geometry2D,
  Geometry3D,
  Fog,
  LightComponent,
  Material2D,
  Mesh2D,
  Mesh3D,
  PointLight,
  ScriptComponent,
  ScriptResource,
  SphericalTransform3D,
  System,
  Transform2D,
  World,
  deserializeEntityCore,
  serializeEntityCore,
} from '../dist/experimental.js';

test('ECS uses internal tree links and domain id allocators', () => {
  EcsIds.reset();
  const root = new Entity('Root');
  const first = new Entity('First');
  const second = new Entity('Second');
  root.addChild(first);
  root.addChild(second);

  assert.equal(root.id, 1);
  assert.equal(first.parent, root);
  assert.equal(second.parent, root);
  assert.deepEqual(root.children.map(child => child.name), ['First', 'Second']);

  root.removeChild(first);
  assert.equal(first.parent, null);
  assert.deepEqual(root.children.map(child => child.name), ['Second']);
  assert.equal(new Entity('Third').id, 4);
});

test('Camera setters mark projection matrices dirty', () => {
  const camera3D = new Camera3D({ fov: 0.7, aspect: 1.2, near: 0.1, far: 100 });
  const before3D = Array.from(camera3D.projectionMatrix);
  camera3D.fov = 1.1;
  assert.notDeepEqual(Array.from(camera3D.projectionMatrix), before3D);

  const camera2D = new Camera2D({ width: 100, height: 100, zoom: 1 });
  const before2D = Array.from(camera2D.projectionMatrix);
  camera2D.zoom = 2;
  assert.notDeepEqual(Array.from(camera2D.projectionMatrix), before2D);
});

test('Transform and mesh clones preserve explicit runtime contracts', () => {
  const transform = new Transform2D({ x: 10, y: 20, rotation: 0.5, scaleX: 2, scaleY: 3 });
  const transformClone = transform.clone();
  assert.notEqual(transformClone, transform);
  assert.equal(transformClone.x, 10);
  assert.equal(transformClone.y, 20);
  assert.equal(transformClone.rotation, 0.5);
  assert.equal(transformClone.scaleX, 2);
  assert.equal(transformClone.scaleY, 3);

  const geometry3D = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  const material3D = new BasicMaterial();
  const mesh3D = new Mesh3D(geometry3D, material3D);
  const mesh3DClone = mesh3D.clone();
  assert.notEqual(mesh3DClone, mesh3D);
  assert.equal(mesh3DClone.geometry, geometry3D);
  assert.equal(mesh3DClone.material, material3D);

  const geometry2D = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]), new Uint16Array([0, 1, 2]));
  const material2D = new Material2D();
  const mesh2D = new Mesh2D(geometry2D, material2D);
  const mesh2DClone = mesh2D.clone();
  assert.equal(mesh2DClone.geometry, geometry2D);
  assert.equal(mesh2DClone.material, material2D);
});

test('ComponentWithData subclasses must define clone explicitly', () => {
  class UnsafeDataComponent extends ComponentWithData {
    constructor() {
      super({ nested: true }, 'UnsafeDataComponent');
    }
  }
  const component = new UnsafeDataComponent();
  assert.throws(
    () => component.clone(),
    error => error.code === EngineErrorCode.ComponentCloneUnsupported,
  );
});

test('System query descriptors use component indexes and update incrementally', () => {
  class QueryA extends ComponentWithData {
    constructor() {
      super({ value: 'a' }, 'QueryA');
    }

    clone() {
      return new QueryA();
    }
  }
  class QueryB extends ComponentWithData {
    constructor() {
      super({ value: 'b' }, 'QueryB');
    }

    clone() {
      return new QueryB();
    }
  }

  const world = new World('QueryWorld');
  const a = new Entity('A').addComponent(new QueryA());
  const ab = new Entity('AB').addComponent(new QueryA()).addComponent(new QueryB());
  const light = new Entity('Light').addComponent(new DirectionalLight());
  world.addEntity(a).addEntity(ab).addEntity(light);

  const onlyA = new System({ all: [QueryA], none: [QueryB] });
  world.addSystem(onlyA);
  assert.deepEqual([...onlyA.entitySet.get(world)].map(entity => entity.name), ['A']);

  a.addComponent(new QueryB());
  world.update(0, 0);
  assert.equal(onlyA.entitySet.get(world).size, 0);

  const anyBOrLight = new System({ any: [QueryB, LightComponent] });
  world.addSystem(anyBOrLight);
  assert.deepEqual(new Set([...anyBOrLight.entitySet.get(world)].map(entity => entity.name)), new Set(['A', 'AB', 'Light']));
});

test('Entity.removeComponent updates component indexes and lifecycle from removed component directly', () => {
  const calls = [];
  class RemoveA extends Component {
    constructor() {
      super('RemoveA');
    }
  }
  class RemoveB extends Component {
    static Lifecycle = ComponentLifecycleFlags.EntityRemoveComponent;

    constructor() {
      super('RemoveB');
    }

    onEntityRemoveComponent(entity, component) {
      calls.push(['observer', entity.name, component.name]);
    }
  }
  class RemovedLifecycle extends Component {
    static Lifecycle = ComponentLifecycleFlags.EntityRemoveComponent;

    constructor() {
      super('RemovedLifecycle');
    }

    onEntityRemoveComponent(entity, component) {
      calls.push(['self', entity.name, component.name]);
    }
  }

  const world = new World('RemoveComponentWorld');
  const entity = new Entity('Entity')
    .addComponent(new RemoveA())
    .addComponent(new RemoveB())
    .addComponent(new RemovedLifecycle());
  world.addEntity(entity);
  const system = new System({ all: [RemoveA], none: [RemovedLifecycle] });
  world.addSystem(system);
  assert.equal(system.entitySet.get(world).has(entity), false);

  entity.removeComponent(RemovedLifecycle);
  assert.equal(entity.hasComponent(RemovedLifecycle), false);
  assert.equal(entity.getComponent(RemovedLifecycle), null);
  world.update(0, 0);

  assert.equal(system.entitySet.get(world).has(entity), true);
  assert.deepEqual(calls, [
    ['observer', 'Entity', 'RemovedLifecycle'],
    ['self', 'Entity', 'RemovedLifecycle'],
  ]);
});

test('Component lifecycle dispatch requires explicit lifecycle flags', () => {
  const calls = [];
  class DuckTypedComponent extends Component {
    constructor() {
      super('DuckTypedComponent');
    }

    onUpdate() {
      calls.push('duck:update');
    }

    onEntityAddComponent() {
      calls.push('duck:add');
    }
  }
  class FlaggedLifecycleComponent extends Component {
    static Lifecycle =
      ComponentLifecycleFlags.Update |
      ComponentLifecycleFlags.EntityAddComponent;

    constructor() {
      super('FlaggedLifecycleComponent');
    }

    onUpdate() {
      calls.push('flagged:update');
    }

    onEntityAddComponent(_entity, component) {
      calls.push(`flagged:add:${component.name}`);
    }
  }

  const world = new World('LifecycleFlagsWorld');
  const entity = new Entity('Entity')
    .addComponent(new DuckTypedComponent())
    .addComponent(new FlaggedLifecycleComponent());
  calls.length = 0;
  world.addEntity(entity);
  entity.addComponent(new Component('Plain'));
  world.update(0, 16);

  assert.deepEqual(calls, [
    'flagged:add:Plain',
    'flagged:update',
  ]);
});

test('core editor schemas cover Camera, Mesh, Light, and Transform fields', () => {
  assert.equal(Camera3D.editor.fields.projectionType.type, 'select');
  assert.equal(Camera3D.editor.fields.fov.visibleWhen(new Camera3D({ type: 'orthographic' })), false);
  assert.equal(Camera3D.editor.fields.orthoRight.visibleWhen(new Camera3D({ type: 'orthographic' })), true);

  assert.equal(Mesh3D.editor.fields.geometry.type, 'asset-ref');
  assert.equal(Mesh3D.editor.fields.geometry.assetType, 'geometry3d');
  assert.equal(Mesh3D.editor.fields.material.assetType, 'material3d');

  assert.equal(DirectionalLight.editor.fields.lightType.type, 'select');
  assert.equal(DirectionalLight.editor.fields.direction.type, 'vector');
  assert.equal(PointLight.editor.fields.range.type, 'number');

  assert.equal(CartesianTransform3D.editor.fields.position.type, 'vector');
  assert.equal(CartesianTransform3D.editor.fields.anchor.type, 'vector');
  assert.equal(SphericalTransform3D.editor.fields.target.type, 'vector');
  assert.equal(Transform2D.editor.fields.rotation.unit, 'rad');
});

test('core entity serialization round-trips built-in components and children', () => {
  const root = new Entity('Root');
  const child = new Entity('Child');
  root.addComponent(new CartesianTransform3D({ position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] }));
  root.addComponent(new Camera3D({ far: 500 }));
  child.disabled = true;
  root.addChild(child);

  const serialized = serializeEntityCore(root);
  const restored = deserializeEntityCore(serialized);

  assert.equal(restored.name, 'Root');
  assert.equal(restored.children.length, 1);
  assert.equal(restored.children[0].name, 'Child');
  assert.equal(restored.children[0].disabled, true);
  assert.deepEqual(Array.from(restored.getComponent(CartesianTransform3D).position), [1, 2, 3]);
  assert.equal(restored.getComponent(Camera3D).far, 500);
});

test('Fog validates parameters, preserves color models, and round-trips both modes', () => {
  const fog = new Fog({
    mode: 'height',
    color: [0.2, 0.35, 0.5, 0.8],
    maxOpacity: 1.5,
    distanceStart: -4,
    distanceEnd: 72,
    baseHeight: -2,
    density: 0.075,
    heightFalloff: 0.3,
  });
  assert.equal(fog.maxOpacity, 1);
  assert.equal(fog.distanceStart, 0);

  const entity = new Entity('Fog').addComponent(fog);
  const serialized = serializeEntityCore(entity);
  assert.deepEqual(serialized.components[0], {
    type: 'Fog',
    mode: 'height',
    color: [0.2, 0.35, 0.5, 0.8],
    maxOpacity: 1,
    distanceStart: 0,
    distanceEnd: 72,
    baseHeight: -2,
    density: 0.075,
    heightFalloff: 0.3,
  });
  const restored = deserializeEntityCore(serialized).getComponent(Fog);
  assert.equal(restored.mode, 'height');
  assert.equal(restored.baseHeight, -2);
  assert.equal(restored.density, 0.075);
  assert.equal(restored.heightFalloff, 0.3);
});

test('core component serialization resolves resource references through context callbacks', () => {
  const geometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  const material = new BasicMaterial();
  const script = new ScriptResource({ name: 'Logic', scripts: { onUpdate: 'api.debug.console.log(time);' } });
  const entity = new Entity('Object');
  entity.addComponent(new Mesh3D(geometry, material));
  entity.addComponent(new ScriptComponent({}, script));

  const serialized = serializeEntityCore(entity, {
    getGeometryId: value => value === geometry ? 101 : null,
    getMaterialId: value => value === material ? 202 : null,
    getScriptId: value => value === script ? 303 : null,
  });

  assert.deepEqual(serialized.components.map(component => component.type), ['Mesh3D', 'ScriptComponent']);
  assert.equal(serialized.components[0].geometryId, 101);
  assert.equal(serialized.components[0].materialId, 202);
  assert.equal(serialized.components[1].scriptId, 303);

  const restored = deserializeEntityCore(serialized, {
    getGeometry: id => id === 101 ? geometry : null,
    getMaterial: id => id === 202 ? material : null,
    getScript: id => id === 303 ? script : null,
  });

  assert.equal(restored.getComponent(Mesh3D).geometry, geometry);
  assert.equal(restored.getComponent(Mesh3D).material, material);
  assert.equal(restored.getComponent(ScriptComponent).resource, script);
});

test('core Mesh2D serialization supports typed-array adapter callbacks', () => {
  const entity = new Entity('Shape');
  entity.addComponent(new Mesh2D(
    new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]), new Uint16Array([0, 1, 2])),
    new Material2D({ color: [0.2, 0.3, 0.4, 0.5], blending: 'normal' }),
  ));

  const serialized = serializeEntityCore(entity, {
    encodeFloat32Array: value => ({ kind: 'f32', values: Array.from(value) }),
    encodeIndexArray: value => ({ kind: 'idx', values: Array.from(value) }),
  });

  assert.deepEqual(serialized.components[0].positions, { kind: 'f32', values: [0, 0, 1, 0, 0, 1] });
  assert.deepEqual(serialized.components[0].indices, { kind: 'idx', values: [0, 1, 2] });

  const restored = deserializeEntityCore(serialized, {
    decodeFloat32Array: value => new Float32Array(value.values),
    decodeIndexArray: value => new Uint16Array(value.values),
  });
  const mesh = restored.getComponent(Mesh2D);

  assert.deepEqual(Array.from(mesh.geometry.positions), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(mesh.geometry.indices), [0, 1, 2]);
  assert.equal(mesh.material.blending, 'normal');
});
