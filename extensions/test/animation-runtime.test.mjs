import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, Transform2D, World } from '@haiyue/engine';
import { ParticleEmitter2D } from '@haiyue/engine/components';
import { Particle2DSystem } from '@haiyue/engine/systems';
import {
  AnimationExtensionRegistry,
  HYA_STATE_MACHINE_EXTENSION_ID,
  encodeAnimationBinary,
  parseAnimation,
} from '@haiyue/animation-spec';
import {
  Animation2DComponent,
  Animation2DExtensionRegistry,
  Animation2DSystem,
  createAnimationAssetLoader,
  tessellateAnimationPath,
} from '../dist/animation.js';
import {
  Animation2DStateMachineComponent,
  Animation2DStateMachineSystem,
  createHyaAnimation2DClips,
} from '../dist/hya-state-machine.js';

function animationFixture() {
  return {
    format: 'haiyue-animation', version: '1.0',
    canvas: { width: 200, height: 100, coordinateSystem: 'screen-y-down' },
    duration: 1,
    nodes: [{
      id: 'box',
      transform: { position: [10, 20], opacity: 0.4 },
      components: [{ type: 'shape2d', shape: 'rect', size: [20, 10], fill: [1, 0, 0, 1] }],
    }],
    tracks: [{ node: 'box', property: 'position', interpolation: 'linear', times: [0, 1], values: [10, 20, 110, 70] }],
  };
}

function stateMachineAnimationFixture() {
  return {
    ...animationFixture(),
    duration: 2,
    tracks: [{
      node: 'box', property: 'position', interpolation: 'step',
      times: [0, 1, 2], values: [0, 0, 100, 0, 100, 0],
    }],
    extensionsUsed: [HYA_STATE_MACHINE_EXTENSION_ID],
    extensionsRequired: [HYA_STATE_MACHINE_EXTENSION_ID],
    extensions: {
      [HYA_STATE_MACHINE_EXTENSION_ID]: {
        clips: [
          { id: 'idle', start: 0, duration: 1 },
          { id: 'run', start: 1, duration: 1 },
        ],
        stateMachine: {
          format: 'haiyue-animation-state-machine@1',
          id: 'character', name: 'Character',
          parameters: [{ name: 'moving', type: 'boolean', defaultValue: false }],
          layers: [{
            id: 'base', name: 'Base', initialStateId: 'idle',
            states: [
              { id: 'idle', name: 'Idle', motion: { kind: 'clip', clipId: 'idle' }, loop: 'repeat' },
              { id: 'run', name: 'Run', motion: { kind: 'clip', clipId: 'run' }, loop: 'repeat' },
            ],
            transitions: [
              { id: 'move', from: 'idle', to: 'run', conditions: [{ parameter: 'moving', operator: 'is-true' }], duration: 0.2 },
              { id: 'stop', from: 'run', to: 'idle', conditions: [{ parameter: 'moving', operator: 'is-false' }], duration: 0.2 },
            ],
          }],
        },
      },
    },
  };
}

