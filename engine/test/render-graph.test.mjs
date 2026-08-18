import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineErrorCode, RenderGraph } from '../dist/experimental.js';

test('RenderGraph compiles explicit resource dependencies and culls unreachable passes', () => {
  const graph = new RenderGraph();
  const scene = graph.addPass({ name: 'scene', passClass: 'scene-global', payload: 'scene' });
  const parent = graph.addPass({ name: 'parent', passClass: 'reflection-local', payload: 'parent' });
  const child = graph.addPass({ name: 'child', passClass: 'reflection-local', payload: 'child' });
  const source = graph.addPass({ name: 'source', passClass: 'view-local', payload: 'source', sideEffect: true });
  graph.dependsOn(source, scene);
  const childColor = graph.addResource({ name: 'child.color', payload: 'child-color' });
  const parentColor = graph.addResource({ name: 'parent.color', payload: 'parent-color' });
  graph.write(child, childColor);
  graph.read(parent, childColor);
  graph.write(parent, parentColor);
  graph.read(source, parentColor);
  graph.addPass({ name: 'invisible-reflection', passClass: 'reflection-local', payload: 'culled' });

  assert.deepEqual(graph.compile().map(pass => pass.payload), ['scene', 'child', 'parent', 'source']);
  assert.deepEqual(graph.resourceLifetimes.map(resource => [resource.name, resource.firstUse, resource.lastUse]), [
    ['child.color', 1, 2],
    ['parent.color', 2, 3],
  ]);
  assert.deepEqual(graph.stats, {
    declaredPassCount: 5,
    executedPassCount: 4,
    culledPassCount: 1,
    resourceCount: 2,
    dependencyCount: 3,
    sceneGlobalPassCount: 1,
    viewLocalPassCount: 1,
    reflectionLocalPassCount: 2,
  });
});

test('RenderGraph rejects multiple writers and dependency cycles', () => {
  const writers = new RenderGraph();
  const a = writers.addPass({ name: 'a', passClass: 'view-local', payload: null, sideEffect: true });
  const b = writers.addPass({ name: 'b', passClass: 'view-local', payload: null, sideEffect: true });
  const resource = writers.addResource({ name: 'single-writer', payload: null });
  writers.write(a, resource);
  assert.throws(
    () => writers.write(b, resource),
    error => {
      assert.equal(error.code, EngineErrorCode.RenderPipelineInvalidPassState);
      assert.match(error.message, /more than one writer/);
      assert.equal(error.context.resource, 'single-writer');
      return true;
    },
  );

  const cyclic = new RenderGraph();
  const first = cyclic.addPass({ name: 'first', passClass: 'view-local', payload: null, sideEffect: true });
  const second = cyclic.addPass({ name: 'second', passClass: 'view-local', payload: null });
  cyclic.dependsOn(first, second);
  cyclic.dependsOn(second, first);
  assert.throws(
    () => cyclic.compile(),
    error => {
      assert.equal(error.code, EngineErrorCode.RenderPipelineCompilationFailed);
      assert.match(error.message, /dependency cycle/);
      return true;
    },
  );
});

test('RenderGraph retains observable outputs while culling unobserved transient work', () => {
  const graph = new RenderGraph();
  const setup = graph.addPass({ name: 'setup', passClass: 'scene-global', payload: 'setup' });
  const externalWriter = graph.addPass({ name: 'external-writer', passClass: 'view-local', payload: 'external' });
  const deadWriter = graph.addPass({ name: 'dead-writer', passClass: 'view-local', payload: 'dead' });
  graph.dependsOn(externalWriter, setup);
  const external = graph.addResource({ name: 'external', payload: 'swapchain', transient: false });
  const transient = graph.addResource({ name: 'transient', payload: 'scratch' });
  graph.write(externalWriter, external);
  graph.write(deadWriter, transient);

  assert.deepEqual(graph.compile().map(pass => pass.payload), ['setup', 'external']);
  assert.deepEqual(graph.resourceLifetimes.map(resource => ({
    name: resource.name,
    transient: resource.transient,
    observable: resource.observable,
    firstUse: resource.firstUse,
    lastUse: resource.lastUse,
  })), [{ name: 'external', transient: false, observable: true, firstUse: 1, lastUse: 1 }]);
  assert.equal(graph.stats.culledPassCount, 1);
});

test('RenderGraph produces deterministic topological order and non-overlapping alias intervals', () => {
  for (let seed = 0; seed < 32; seed++) {
    const graph = new RenderGraph();
    const a = graph.addPass({ name: 'a', passClass: 'scene-global', payload: 'a' });
    const b = graph.addPass({ name: 'b', passClass: 'view-local', payload: 'b' });
    const c = graph.addPass({ name: 'c', passClass: 'view-local', payload: 'c' });
    const d = graph.addPass({ name: 'd', passClass: 'view-local', payload: 'd', sideEffect: true });
    const first = graph.addResource({ name: 'first', payload: 'same-descriptor' });
    const second = graph.addResource({ name: 'second', payload: 'same-descriptor' });
    const edges = seed % 2 === 0
      ? [[b, a], [c, b], [d, c]]
      : [[d, c], [c, b], [b, a]];
    for (const [pass, dependency] of edges) graph.dependsOn(pass, dependency);
    graph.write(a, first);
    graph.read(b, first);
    graph.write(c, second);
    graph.read(d, second);

    assert.deepEqual(graph.compile().map(pass => pass.payload), ['a', 'b', 'c', 'd']);
    const [firstLifetime, secondLifetime] = graph.resourceLifetimes;
    assert.equal(firstLifetime.lastUse < secondLifetime.firstUse, true);
    assert.equal(firstLifetime.transient && secondLifetime.transient, true);
    assert.equal(firstLifetime.observable || secondLifetime.observable, false);
  }
});
