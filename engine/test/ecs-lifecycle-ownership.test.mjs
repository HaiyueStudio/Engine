import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Component,
  ComponentLifecycleFlags,
  EngineErrorCode,
  Entity,
  World,
} from '../dist/experimental.js';

class LifecycleComponent extends Component {
  static Lifecycle = ComponentLifecycleFlags.EntityAddToWorld
    | ComponentLifecycleFlags.EntityRemoveFromWorld
    | ComponentLifecycleFlags.EntityRemoveComponent;

  constructor(label, events) {
    super(label);
    this.events = events;
  }

  onEntityAddToWorld(entity, world) {
    this.events.push(`world:add:${world.name}:${entity.name}`);
  }

  onEntityRemoveFromWorld(entity, world) {
    this.events.push(`world:remove:${world.name}:${entity.name}`);
  }

  onEntityRemoveComponent(entity) {
    this.events.push(`component:remove:${entity.name}`);
  }

  destroy() {
    if (!this.destroyed) this.events.push(`component:destroy:${this.name}`);
    super.destroy();
  }
}

function createTrackedTree(events) {
  const rootComponent = new LifecycleComponent('root-component', events);
  const childComponent = new LifecycleComponent('child-component', events);
  const leafComponent = new LifecycleComponent('leaf-component', events);
  const root = new Entity('Root').addComponent(rootComponent);
  const child = new Entity('Child').addComponent(childComponent);
  const leaf = new Entity('Leaf').addComponent(leafComponent);
  child.addChild(leaf);
  root.addChild(child);
  return { root, child, leaf, rootComponent, childComponent, leafComponent };
}

test('removeEntity detaches ownership but preserves a reusable entity subtree', () => {
  const events = [];
  const world = new World('ReusableWorld');
  const tree = createTrackedTree(events);
  world.addEntity(tree.root);

  world.removeEntity(tree.root);

  assert.equal(world.entities.size, 0);
  assert.equal(tree.root.world, null);
  assert.equal(tree.child.world, null);
  assert.equal(tree.leaf.world, null);
  assert.equal(tree.root.destroyed, false);
  assert.equal(tree.child.destroyed, false);
  assert.equal(tree.rootComponent.destroyed, false);
  assert.equal(tree.child.parent, tree.root);
  assert.equal(tree.leaf.parent, tree.child);
  assert.deepEqual(tree.root.children, [tree.child]);

  world.addEntity(tree.root);
  assert.equal(world.entities.size, 3);
  assert.equal(tree.root.world, world);
  assert.equal(tree.child.world, world);
  assert.equal(events.filter(event => event === 'world:add:ReusableWorld:Child').length, 2);
  assert.equal(events.filter(event => event === 'world:remove:ReusableWorld:Child').length, 1);
});

test('destroyEntity recursively destroys components and severs every hierarchy link', () => {
  const events = [];
  const world = new World('DestroyWorld');
  const tree = createTrackedTree(events);
  world.addEntity(tree.root);

  world.destroyEntity(tree.root);
  world.destroyEntity(tree.root);
  tree.root.destroy();

  assert.equal(world.entities.size, 0);
  for (const entity of [tree.root, tree.child, tree.leaf]) {
    assert.equal(entity.destroyed, true);
    assert.equal(entity.world, null);
    assert.equal(entity.parent, null);
    assert.equal(entity.children.length, 0);
    assert.equal(entity.components.size, 0);
  }
  for (const component of [tree.rootComponent, tree.childComponent, tree.leafComponent]) {
    assert.equal(component.destroyed, true);
  }
  assert.equal(events.filter(event => event.startsWith('world:remove:DestroyWorld:')).length, 3);
  assert.equal(events.filter(event => event.startsWith('component:destroy:')).length, 3);
  assert.equal(events.filter(event => event.startsWith('component:remove:')).length, 3);
  assert.throws(
    () => tree.root.addComponent(new Component()),
    error => error.code === EngineErrorCode.EcsEntityDestroyed,
  );
  assert.throws(
    () => world.addEntity(tree.root),
    error => error.code === EngineErrorCode.EcsEntityDestroyed,
  );
});