test('Animation2DSystem instantiates shape nodes, samples tracks and releases generated hierarchy', () => {
  const animation = parseAnimation(animationFixture());
  const world = new World('AnimationRuntime');
  const player = new Animation2DComponent(animation, { autoplay: false });
  const owner = new Entity('Player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());

  world.update(0, 0);
  assert.deepEqual(player.runtimeStats, {
    nodeCount: 1, visualCount: 1, unsupportedComponentCount: 0,
    pendingResourceCount: 0, failedResourceCount: 0,
    textCount: 0, particleCount: 0, audioCount: 0,
  });
  const generatedRoot = owner.children[0];
  const box = generatedRoot.children[0];
  assert.equal(box.getComponent(Transform2D).x, 10);
  assert.equal(box.getComponent(Transform2D).y, -20);
  const visual = box.children[0].children[0].getComponent(Symbol.for('AnimationVisual2D'));
  assert.ok(visual);
  assert.ok(Math.abs(visual.color[3] - 0.4) < 1e-6);

  player.seek(0.5);
  world.update(500, 0);
  assert.equal(box.getComponent(Transform2D).x, 60);
  assert.equal(box.getComponent(Transform2D).y, -45);

  owner.removeComponent(player);
  assert.equal(owner.children.length, 0);
  assert.equal(player.runtimeStats.nodeCount, 0);
});

test('Animation2DComponent applies and clears interactive node overrides after authored tracks', () => {
  const world = new World('Interactive overrides');
  const player = new Animation2DComponent(animationFixture(), { autoplay: false });
  const owner = new Entity('Player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner); world.addSystem(new Animation2DSystem()); world.update(0, 0);

  player.setNodeOverride('box', { position: [30, 40], opacity: 0.75 });
  world.update(0, 0);
  const box = owner.children[0].children[0];
  const transform = box.getComponent(Transform2D);
  const visual = box.children[0].children[0].getComponent(Symbol.for('AnimationVisual2D'));
  assert.deepEqual([transform.x, transform.y], [30, -40]);
  assert.ok(Math.abs(visual.color[3] - 0.75) < 1e-6);

  player.clearNodeOverride('box'); world.update(0, 0);
  assert.deepEqual([transform.x, transform.y], [10, -20]);
  assert.ok(Math.abs(visual.color[3] - 0.4) < 1e-6);
  assert.throws(() => player.setNodeOverride('missing', { opacity: 1 }), /does not exist/u);
});

test('Animation2D runtime samples spatial position curves without flattening them to endpoint lerps', () => {
  const animation = parseAnimation({
    ...animationFixture(),
    tracks: [{
      node: 'box', property: 'position', interpolation: 'linear',
      times: [0, 1], values: [0, 0, 100, 0], spatialTangents: [0, 100, 0, 100],
    }],
  });
  const world = new World('Spatial motion');
  const player = new Animation2DComponent(animation, { autoplay: false });
  const owner = new Entity('Player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  player.seek(0.5);
  world.update(500, 0);
  const transform = owner.children[0].children[0].getComponent(Transform2D);
  assert.ok(Math.abs(transform.x - 50) < 1e-5);
  assert.ok(Math.abs(transform.y + 75) < 1e-5);
  owner.removeComponent(player);
});

test('HYA clip adapter preserves spatial curvature when a named range slices a motion segment', () => {
  const source = parseAnimation({
    ...stateMachineAnimationFixture(),
    tracks: [{
      node: 'box', property: 'position', interpolation: 'linear', times: [0, 2],
      values: [0, 0, 100, 0], spatialTangents: [0, 100, 0, 100],
    }],
    extensions: {
      [HYA_STATE_MACHINE_EXTENSION_ID]: {
        clips: [{ id: 'trimmed', start: 0.5, duration: 1 }],
        stateMachine: {
          format: 'haiyue-animation-state-machine@1', id: 'spatial', name: 'Spatial', parameters: [],
          layers: [{
            id: 'base', name: 'Base', initialStateId: 'trimmed',
            states: [{ id: 'trimmed', name: 'Trimmed', motion: { kind: 'clip', clipId: 'trimmed' } }],
            transitions: [],
          }],
        },
      },
    },
  });
  const track = createHyaAnimation2DClips(source)[0].tracks.find(candidate => candidate.binding.path === 'transform.position');
  assert.deepEqual(Array.from(track.values).map(value => Math.round(value * 1000) / 1000), [15.625, 56.25, 84.375, 56.25]);
  const samplerTrack = { ...track };
  assert.equal(samplerTrack.spatialTangents.length, 4);
});

test('HYA state-machine component cross-fades named ranges on one generated hierarchy', () => {
  const world = new World('HYA state machine');
  const player = new Animation2DStateMachineComponent(stateMachineAnimationFixture(), { autoplay: true });
  player.setBoolean('moving', false);
  const owner = new Entity('Character').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DStateMachineSystem());

  world.update(0, 0);
  assert.equal(owner.children.length, 1, 'one HYA asset must create one runtime hierarchy');
  const box = owner.children[0].children[0];
  assert.equal(box.getComponent(Transform2D).x, 0);
  assert.equal(player.layerSnapshots[0].currentStateId, 'idle');

  player.setBoolean('moving', true);
  world.update(100, 100);
  assert.ok(Math.abs(box.getComponent(Transform2D).x - 50) < 1e-4);
  assert.equal(player.layerSnapshots[0].transitionId, 'move');
  assert.equal(player.layerSnapshots[0].transitionProgress, 0.5);

  world.update(200, 100);
  assert.ok(Math.abs(box.getComponent(Transform2D).x - 100) < 1e-4);
  assert.equal(player.layerSnapshots[0].currentStateId, 'run');
  assert.equal(owner.children.length, 1);

  owner.removeComponent(player);
  assert.equal(owner.children.length, 0);
  assert.equal(player.runtimeStats.nodeCount, 0);
});

test('HYA state-machine component replacement and scene destroy release actions, bindings, and particles', () => {
  const source = stateMachineAnimationFixture();
  source.nodes[0].components.push({
    type: 'particle2d', maxParticles: 8, emissionRate: 2, burst: 1,
    lifetime: [0.2, 0.4], speed: [1, 2], angle: [0, Math.PI],
    startSize: [1, 2], endSize: [0, 1],
    startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0],
  });
  const world = new World('HYA state-machine replacement');
  const owner = new Entity('Character').addComponent(new Transform2D());
  const first = new Animation2DStateMachineComponent(source, { autoplay: true });
  owner.addComponent(first);
  world.addEntity(owner);
  world.addSystem(new Animation2DStateMachineSystem());
  world.update(0, 0);

  const firstRuntime = first._runtime;
  const firstParticle = firstRuntime._visual._nodes[0].particles[0];
  assert.equal(firstRuntime.liveActionCount, 1);
  assert.equal(firstRuntime.liveBindingCount, 2);
  assert.equal(firstRuntime.sideEffectOwnerCount, 1);

  const second = new Animation2DStateMachineComponent(source, { autoplay: true });
  owner.addComponent(second);
  assert.equal(first._runtime, null);
  assert.equal(firstRuntime.liveActionCount, 0);
  assert.equal(firstRuntime.liveBindingCount, 0);
  assert.equal(firstRuntime.sideEffectOwnerCount, 0);
  assert.equal(firstParticle.activeParticles, 0);
  assert.equal(firstParticle.playing, false);
  assert.equal(firstParticle.emitting, false);

  world.update(16, 16);
  const secondRuntime = second._runtime;
  assert.equal(secondRuntime.liveActionCount, 1);
  assert.equal(secondRuntime.liveBindingCount, 2);
  assert.equal(secondRuntime.sideEffectOwnerCount, 1);
  world.destroy();
  assert.equal(secondRuntime.liveActionCount, 0);
  assert.equal(secondRuntime.liveBindingCount, 0);
  assert.equal(secondRuntime.sideEffectOwnerCount, 0);
});

test('HYA clip adapter preserves cubic easing when a named range cuts through a segment', () => {
  const source = parseAnimation({
    ...stateMachineAnimationFixture(),
    tracks: [{
      node: 'box', property: 'position', interpolation: 'cubic-bezier',
      times: [0, 2], values: [0, 0, 100, 0], easings: [0.42, 0, 0.58, 1],
    }],
    extensions: {
      [HYA_STATE_MACHINE_EXTENSION_ID]: {
        ...stateMachineAnimationFixture().extensions[HYA_STATE_MACHINE_EXTENSION_ID],
        clips: [{ id: 'trimmed', start: 0.25, duration: 1.5 }],
        stateMachine: {
          format: 'haiyue-animation-state-machine@1', id: 'trimmed', name: 'Trimmed', parameters: [],
          layers: [{
            id: 'base', name: 'Base', initialStateId: 'trimmed',
            states: [{ id: 'trimmed', name: 'Trimmed', motion: { kind: 'clip', clipId: 'trimmed' } }],
            transitions: [],
          }],
        },
      },
    },
  });
  const track = createHyaAnimation2DClips(source)[0].tracks.find(candidate => candidate.binding.path === 'transform.position');
  const slicedProgress = cubicYForX(0.5, ...track.easings);
  const slicedX = track.values[0] + (track.values[2] - track.values[0]) * slicedProgress;
  const sourceX = 100 * cubicYForX(0.5, 0.42, 0, 0.58, 1);
  assert.ok(Math.abs(slicedX - sourceX) < 1e-4, `${slicedX} != ${sourceX}`);
});

test('HYA clip adapter snaps Float32 track keys at decimal clip boundaries', () => {
  const source = parseAnimation({
    ...stateMachineAnimationFixture(),
    duration: 5.2,
    tracks: [{
      node: 'box', property: 'position', interpolation: 'cubic-bezier',
      times: [0, 1.2, 2.2, 3.4, 4.2, 5.2],
      values: [0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0],
      easings: Array.from({ length: 5 }, () => [0.42, 0, 0.58, 1]).flat(),
    }],
    extensions: {
      [HYA_STATE_MACHINE_EXTENSION_ID]: {
        clips: [{ id: 'attack', start: 3.4, duration: 0.8 }],
        stateMachine: {
          format: 'haiyue-animation-state-machine@1', id: 'decimal', name: 'Decimal boundaries', parameters: [],
          layers: [{
            id: 'base', name: 'Base', initialStateId: 'attack',
            states: [{ id: 'attack', name: 'Attack', motion: { kind: 'clip', clipId: 'attack' } }],
            transitions: [],
          }],
        },
      },
    },
  });
  const clip = createHyaAnimation2DClips(source)[0];
  const position = clip.tracks.find(candidate => candidate.binding.path === 'transform.position');
  assert.equal(clip.duration, Math.fround(0.8));
  assert.deepEqual(Array.from(position.times), [0, Math.fround(0.8)]);
  assert.equal(position.easings.length, 4);
});

test('HYA state-machine adapter diagnoses the exact unmixable audio transition range', () => {
  const source = parseAnimation({
    ...stateMachineAnimationFixture(),
    resources: [{ id: 'tone', type: 'audio', uri: '/tone.ogg' }],
    nodes: [{ id: 'box', components: [{ type: 'audio', resource: 'tone' }] }],
    tracks: [],
  });
  assert.throws(
    () => createHyaAnimation2DClips(source),
    /Audio transitions must be immediate.*layers\[0\]\.transitions\[0\]\.duration/,
  );
});

test('path tessellation is cached and preserves evenodd holes', () => {
  const path = {
    type: 'path2d', commands: 'MLLLZMLLLZ',
    values: new Float32Array([0, 0, 100, 0, 100, 100, 0, 100, 25, 25, 25, 75, 75, 75, 75, 25]),
    fill: [1, 1, 1, 1], fillRule: 'evenodd', tolerance: 0.25,
  };
  const first = tessellateAnimationPath(path);
  const second = tessellateAnimationPath(path);
  assert.equal(first, second);
  assert.ok(first.indices.length >= 18);
  assert.equal(first.positions.length, 16);
});

test('path tessellation adaptively flattens cubic curves', () => {
  const geometry = tessellateAnimationPath({
    type: 'path2d', commands: 'MCLZ',
    values: [0, 0, 0, 100, 100, 100, 100, 0, 0, 0],
    fill: [1, 1, 1, 1], tolerance: 0.5,
  });
  assert.ok(geometry.vertexCount > 4);
  assert.ok(geometry.indices.length >= 9);
});

test('future visuals defer path tessellation until their effective hierarchy time window opens', () => {
  const world = new World('Deferred animation visuals');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{
      id: 'future-path',
      start: 0.5,
      duration: 0.5,
      components: [{
        type: 'path2d', commands: 'MLLLZ', values: [0, 0, 20, 0, 20, 20, 0, 20],
        fill: [1, 1, 1, 1],
      }],
    }],
    tracks: [],
  }, { autoplay: false });
  const owner = new Entity('Deferred player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());

  world.update(0, 0);
  const content = owner.children[0].children[0].children[0];
  assert.equal(content.children.length, 0, 'future geometry must not be built during the first frame');
  assert.equal(player.runtimeStats.visualCount, 1, 'stats retain the authored visual count');

  player.seek(0.5);
  world.update(500, 0);
  assert.equal(content.children.length, 1, 'the visual is materialized on first entry into its time window');
});

