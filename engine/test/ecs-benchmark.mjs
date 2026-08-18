import { performance } from 'node:perf_hooks';
import {
  Component,
  Entity,
  FrameData,
  System,
  Transform3D,
  UniqueCheckType,
  World,
} from '../dist/experimental.js';

class BenchA extends Component {
  static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE;
}

class BenchB extends Component {
  static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE;
}

class BenchC extends Component {
  static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE;
}

function measure(name, fn) {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;
  return { name, duration, result };
}

function runEntityComponentBenchmark(count) {
  const world = new World(`Bench ${count}`);
  const create = measure(`create ${count} entities with components`, () => {
    for (let i = 0; i < count; i++) {
      const entity = new Entity(`Entity ${i}`);
      entity.addComponent(new BenchA());
      if (i % 2 === 0) entity.addComponent(new BenchB());
      if (i % 5 === 0) entity.addComponent(new BenchC());
      world.addEntity(entity);
    }
    return world.entities.size;
  });
  const lookup = measure(`lookup ${count} components`, () => {
    let found = 0;
    for (const entity of world.entities.values()) {
      if (entity.getComponent(BenchA)) found++;
    }
    return found;
  });
  const ruleSystem = new System(entity => entity.hasComponent(BenchA) && entity.hasComponent(BenchB));
  const ruleQuery = measure(`system rule query ${count} entities`, () => {
    world.addSystem(ruleSystem);
    return ruleSystem.entitySet.get(world)?.size ?? 0;
  });
  const indexedSystem = new System({ all: [BenchA, BenchB] });
  const indexedQuery = measure(`system indexed query ${count} entities`, () => {
    world.addSystem(indexedSystem);
    return indexedSystem.entitySet.get(world)?.size ?? 0;
  });
  const manyIndexedSystems = measure(`register 32 indexed systems ${count} entities`, () => {
    let matched = 0;
    for (let i = 0; i < 32; i++) {
      const system = new System(i % 2 === 0 ? { all: [BenchA], any: [BenchB, BenchC] } : { all: [BenchB], none: [BenchC] });
      world.addSystem(system);
      matched += system.entitySet.get(world)?.size ?? 0;
    }
    return matched;
  });
  return [create, lookup, ruleQuery, indexedQuery, manyIndexedSystems];
}

function runRemoveComponentBenchmark(componentCount) {
  class RemovedBench extends Component {
    static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE;
  }
  const entity = new Entity(`RemoveBench ${componentCount}`);
  for (let i = 0; i < componentCount; i++) {
    entity.addComponent(new Component(`Filler ${i}`));
  }
  entity.addComponent(new RemovedBench());
  return measure(`remove component from ${componentCount + 1} component entity`, () => {
    entity.removeComponent(RemovedBench);
    return entity.components.size;
  });
}

function runTransformFrameBenchmark(count) {
  const world = new World(`TransformFrameWorld-${count}`);
  const root = new Entity('Root').addComponent(new Transform3D());
  world.addEntity(root);
  let parent = root;
  for (let i = 1; i < count; i++) {
    const entity = new Entity(`Transform ${i}`).addComponent(new Transform3D());
    entity.getComponent(Transform3D).setTranslation(1, 0, 0);
    parent.addChild(entity);
    world.addEntity(entity);
    parent = entity;
  }
  const frame = new FrameData();
  return measure(`frame transform hierarchy ${count} entities`, () => {
    frame.begin(world, null, performance.now(), 16);
    return frame.transforms.getWorldMatrix(parent)[12];
  });
}

function main() {
  const profile = process.env.BENCHMARK_PROFILE ?? 'full';
  const config = profile === 'ci'
    ? {
        entitySizes: [1000, 5000, 10000],
        transformSizes: [1000, 3000],
        removalSizes: [100, 1000, 5000],
      }
    : {
        entitySizes: [1000, 10000, 50000],
        transformSizes: [1000, 10000],
        removalSizes: [100, 1000, 10000],
      };
  for (const size of config.entitySizes) {
    for (const row of runEntityComponentBenchmark(size)) {
      console.log(`${row.name}: ${row.duration.toFixed(2)}ms (${row.result})`);
    }
  }
  for (const size of config.transformSizes) {
    const row = runTransformFrameBenchmark(size);
    console.log(`${row.name}: ${row.duration.toFixed(2)}ms (${row.result})`);
  }
  for (const size of config.removalSizes) {
    const row = runRemoveComponentBenchmark(size);
    console.log(`${row.name}: ${row.duration.toFixed(2)}ms (${row.result})`);
  }
}

main();