test('destroying a child subtree detaches it without destroying its surviving parent', () => {
  const events = [];
  const world = new World('ChildDestroyWorld');
  const tree = createTrackedTree(events);
  world.addEntity(tree.root);

  world.destroyEntity(tree.child);

  assert.equal(tree.root.destroyed, false);
  assert.equal(tree.root.world, world);
  assert.deepEqual(tree.root.children, []);
  assert.equal(world.entities.size, 1);
  assert.equal(world.hasEntity(tree.root), true);
  assert.equal(tree.child.destroyed, true);
  assert.equal(tree.leaf.destroyed, true);
  assert.equal(tree.child.parent, null);
  assert.equal(tree.leaf.parent, null);
});

test('destroying one leaf preserves lifecycle ordering and its surviving parent', () => {
  const events = [];
  const world = new World('LeafDestroyWorld');
  const parent = new Entity('Parent');
  const leafComponent = new LifecycleComponent('leaf-component', events);
  const leaf = new Entity('Leaf').addComponent(leafComponent);
  parent.addChild(leaf);
  world.addEntity(parent);
  events.length = 0;

  leaf.destroy();
  leaf.destroy();

  assert.equal(parent.destroyed, false);
  assert.equal(parent.world, world);
  assert.deepEqual(parent.children, []);
  assert.equal(leaf.destroyed, true);
  assert.equal(leaf.world, null);
  assert.equal(leaf.parent, null);
  assert.equal(world.entities.size, 1);
  assert.deepEqual(events, [
    'world:remove:LeafDestroyWorld:Leaf',
    'component:destroy:leaf-component',
    'component:remove:Leaf',
  ]);
});

test('ECS lookup indices stay correct when first queried after insertion and then mutated', () => {
  class Marker extends Component {}
  const world = new World('lookup-indices');
  const first = new Entity('first').addComponent(new Marker('first-marker'));
  world.addEntity(first);

  assert.equal(world.getEntity('first'), first);
  assert.equal(first.getComponent(Marker)?.name, 'first-marker');

  const second = new Entity('second').addComponent(new Marker('second-marker'));
  world.addEntity(second);
  assert.equal(world.getEntity('second'), second);
  assert.equal(second.getComponent('second-marker')?.name, 'second-marker');

  world.removeEntity(first);
  assert.equal(world.getEntity('first'), null);
  first.removeComponent(Marker);
  assert.equal(first.getComponent(Marker), null);
});

test('entities have one World owner and transferEntity moves the complete subtree explicitly', () => {
  const events = [];
  const source = new World('Source');
  const target = new World('Target');
  const tree = createTrackedTree(events);
  source.addEntity(tree.root);

  assert.throws(
    () => target.addEntity(tree.root),
    error => error.code === EngineErrorCode.EcsWorldOwnershipConflict,
  );
  assert.equal(source.entities.size, 3);
  assert.equal(target.entities.size, 0);

  target.transferEntity(tree.root);

  assert.equal(source.entities.size, 0);
  assert.equal(target.entities.size, 3);
  assert.equal(tree.root.world, target);
  assert.equal(tree.child.world, target);
  assert.equal(tree.leaf.world, target);
  assert.equal(tree.child.parent, tree.root);
  assert.equal(tree.leaf.parent, tree.child);

  const foreignParent = new Entity('ForeignParent');
  source.addEntity(foreignParent);
  assert.throws(
    () => foreignParent.addChild(tree.child),
    error => error.code === EngineErrorCode.EcsWorldOwnershipConflict,
  );
  assert.equal(tree.child.parent, tree.root);
});

test('World.destroy is idempotent and recursively releases all entity resources', () => {
  const events = [];
  const world = new World('FinalWorld');
  const tree = createTrackedTree(events);
  world.addEntity(tree.root);

  world.destroy();
  world.destroy();

  assert.equal(world.destroyed, true);
  assert.equal(world.disabled, true);
  assert.equal(world.entities.size, 0);
  assert.equal(tree.root.destroyed, true);
  assert.equal(tree.child.destroyed, true);
  assert.equal(tree.leafComponent.destroyed, true);
  assert.equal(events.filter(event => event.startsWith('component:destroy:')).length, 3);
  assert.throws(
    () => world.addEntity(new Entity('LateEntity')),
    error => error.code === EngineErrorCode.EcsWorldDestroyed,
  );
});