test('compact Lottie stroke extension tessellates as a built-in runtime visual', () => {
  const world = new World('LottieStrokeRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'stroke', components: [{
      type: 'org.haiyue.vector-stroke@1', commands: 'MLL', values: [-20, -20, 0, 20, 20, -20],
      color: [0.1, 0.2, 0.3, 1], width: 6, lineCap: 'round', lineJoin: 'round', miterLimit: 4,
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-stroke@1'],
  }, { autoplay: false });
  const owner = new Entity('Stroke player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  assert.equal(player.runtimeStats.visualCount, 1);
  assert.equal(player.runtimeStats.unsupportedComponentCount, 0);
});

test('topology-stable Lottie path morph updates one Geometry2D instance over time', () => {
  const world = new World('LottiePathMorphRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'morph', components: [{
      type: 'org.haiyue.vector-path-morph@1',
      commands: 'MLLLZ', times: [0, 1], valueSize: 8,
      values: [0, 0, 20, 0, 20, 20, 0, 20, 10, 0, 30, 0, 20, 20, 0, 20],
      interpolation: 'linear', fill: [0.2, 0.8, 1, 1], fillRule: 'nonzero',
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-path-morph@1'],
  }, { autoplay: false });
  const owner = new Entity('Morph player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = findComponentByName(owner, 'AnimationVisual2D');
  const geometry = visual.geometry;
  const initial = [...geometry.positions];
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.geometry, geometry);
  assert.equal(geometry.version, 1);
  assert.notDeepEqual([...geometry.positions], initial);
});

