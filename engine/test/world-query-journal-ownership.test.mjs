import test from 'node:test';
import assert from 'node:assert/strict';
import {BasicMaterial, Component, Entity, Geometry3D, Mesh3D, System, World} from '../dist/index.js';
import {getSpatialIndexService} from '../dist/experimental.js';

class Base extends Component {}
class A extends Base {}
class B extends Base {}
class Missing extends Component {}
const sharedSymbol = Symbol('shared-query');
class SymbolA extends Component {static UniqueSymbol = sharedSymbol;}
class SymbolB extends Component {static UniqueSymbol = sharedSymbol;}

for (const [name, create, token] of [
  ['duplicate constructors', () => [new A(), new A()], A],
  ['sibling subclasses', () => [new A(), new B()], Base],
  ['shared symbols', () => [new SymbolA(), new SymbolB()], sharedSymbol],
]) {
  test(`World query indices retain remaining matches for ${name}`, () => {
    const world = new World(), [a, b] = create(), entity = new Entity().add(a).add(b);
    try {
      world.add(entity);
      assert.deepEqual([...world.iterQueryCandidates({all: [token]})], [entity]);
      entity.remove(a);
      assert.equal(entity.hasComponent(token), true);
      for (const query of [{all: [token]}, {any: [token, Missing]}]) {
        assert.deepEqual([...world.iterQueryCandidates(query)], [entity]);
        const system = new System(query); world.add(system);
        assert.equal(system.entitySet.get(world).has(entity), true);
      }
      entity.remove(b);
      assert.equal(entity.hasComponent(token), false);
      assert.deepEqual([...world.iterQueryCandidates({any: [token, Missing]})], []);
      const other = new Entity().add(create()[0]); world.add(other);
      assert.deepEqual([...world.iterQueryCandidates({all: [token]})], [other]);
      world.clearEntities();
      assert.deepEqual([...world.iterQueryCandidates({all: [token]})], []);
      const afterClear = new Entity().add(create()[0]); world.add(afterClear);
      assert.deepEqual([...world.iterQueryCandidates({all: [token]})], [afterClear]);
    } finally {world.destroy();}
  });
}

test('typed journals coalesce per owner and preserve independent consumer cursors', () => {
  const world = new World(), shared = new A(), a = new Entity('A').add(shared), b = new Entity('B').add(shared);
  try {
    world.add(a).add(b);
    const fast = world.createComponentChangeJournal([A]), slow = world.createComponentChangeJournal([A]);
    for (let i = 0; i < 9000; i++) shared.disabled = !shared.disabled;
    const first = []; assert.equal(world.consumeComponentChanges(fast, first), true);
    assert.deepEqual(first.map(change => change.entity.name).sort(), ['A', 'B']);
    shared.disabled = !shared.disabled;
    const second = []; assert.equal(world.consumeComponentChanges(fast, second), true);
    assert.deepEqual(second.map(change => change.entity.name).sort(), ['A', 'B']);
    const delayed = []; assert.equal(world.consumeComponentChanges(slow, delayed), true);
    assert.deepEqual(delayed.map(change => change.entity.name).sort(), ['A', 'A', 'B', 'B']);
    a.remove(shared);
    shared.disabled = !shared.disabled;
    const removal = []; assert.equal(world.consumeComponentChanges(fast, removal), true);
    assert.deepEqual(removal.map(change => [change.kind, change.entity.name]), [['remove', 'A'], ['update', 'B']]);
    a.add(shared); shared.disabled = !shared.disabled;
    const reattached = []; assert.equal(world.consumeComponentChanges(fast, reattached), true);
    assert.deepEqual(reattached.map(change => [change.kind, change.entity.name]), [['add', 'A'], ['update', 'B']]);
  } finally {world.destroy();}
});

test('typed owner-pair journals still request resync on ring overflow and recover afterward', () => {
  const world = new World(), shared = new A(), entities = [];
  try {
    for (let i = 0; i < 8200; i++) {const entity = new Entity().add(shared); entities.push(entity); world.add(entity);}
    const cursor = world.createComponentChangeJournal([A]);
    shared.disabled = true;
    const changes = []; assert.equal(world.consumeComponentChanges(cursor, changes), false);
    for (const entity of entities.slice(0, 3)) world.notifyEntityComponentChanged(entity, shared);
    assert.equal(world.consumeComponentChanges(cursor, changes), true);
    assert.deepEqual(changes.map(change => change.entity), entities.slice(0, 3));
  } finally {world.destroy();}
});

test('shared Mesh3D geometry updates refit every owner in the spatial index', () => {
  const geometry = x => new Geometry3D({positions: new Float32Array([x - .5, -.5, 0, x + .5, -.5, 0, x, .5, 0])});
  const world = new World(), mesh = new Mesh3D(geometry(0), new BasicMaterial());
  const a = new Entity('A').add(mesh), b = new Entity('B').add(mesh);
  try {
    world.add(a).add(b); world.frameData.begin(world, null, 0, 0);
    const service = getSpatialIndexService(world); service.syncMeshIndex();
    mesh.geometry = geometry(20);
    const index = service.syncMeshIndex(), near = new Set(), far = new Set(), ray = [];
    index.queryPoint(0, 0, 0, near); index.queryPoint(20, 0, 0, far);
    index.queryRay(new Float32Array([20, 0, 2]), new Float32Array([0, 0, -1]), Infinity, ray);
    assert.equal(near.size, 0);
    assert.deepEqual([...far].map(entry => entry.entity.name).sort(), ['A', 'B']);
    assert.deepEqual(ray.map(entry => entry.entity.name).sort(), ['A', 'B']);
    assert.equal(service.lastMeshUpdatedEntryCount, 2);
  } finally {world.destroy();}
});