test('source-neutral vector shape runtime animates morph, color and opacity on one visual', () => {
  const world = new World('VectorShapeRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'vector', components: [{
      type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, 20, 0, 20, 20, 0, 20],
      morph: {
        times: [0, 1], valueSize: 8, interpolation: 'linear',
        values: [0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, 0],
      },
      morphRelative: true,
      fill: {
        kind: 'solid', color: [1, 0, 0, 1], opacity: 1,
        colorTrack: { times: [0, 1], valueSize: 4, interpolation: 'linear', values: [1, 0, 0, 1, 0, 1, 0, 0.5] },
        opacityTrack: { times: [0, 1], valueSize: 1, interpolation: 'linear', values: [1, 0.5] },
      },
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-shape@1'],
  }, { autoplay: false });
  const owner = new Entity('Vector player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = findComponentByName(owner, 'AnimationVisual2D');
  const geometry = visual.geometry;
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.geometry, geometry);
  assert.equal(geometry.version, 2, 'initial sampled pose and midpoint update reuse the same geometry object');
  assert.ok(Math.abs(visual.color[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(visual.color[1] - 0.5) < 1e-5);
  assert.ok(Math.abs(visual.color[3] - 0.5625) < 1e-5, 'color alpha and paint opacity are multiplied exactly once');
});

test('source-neutral layer effects propagate to visuals and sample ordered tracks in place', () => {
  const world = new World('AnimationEffectRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{
      id: 'effect-layer',
      effects: [
        {
          kind: 'tint', black: [0, 0, 0], white: [1, 1, 1], amount: 0,
          amountTrack: { times: [0, 1], values: [0, 1], valueSize: 1, interpolation: 'linear' },
        },
        {
          kind: 'drop-shadow', color: [0.1, 0.2, 0.3, 1], opacity: 0.8, offset: [4, 6], blur: 3,
          blurTrack: { times: [0, 1], values: [3, 9], valueSize: 1, interpolation: 'linear' },
        },
      ],
      components: [{ type: 'shape2d', shape: 'rect', size: [20, 10], fill: [1, 0, 0, 1] }],
    }],
    tracks: [],
  }, { autoplay: false });
  const owner = new Entity('Effect player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = findComponentByName(owner, 'AnimationVisual2D');
  const tintValues = visual.effects[0].values;
  const shadowValues = visual.effects[1].values;
  assert.deepEqual([...tintValues], [0, 0, 0, 1, 1, 1, 0]);
  assert.deepEqual([...shadowValues], [0.1, 0.2, 0.3, 1, 0.8, 4, 6, 3].map(Math.fround));
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.effects[0].values, tintValues, 'effect storage remains stable across samples');
  assert.equal(visual.effects[1].values, shadowValues, 'ordered effect storage remains stable across samples');
  assert.ok(Math.abs(tintValues[6] - 0.5) < 1e-6);
  assert.ok(Math.abs(shadowValues[7] - 6) < 1e-6);
  owner.removeComponent(player);
});

test('source-neutral trim-path and round-corners update one geometry and represent an empty range safely', () => {
  const world = new World('VectorModifierRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'vector', components: [{
      type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, 40, 0, 40, 40, 0, 40],
      stroke: { color: [0, 1, 0, 1], width: 4, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
      modifiers: [
        { kind: 'round-corners', radius: 5 },
        {
          kind: 'trim-path', start: 0, end: 0, offset: 0, mode: 'simultaneous',
          endTrack: { times: [0, 1], values: [0, 1], valueSize: 1, interpolation: 'linear' },
        },
      ],
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-shape@1'],
  }, { autoplay: false });
  const owner = new Entity('Vector modifier player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = findComponentByName(owner, 'AnimationVisual2D');
  const geometry = visual.geometry;
  assert.ok([...geometry.positions].every(value => value === 0), 'empty trim uses a zero-area fallback geometry');
  player.seek(0.01);
  world.update(10, 0);
  assert.equal(visual.geometry, geometry, 'small trim reuses the runtime geometry owner');
  assert.ok([...geometry.positions].every(Number.isFinite), 'small trim keeps finite geometry whether drawable or empty');
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.geometry, geometry);
  assert.ok([...geometry.positions].some(value => Math.abs(value) > 1e-6));
  player.seek(1);
  world.update(1000, 0);
  assert.ok(geometry.vertexCount > 8, 'round corners add adaptively flattened curve vertices');
});

test('animated stroke width keeps an unmodified vector path visible', () => {
  const world = new World('VectorStrokeWidthRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'vector', components: [{
      type: 'org.haiyue.vector-shape@1', commands: 'MLL', values: [0, 0, 40, 0, 40, 40],
      stroke: {
        color: [1, 1, 1, 1], width: 2, lineCap: 'round', lineJoin: 'round', miterLimit: 4,
        widthTrack: { times: [0, 1], values: [2, 8], valueSize: 1, interpolation: 'linear' },
      },
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-shape@1'],
  }, { autoplay: false });
  const owner = new Entity('Animated stroke player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const geometry = findComponentByName(owner, 'AnimationVisual2D').geometry;
  player.seek(0.5);
  world.update(500, 0);
  assert.ok([...geometry.positions].some(value => Math.abs(value) > 1e-6));
});

test('static vector gradients preserve opacity without dirtying unchanged visual data', () => {
  const world = new World('VectorGradientRuntime');
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [{ id: 'gradient', components: [{
      type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, 20, 0, 20, 20, 0, 20],
      fill: {
        kind: 'linear-gradient', start: [0, 0], end: [20, 0], opacity: 0.8,
        stops: [0, 1, 0, 0, 1, 1, 0, 0, 1, 0.5],
      },
    }] }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-shape@1'],
  }, { autoplay: false });
  const owner = new Entity('Gradient player').addComponent(new Transform2D()).addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = findComponentByName(owner, 'AnimationVisual2D');
  const revision = visual.revision;
  assert.equal(visual.gradient.opacity, 0.8);
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.revision, revision, 'static gradient data must not be re-uploaded for time-only changes');
});

test('composites propagate to target descendants while source descendants stay source-only', () => {
  const world = new World();
  const owner = new Entity('composite player').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [
      { id: 'target', composite: { kind: 'mask', source: 'mask', mode: 'alpha' } },
      { id: 'target-shape', parent: 'target', components: [{ type: 'shape2d', shape: 'rect', size: [20, 20], fill: [1, 0, 0, 1] }] },
      { id: 'mask', parent: 'target', components: [{ type: 'shape2d', shape: 'ellipse', size: [10, 10], fill: [1, 1, 1, 1] }] },
    ],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);

  const runtimeRoot = owner.children[0];
  const target = runtimeRoot.children.find(entity => entity.name === 'target');
  const targetShape = target.children[0].children.find(entity => entity.name === 'target-shape');
  const mask = target.children[0].children.find(entity => entity.name === 'mask');
  const targetVisual = [...targetShape.children[0].children[0].components.values()].find(component => component.name === 'AnimationVisual2D');
  const maskVisual = [...mask.children[0].children[0].components.values()].find(component => component.name === 'AnimationVisual2D');
  assert.equal(targetVisual.compositeSource, 'mask');
  assert.equal(targetVisual.sourceOnly, false);
  assert.equal(maskVisual.nodeId, 'mask');
  assert.equal(maskVisual.sourceOnly, true);
});

test('animated composite expansion samples into runtime-owned layer data', () => {
  const world = new World();
  const owner = new Entity('animated composite player').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [
      {
        id: 'target',
        composite: {
          kind: 'mask', source: 'mask', mode: 'alpha', expansion: -2,
          expansionTrack: { times: [0, 1], values: [-2, 6], valueSize: 1, interpolation: 'linear' },
        },
        components: [{ type: 'shape2d', shape: 'rect', size: [20, 20], fill: [1, 0, 0, 1] }],
      },
      { id: 'mask', components: [{ type: 'shape2d', shape: 'ellipse', size: [10, 10], fill: [1, 1, 1, 1] }] },
    ],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const target = owner.children[0].children.find(entity => entity.name === 'target');
  const visual = findComponentByName(target, 'AnimationVisual2D');
  assert.equal(visual.compositeLayers[0].expansion, -2);
  player.seek(0.5);
  world.update(500, 0);
  assert.equal(visual.compositeLayers[0].expansion, 2);
});

test('sprite loader preserves encoded 2D color on the unorm presentation path and releases its retained handle', async () => {
  let released = 0;
  const texture = {};
  const assetManager = {
    async loadTexture(uri, options) {
      assert.equal(uri, '/sprite.png');
      assert.equal(options.format, 'rgba8unorm');
      return { key: uri, value: texture, release: () => { released++; } };
    },
  };
  const world = new World();
  const owner = new Entity('sprite player').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    resources: [{ id: 'sprite', type: 'image', uri: '/sprite.png', width: 32, height: 16 }],
    nodes: [{ id: 'sprite-node', components: [{ type: 'sprite2d', resource: 'sprite', size: [32, 16] }] }],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem({ assetManager }));
  world.update(0, 0);
  assert.equal(player.runtimeStats.pendingResourceCount, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.runtimeStats.pendingResourceCount, 0);
  assert.equal(player.runtimeStats.failedResourceCount, 0);
  owner.removeComponent(player);
  assert.equal(released, 1);
});

test('shared web-font loading invalidates every text rasterizer and releases the retained face', async () => {
  const previousDocument = globalThis.document;
  const previousFontFace = globalThis.FontFace;
  const canvases = [];
  const addedFaces = [];
  const deletedFaces = [];
  let loadCalls = 0;
  let released = 0;
  class TestFontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
    }
    async load() { return this; }
  }
  globalThis.FontFace = TestFontFace;
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      const canvas = {
        widthWrites: 0,
        heightWrites: 0,
        set width(value) { this._width = value; this.widthWrites++; },
        get width() { return this._width ?? 0; },
        set height(value) { this._height = value; this.heightWrites++; },
        get height() { return this._height ?? 0; },
        getContext() { return null; },
      };
      canvases.push(canvas);
      return canvas;
    },
    fonts: {
      add(face) { addedFaces.push(face); },
      delete(face) { deletedFaces.push(face); return true; },
    },
  };
  try {
    const assetManager = {
      async load(key) {
        loadCalls++;
        assert.match(key, /^Animation2D\.font:/);
        return { key, value: new ArrayBuffer(16), release: () => { released++; } };
      },
    };
    const textComponent = {
      type: 'text2d', text: 'Font', size: [80, 24], color: [1, 1, 1, 1],
      fontFamily: 'Corpus Font', fontSize: 18, fontWeight: 400, fontStyle: 'normal',
      fontResource: 'font:corpus',
    };
    const world = new World();
    const owner = new Entity('font player').addComponent(new Transform2D());
    const player = new Animation2DComponent({
      ...animationFixture(),
      resources: [{
        id: 'font:corpus', type: 'binary', uri: '/fonts/corpus.woff2',
        mimeType: 'font/woff2', integrity: 'font-sha256',
      }],
      nodes: [
        { id: 'label-a', components: [textComponent] },
        { id: 'label-b', components: [textComponent] },
      ],
      tracks: [],
    }, { autoplay: false });
    owner.addComponent(player);
    world.addEntity(owner);
    world.addSystem(new Animation2DSystem({ assetManager }));
    world.update(0, 0);
    assert.equal(player.runtimeStats.pendingResourceCount, 1);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loadCalls, 1);
    assert.equal(addedFaces.length, 1);
    assert.deepEqual(addedFaces[0].descriptors, { style: 'normal', weight: '400' });
    assert.equal(player.runtimeStats.pendingResourceCount, 0);
    assert.equal(player.runtimeStats.failedResourceCount, 0);
    assert.equal(canvases.length, 2);
    assert.ok(canvases.every(canvas => canvas.widthWrites >= 2), 'every text atlas must rerasterize after FontFace.load()');
    owner.removeComponent(player);
    assert.equal(deletedFaces.length, 1);
    assert.equal(released, 1);
  } finally {
    if (previousFontFace === undefined) delete globalThis.FontFace;
    else globalThis.FontFace = previousFontFace;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('sprite uvRectTrack advances atlas frames without revising within the same STEP frame', () => {
  const world = new World();
  const owner = new Entity('spritesheet player').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    resources: [{ id: 'atlas', type: 'image', uri: '/atlas.png', width: 100, height: 100 }],
    nodes: [{ id: 'sprite-node', components: [{
      type: 'sprite2d', resource: 'atlas', size: [20, 20],
      uvRectTrack: {
        times: [0, 0.5, 0.75], valueSize: 4, interpolation: 'step',
        values: [0, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5],
      },
    }] }],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  const visual = owner.children[0].children[0].children[0].children[0].getComponent(Symbol.for('AnimationVisual2D'));
  assert.deepEqual(visual.uvRect, [0, 0, 0.5, 0.5]);

  player.seek(0.6);
  world.update(600, 0);
  assert.deepEqual(visual.uvRect, [0.5, 0, 0.5, 0.5]);
  const revision = visual.revision;
  player.seek(0.7);
  world.update(700, 0);
  assert.equal(visual.revision, revision);

  player.seek(0.8);
  world.update(800, 0);
  assert.deepEqual(visual.uvRect, [0, 0.5, 0.5, 0.5]);
});

test('text, particle and audio components instantiate core runtime capabilities', () => {
  const world = new World();
  const owner = new Entity('media player').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    resources: [{ id: 'tone', type: 'audio', uri: 'data:audio/wav;base64,UklGRg==' }],
    nodes: [
      { id: 'label', components: [{
        type: 'text2d', text: 'Haiyue', size: [120, 32], color: [1, 0.8, 0.2, 1],
        fontSize: 24, textAlign: 'left', verticalAlign: 'middle',
      }] },
      { id: 'sparks', components: [{
        type: 'particle2d', maxParticles: 32, emissionRate: 20, burst: 4,
        lifetime: [0.4, 0.8], speed: [20, 40], angle: [-1, 1],
        startSize: [4, 8], endSize: [0, 2], startColor: [1, 1, 1, 1], endColor: [1, 0, 0, 0],
      }] },
      { id: 'sound', components: [{ type: 'audio', resource: 'tone', volume: 0.5 }] },
    ],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.addSystem(new Particle2DSystem());
  world.update(0, 0);

  assert.deepEqual(player.runtimeStats, {
    nodeCount: 3, visualCount: 2, unsupportedComponentCount: 0,
    pendingResourceCount: 0, failedResourceCount: 0,
    textCount: 1, particleCount: 1, audioCount: 1,
  });
  const particle = findComponent(owner, ParticleEmitter2D);
  assert.ok(particle);
  assert.equal(particle.playing, false);
  player.play();
  world.update(100, 100);
  assert.equal(particle.playing, true);
  assert.ok(particle.activeParticles > 0);
  player.pause();
  assert.equal(particle.playing, false);
});

test('particle composites fail visibly instead of rendering with incorrect mask semantics', () => {
  const world = new World();
  const owner = new Entity('composited particles').addComponent(new Transform2D());
  const player = new Animation2DComponent({
    ...animationFixture(),
    nodes: [
      { id: 'target', composite: { kind: 'mask', source: 'mask', mode: 'alpha' }, components: [{
        type: 'particle2d', maxParticles: 8, emissionRate: 1, lifetime: [1, 1], speed: [0, 0], angle: [0, 0],
        startSize: [1, 1], endSize: [1, 1], startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0],
      }] },
      { id: 'mask', components: [{ type: 'shape2d', shape: 'rect', size: [10, 10], fill: [1, 1, 1, 1] }] },
    ],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  assert.equal(player.runtimeStats.particleCount, 0);
  assert.equal(player.runtimeStats.unsupportedComponentCount, 1);
  assert.equal(findComponent(owner, ParticleEmitter2D), undefined);
});

test('destroy end behavior releases visuals and play restarts from zero', () => {
  const world = new World();
  const system = new Animation2DSystem();
  world.addSystem(system);
  const entity = new Entity('destroying animation');
  const component = new Animation2DComponent({
    ...animationFixture(),
    duration: 0.1,
    endBehavior: 'destroy',
    tracks: [],
  });
  entity.addComponent(component);
  world.addEntity(entity);

  world.update(0, 200);
  assert.equal(component.completed, true);
  assert.equal(component.runtimeStats.visualCount, 0);
  component.play();
  assert.equal(component.currentTime, 0);
  world.update(200, 0);
  assert.equal(component.runtimeStats.visualCount, 1);
});

test('anchor content transform affects visuals and child nodes as a pivot', () => {
  const world = new World();
  const owner = new Entity('player').addComponent(new Transform2D());
  const component = new Animation2DComponent({
    ...animationFixture(),
    nodes: [
      { id: 'parent', transform: { position: [50, 40], anchor: [10, 15], rotation: 0.5 } },
      { id: 'child', parent: 'parent', components: [{ type: 'shape2d', shape: 'rect', size: [8, 6], fill: [1, 1, 1, 1] }] },
    ],
    tracks: [],
  }, { autoplay: false });
  owner.addComponent(component);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);

  const generatedRoot = owner.children[0];
  const parent = generatedRoot.children[0];
  const anchor = parent.children[0];
  const child = anchor.children[0];
  assert.equal(parent.getComponent(Transform2D).rotation, -0.5);
  assert.equal(anchor.getComponent(Transform2D).x, -10);
  assert.equal(anchor.getComponent(Transform2D).y, 15);
  assert.equal(child.name, 'child');
});

test('animation asset loader shares network and parsed caches', async () => {
  const binary = encodeAnimationBinary({
    ...animationFixture(),
    resources: [
      { id: 'sprite', type: 'image', uri: 'assets/sprite.png', mimeType: 'image/png' },
      { id: 'inline', type: 'binary', uri: 'data:application/octet-stream;base64,AA==' },
    ],
  });
  let fetchCount = 0;
  const loader = createAnimationAssetLoader({
    fetch: async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: 'https://edge.example.test/releases/package/motion.hya',
        arrayBuffer: async () => binary,
      };
    },
  });
  const phases = [];
  const progress = [];
  const network = new Map();
  const parsed = new Map();
  const context = {
    cache: {
      network: { get: key => network.get(key), set: (key, value) => network.set(key, value) },
      parsed: { get: key => parsed.get(key), set: (key, value) => parsed.set(key, value) },
    },
    signal: new AbortController().signal,
    setPhase: phase => phases.push(phase),
    reportProgress: (loaded, total) => progress.push([loaded, total]),
  };

  const sourceUrl = 'https://cdn.example.test/package/motion.hya';
  const first = await loader.load(sourceUrl, context);
  const second = await loader.load(sourceUrl, context);
  assert.equal(first, second);
  assert.equal(first.source, 'binary');
  assert.equal(fetchCount, 1);
  assert.equal(first.resources[0].uri, 'https://edge.example.test/releases/package/assets/sprite.png');
  assert.equal(first.resources[1].uri, 'data:application/octet-stream;base64,AA==');
  assert.deepEqual(phases, ['loading', 'parsing', 'loading', 'parsing']);
  assert.deepEqual(progress.at(-1), [binary.byteLength, binary.byteLength]);
});

test('runtime extensions create, receive opacity and dispose by registration identity', () => {
  const extensionId = 'org.example.badge@1';
  const formatExtensions = new AnimationExtensionRegistry();
  formatExtensions.register({ id: extensionId });
  const animation = parseAnimation({
    ...animationFixture(),
    nodes: [{
      id: 'badge',
      transform: { opacity: 0.4 },
      components: [{ type: extensionId, label: 'NEW' }],
    }],
    tracks: [],
    extensionsUsed: [extensionId],
    extensionsRequired: [extensionId],
  }, { extensions: formatExtensions });

  const runtimeExtensions = new Animation2DExtensionRegistry();
  const opacities = [];
  let destroyed = 0;
  const unregister = runtimeExtensions.register({
    id: extensionId,
    create({ parent, component }) {
      assert.equal(component.label, 'NEW');
      parent.addChild(new Entity('extension visual').addComponent(new Transform2D()));
      return {
        setOpacity: opacity => opacities.push(opacity),
        destroy: () => { destroyed++; },
      };
    },
  });
  const world = new World();
  const owner = new Entity('extension player').addComponent(new Transform2D());
  const player = new Animation2DComponent(animation, { autoplay: false, runtimeExtensions });
  owner.addComponent(player);
  world.addEntity(owner);
  world.addSystem(new Animation2DSystem());
  world.update(0, 0);
  assert.equal(player.runtimeStats.unsupportedComponentCount, 0);
  assert.equal(player.runtimeStats.visualCount, 1);
  assert.deepEqual(opacities, [0.4]);

  owner.removeComponent(player);
  assert.equal(destroyed, 1);
  unregister();
  unregister();
  assert.equal(runtimeExtensions.has(extensionId), false);
});

function findComponent(entity, Type) {
  const component = entity.getComponent(Type);
  if (component) return component;
  for (const child of entity.children) {
    const found = findComponent(child, Type);
    if (found) return found;
  }
  return undefined;
}

function findComponentByName(entity, name) {
  const component = [...entity.components.values()].find(item => item.name === name);
  if (component) return component;
  for (const child of entity.children) {
    const found = findComponentByName(child, name);
    if (found) return found;
  }
  return undefined;
}

function cubicYForX(x, x1, y1, x2, y2) {
  let parameter = x;
  for (let iteration = 0; iteration < 8; iteration++) {
    const estimate = cubicCoordinate(parameter, x1, x2) - x;
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(derivative) < 1e-7) break;
    parameter = Math.min(1, Math.max(0, parameter - estimate / derivative));
  }
  return cubicCoordinate(parameter, y1, y2);
}

function cubicCoordinate(value, first, second) {
  const inverse = 1 - value;
  return 3 * inverse * inverse * value * first
    + 3 * inverse * value * value * second
    + value * value * value;
}

function cubicDerivative(value, first, second) {
  const inverse = 1 - value;
  return 3 * inverse * inverse * first
    + 6 * inverse * value * (second - first)
    + 3 * value * value * (1 - second);
}
