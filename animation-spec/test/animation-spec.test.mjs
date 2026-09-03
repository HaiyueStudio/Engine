import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANIMATION_FORMAT,
  ANIMATION_VERSION,
  AnimationExtensionRegistry,
  AnimationFormatError,
  HYA_STATE_MACHINE_CHANNEL_REGISTRY,
  HYA_STATE_MACHINE_EXTENSION_ID,
  encodeAnimationBinary,
  evaluateSafeExpression,
  isAnimationBinary,
  parseAnimation,
  parseHyaStateMachineExtension,
  hyaStateMachineChannelCapability,
} from '../dist/index.js';
import { convertLottie, inspectLottieFonts } from '../dist/lottie.js';

function documentFixture() {
  return {
    format: ANIMATION_FORMAT,
    version: ANIMATION_VERSION,
    name: 'Pulse',
    canvas: { width: 320, height: 180, coordinateSystem: 'screen-y-down' },
    duration: 2,
    endBehavior: 'loop',
    nodes: [{
      id: 'shape',
      transform: { position: [40, 50], opacity: 1 },
      components: [{ type: 'shape2d', shape: 'rect', size: [80, 30], fill: [0.1, 0.4, 1, 1] }],
    }],
    tracks: [{
      node: 'shape',
      property: 'position',
      interpolation: 'cubic-bezier',
      times: [0, 1, 2],
      values: [40, 50, 160, 90, 280, 50],
      easings: [0.42, 0, 0.58, 1, 0.42, 0, 0.58, 1],
    }],
  };
}

function stateMachineDocumentFixture() {
  return {
    ...documentFixture(),
    extensionsUsed: [HYA_STATE_MACHINE_EXTENSION_ID],
    extensionsRequired: [HYA_STATE_MACHINE_EXTENSION_ID],
    extensions: {
      [HYA_STATE_MACHINE_EXTENSION_ID]: {
        clips: [
          { id: 'idle', name: 'Idle', start: 0, duration: 1 },
          { id: 'run', name: 'Run', start: 1, duration: 1 },
        ],
        stateMachine: {
          format: 'haiyue-animation-state-machine@1',
          id: 'character',
          name: 'Character',
          parameters: [{ name: 'moving', type: 'boolean', defaultValue: false }],
          layers: [{
            id: 'base', name: 'Base', initialStateId: 'idle',
            states: [
              { id: 'idle', name: 'Idle', motion: { kind: 'clip', clipId: 'idle' }, loop: 'repeat' },
              { id: 'run', name: 'Run', motion: { kind: 'clip', clipId: 'run' }, loop: 'repeat' },
            ],
            transitions: [{
              id: 'move', from: 'idle', to: 'run', duration: 0.2,
              conditions: [{ parameter: 'moving', operator: 'is-true' }],
            }],
          }],
        },
      },
    },
  };
}

test('state-machine channel registry freezes sampling, mixing and ownership capability', () => {
  assert.equal(HYA_STATE_MACHINE_CHANNEL_REGISTRY.size, 12);
  assert.deepEqual(hyaStateMachineChannelCapability('sprite-uv'), {
    id: 'sprite-uv',
    kind: 'discrete-step',
    support: 'full',
    sampling: 'step-track',
    mixing: 'dominant-weight-then-action-order',
    ownership: 'shared-visual',
    transition: 'switch-at-dominant-weight',
  });
  assert.equal(hyaStateMachineChannelCapability('audio').support, 'degraded');
  assert.equal(
    hyaStateMachineChannelCapability('vector-paint').diagnosticCode,
    'E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED',
  );
  assert.equal(Object.isFrozen(hyaStateMachineChannelCapability('particle-2d')), true);
  assert.equal(hyaStateMachineChannelCapability('particle-3d').ownership, 'shared-side-effect');
});

function rewriteV2Metadata(binary, mutate) {
  const header = new DataView(binary);
  const metadataOffset = header.getUint32(8, true);
  const metadataLength = header.getUint32(12, true);
  const oldFloatOffset = header.getUint32(16, true);
  const floatCount = header.getUint32(20, true);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, metadataOffset, metadataLength)));
  mutate(metadata);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const floatOffset = (24 + metadataBytes.byteLength + 3) & ~3;
  const result = new ArrayBuffer(floatOffset + floatCount * 4);
  new Uint8Array(result, 0, 24).set(new Uint8Array(binary, 0, 24));
  const resultHeader = new DataView(result);
  resultHeader.setUint32(12, metadataBytes.byteLength, true);
  resultHeader.setUint32(16, floatOffset, true);
  new Uint8Array(result, 24, metadataBytes.byteLength).set(metadataBytes);
  new Uint8Array(result, floatOffset, floatCount * 4).set(new Uint8Array(binary, oldFloatOffset, floatCount * 4));
  return result;
}

test('parser compiles authoring arrays into bounded typed runtime tracks', () => {
  const parsed = parseAnimation(documentFixture());
  assert.equal(parsed.source, 'json');
  assert.equal(parsed.nodes.length, 1);
  assert.ok(parsed.tracks[0].times instanceof Float32Array);
  assert.ok(parsed.tracks[0].values instanceof Float32Array);
  assert.equal(parsed.tracks[0].valueSize, 2);
  assert.throws(
    () => parseAnimation({ ...documentFixture(), tracks: [{ ...documentFixture().tracks[0], times: [0, 0] }] }),
    error => error instanceof AnimationFormatError && /strictly increasing/.test(error.message),
  );
  assert.throws(() => parseAnimation(documentFixture(), { maxNodes: 0 }), /positive safe integer/);
});

test('HYA binary keeps one zero-copy Float32 track pool', () => {
  const binary = encodeAnimationBinary(documentFixture());
  assert.equal(isAnimationBinary(binary), true);
  assert.equal(new DataView(binary).getUint16(4, true), 2, 'new files must use the explicit compact v2 container');
  const parsed = parseAnimation(binary);
  assert.equal(parsed.source, 'binary');
  assert.equal(parsed.backingBuffer, binary);
  assert.equal(parsed.tracks[0].times.buffer, binary);
  assert.deepEqual(Array.from(parsed.tracks[0].values), [40, 50, 160, 90, 280, 50]);

  const copied = parseAnimation(binary, { copyFloatData: true });
  assert.notEqual(copied.tracks[0].times.buffer, binary);

  const corrupt = binary.slice(0);
  new DataView(corrupt).setUint32(20, 0xffffffff, true);
  assert.throws(
    () => parseAnimation(corrupt),
    error => error instanceof AnimationFormatError && error.code === 'E_ANIMATION_INVALID_BINARY',
  );
});

test('HYA built-in state machine keeps named clips in one v2 asset and round-trips without a registry', () => {
  const json = parseAnimation(stateMachineDocumentFixture());
  const extension = json.extensions[HYA_STATE_MACHINE_EXTENSION_ID];
  assert.deepEqual(extension.clips.map(clip => clip.id), ['idle', 'run']);
  assert.equal(extension.stateMachine.layers[0].initialStateId, 'idle');

  const binary = encodeAnimationBinary(stateMachineDocumentFixture());
  assert.equal(new DataView(binary).getUint16(4, true), 2);
  const decoded = parseAnimation(binary);
  assert.equal(decoded.source, 'binary');
  assert.equal(decoded.extensions[HYA_STATE_MACHINE_EXTENSION_ID].stateMachine.layers[0].transitions[0].to, 'run');
  assert.deepEqual(Array.from(decoded.tracks[0].times), [0, 1, 2]);
});

test('HYA built-in state machine rejects invalid clip ranges and references with precise paths', () => {
  const outside = stateMachineDocumentFixture();
  outside.extensions[HYA_STATE_MACHINE_EXTENSION_ID].clips[1].duration = 2;
  assert.throws(
    () => parseHyaStateMachineExtension(
      outside.extensions[HYA_STATE_MACHINE_EXTENSION_ID],
      outside.duration,
    ),
    error => error instanceof AnimationFormatError
      && /clips\[1\]/.test(error.path)
      && /fit inside/.test(error.message),
  );

  const missingClip = stateMachineDocumentFixture();
  missingClip.extensions[HYA_STATE_MACHINE_EXTENSION_ID].stateMachine.layers[0].states[1].motion.clipId = 'missing';
  assert.throws(
    () => parseHyaStateMachineExtension(
      missingClip.extensions[HYA_STATE_MACHINE_EXTENSION_ID],
      missingClip.duration,
    ),
    error => error instanceof AnimationFormatError
      && /states\[1\]\.motion\.clipId/.test(error.path)
      && /Unknown HYA clip/.test(error.message),
  );

  const wrongCondition = stateMachineDocumentFixture();
  wrongCondition.extensions[HYA_STATE_MACHINE_EXTENSION_ID].stateMachine.layers[0].transitions[0].conditions[0] = {
    parameter: 'moving', operator: 'greater', value: 0,
  };
  assert.throws(
    () => parseHyaStateMachineExtension(
      wrongCondition.extensions[HYA_STATE_MACHINE_EXTENSION_ID],
      wrongCondition.duration,
    ),
    error => error instanceof AnimationFormatError
      && /conditions\[0\]\.operator/.test(error.path)
      && /invalid for boolean/.test(error.message),
  );
});

test('track validation accepts only the Float32 representation of the composition end', () => {
  const duration = 103 / 30;
  const source = {
    ...documentFixture(),
    duration,
    tracks: [{
      node: 'shape',
      property: 'opacity',
      interpolation: 'linear',
      times: [0, duration],
      values: [0, 1],
    }],
  };
  const parsed = parseAnimation(encodeAnimationBinary(source));
  const roundedDuration = Math.fround(duration);
  assert.ok(roundedDuration > duration);
  assert.equal(parsed.tracks[0].times[1], roundedDuration);

  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, roundedDuration, true);
  bits.setUint32(0, bits.getUint32(0, true) + 1, true);
  const nextFloat32 = bits.getFloat32(0, true);
  assert.throws(() => parseAnimation({
    ...source,
    tracks: [{ ...source.tracks[0], times: [0, nextFloat32] }],
  }), /exceeds the composition duration/);
});

test('HYA v2 keeps legacy v1 readable and rejects unknown container versions', () => {
  const legacy = Buffer.from(
    'SFlBMQEAAAAYAAAAAwIAABwCAAAEAAAAeyJmb3JtYXQiOiJoYWl5dWUtYW5pbWF0aW9uIiwidmVyc2lvbiI6IjEuMCIsImNhbnZhcyI6eyJ3aWR0aCI6MTAsImhlaWdodCI6MjAsImNvb3JkaW5hdGVTeXN0ZW0iOiJzY3JlZW4teS1kb3duIn0sImR1cmF0aW9uIjoxLCJlbmRCZWhhdmlvciI6ImhvbGQiLCJub2RlcyI6W3siaWQiOiJuIiwidHJhbnNmb3JtIjp7InBvc2l0aW9uIjpbMSwyXSwib3BhY2l0eSI6MC41fSwiY29tcG9uZW50cyI6W3sidHlwZSI6InNoYXBlMmQiLCJzaGFwZSI6InJlY3QiLCJzaXplIjpbMyw0XSwiZmlsbCI6WzEsMCwwLDFdfV19XSwidHJhY2tzIjpbeyJub2RlIjoibiIsInByb3BlcnR5Ijoib3BhY2l0eSIsImludGVycG9sYXRpb24iOiJsaW5lYXIiLCJ0aW1lcyI6eyJvZmZzZXQiOjAsImxlbmd0aCI6Mn0sInZhbHVlcyI6eyJvZmZzZXQiOjIsImxlbmd0aCI6Mn19XSwicmVzb3VyY2VzIjpbXSwiZXh0ZW5zaW9uc1VzZWQiOltdLCJleHRlbnNpb25zUmVxdWlyZWQiOltdLCJleHRlbnNpb25zIjp7fSwibmFtZSI6InYxIn0AAAAAAAAAgD8AAAA/AACAPw==',
    'base64',
  );
  const legacyBuffer = legacy.buffer.slice(legacy.byteOffset, legacy.byteOffset + legacy.byteLength);
  const parsed = parseAnimation(legacyBuffer);
  assert.equal(parsed.name, 'v1');
  assert.deepEqual(Array.from(parsed.tracks[0].values), [0.5, 1]);

  const unknown = encodeAnimationBinary(documentFixture()).slice(0);
  new DataView(unknown).setUint16(4, 3, true);
  assert.throws(
    () => parseAnimation(unknown),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_INVALID_BINARY'
      && /3\.0/.test(error.message),
  );
});

test('HYA v2 indexes repeated strings and deduplicates keyframe time/easing blocks', () => {
  const source = {
    ...documentFixture(),
    tracks: [
      documentFixture().tracks[0],
      {
        node: 'shape', property: 'scale', interpolation: 'cubic-bezier',
        times: [0, 1, 2], values: [1, 1, 2, 2, 1, 1],
        easings: [0.42, 0, 0.58, 1, 0.42, 0, 0.58, 1],
      },
    ],
  };
  const binary = encodeAnimationBinary(source);
  const header = new DataView(binary);
  const metadataOffset = header.getUint32(8, true);
  const metadataLength = header.getUint32(12, true);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, metadataOffset, metadataLength)));
  assert.ok(Array.isArray(metadata), 'v2 metadata should use the compact indexed root tuple');
  assert.deepEqual(metadata[9][0][3], metadata[9][1][3], 'identical keyframe times should share one float range');
  assert.deepEqual(metadata[9][0][5], metadata[9][1][5], 'identical easing curves should share one float range');
  assert.deepEqual(Array.from(parseAnimation(binary).tracks[1].values), [1, 1, 2, 2, 1, 1]);
});

test('HYA v2 fast path rejects graph cycles, invalid compact values and count overflow', () => {
  const twoNodes = encodeAnimationBinary({
    ...documentFixture(),
    nodes: [{ id: 'a' }, { id: 'b' }],
    tracks: [],
  });
  assert.throws(
    () => parseAnimation(twoNodes, { maxNodes: 1 }),
    error => error instanceof AnimationFormatError && error.code === 'E_ANIMATION_LIMIT_EXCEEDED',
  );

  const cycle = rewriteV2Metadata(twoNodes, metadata => {
    metadata[8][0][2] = 1;
    metadata[8][1][2] = 0;
  });
  assert.throws(
    () => parseAnimation(cycle),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_INVALID_BINARY'
      && /cycle/.test(error.message),
  );

  const compositeSource = encodeAnimationBinary({
    ...documentFixture(),
    nodes: [
      { id: 'a', composite: { kind: 'mask', source: 'b', mode: 'alpha' } },
      { id: 'b' },
    ],
    tracks: [],
  });
  const compositeCycle = rewriteV2Metadata(compositeSource, metadata => {
    metadata[8][1][6] = [...metadata[8][0][6]];
    metadata[8][1][6][1] = 0;
  });
  assert.throws(
    () => parseAnimation(compositeCycle),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_INVALID_BINARY'
      && /Composite graph contains a cycle/.test(error.message),
  );

  const invalidColor = rewriteV2Metadata(encodeAnimationBinary(documentFixture()), metadata => {
    metadata[8][0][7][0][4][3] = 2;
  });
  assert.throws(
    () => parseAnimation(invalidColor),
    error => error instanceof AnimationFormatError
      && error.code === 'E_ANIMATION_INVALID_BINARY'
      && /\[0, 1\]/.test(error.message),
  );
});

test('HYA binary packs vector path values into the same zero-copy Float32 pool', () => {
  const source = {
    ...documentFixture(),
    nodes: [{
      id: 'path',
      components: [{
        type: 'path2d', commands: 'MLLLZ', values: [0, 0, 80, 0, 80, 40, 0, 40],
        fill: [0.2, 0.3, 0.4, 1], fillRule: 'evenodd',
      }],
    }],
    tracks: [],
  };
  const binary = encodeAnimationBinary(source);
  const parsed = parseAnimation(binary);
  const path = parsed.nodes[0].components[0];
  assert.equal(path.type, 'path2d');
  assert.equal(path.values.buffer, binary);
  assert.deepEqual(Array.from(path.values), [0, 0, 80, 0, 80, 40, 0, 40]);
  assert.notEqual(parseAnimation(binary, { copyFloatData: true }).nodes[0].components[0].values.buffer, binary);
});

test('HYA v2 round-trips ordered composite stacks and animated vector paints', () => {
  const source = {
    ...documentFixture(),
    nodes: [
      { id: 'mask-a', components: [{ type: 'shape2d', shape: 'rect', size: [80, 80], fill: [1, 1, 1, 1] }] },
      { id: 'mask-b', components: [{ type: 'shape2d', shape: 'ellipse', size: [40, 40], fill: [1, 1, 1, 1] }] },
      {
        id: 'paint',
        composite: { layers: [
          {
            kind: 'mask', source: 'mask-a', mode: 'luma', operation: 'add', feather: [2, 3], expansion: 1,
            expansionTrack: { times: [0, 2], values: [1, 4], valueSize: 1, interpolation: 'linear' },
          },
          { kind: 'mask', source: 'mask-b', mode: 'alpha-inverted', operation: 'subtract' },
        ] },
        components: [{
          type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, 40, 0, 40, 40, 0, 40],
          blendMode: 'screen',
          morph: {
            times: [0, 2], valueSize: 8, interpolation: 'linear',
            values: [0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 5, 0, 0, 0, 0, 0],
          },
          morphRelative: true,
          fill: {
            kind: 'linear-gradient', start: [0, 0], end: [40, 0], opacity: 0.75,
            stops: [0, 1, 0, 0, 1, 1, 0, 0, 1, 0.5],
            opacityTrack: { times: [0, 2], values: [0.75, 0.25], valueSize: 1, interpolation: 'linear' },
          },
          fillRule: 'evenodd',
        }],
      },
    ],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-shape@1'],
  };
  const binary = encodeAnimationBinary(source);
  const parsed = parseAnimation(binary);
  assert.deepEqual(parsed.nodes[2].composite.layers.map(layer => [layer.mode, layer.operation]), [
    ['luma', 'add'], ['alpha-inverted', 'subtract'],
  ]);
  assert.equal(parsed.nodes[2].composite.layers[0].expansionTrack.values.buffer, binary);
  assert.deepEqual(Array.from(parsed.nodes[2].composite.layers[0].expansionTrack.values), [1, 4]);
  const vector = parsed.nodes[2].components[0];
  assert.equal(vector.values.buffer, binary);
  assert.equal(vector.morph.values.buffer, binary);
  assert.equal(vector.morphRelative, true);
  assert.equal(vector.blendMode, 'screen');
  assert.equal(vector.fill.opacity, 0.75);
  assert.deepEqual(Array.from(vector.fill.opacityTrack.values), [0.75, 0.25]);
});

test('HYA v2 packs Lottie stroke values without changing the extension array contract', () => {
  const source = {
    ...documentFixture(),
    nodes: [{
      id: 'stroke',
      components: [{
        type: 'org.haiyue.vector-stroke@1',
        commands: 'MLL', values: [0, 0, 10, 10, 20, 0], color: [1, 0.5, 0, 1],
        width: 2, lineCap: 'round', lineJoin: 'bevel', miterLimit: 4, tolerance: 0.2,
      }],
    }],
    tracks: [],
    extensionsUsed: ['org.haiyue.vector-stroke@1'],
  };
  const decoded = parseAnimation(encodeAnimationBinary(source));
  const stroke = decoded.nodes[0].components[0];
  assert.ok(Array.isArray(stroke.values));
  assert.deepEqual(stroke.values, [0, 0, 10, 10, 20, 0]);
});

test('parser validates sprite resource types, accepts nested composites and rejects composite cycles', () => {
  assert.throws(() => parseAnimation({
    ...documentFixture(), nodes: [{ id: 'bad-path', components: [{ type: 'path2d', commands: 'MZ', values: [0, 0], fill: [1, 1, 1, 1] }] }], tracks: [],
  }), /at least three points/);
  assert.throws(() => parseAnimation({
    ...documentFixture(), resources: [{ id: 'blob', type: 'binary', uri: 'data:application/octet-stream;base64,AA==' }],
    nodes: [{ id: 'sprite', components: [{ type: 'sprite2d', resource: 'blob', size: [1, 1] }] }], tracks: [],
  }), /must have type "image"/);
  assert.doesNotThrow(() => parseAnimation({
    ...documentFixture(), nodes: [
      { id: 'a', composite: { kind: 'mask', source: 'b', mode: 'alpha' } },
      { id: 'b', composite: { kind: 'mask', source: 'c', mode: 'alpha' } },
      { id: 'c' },
    ], tracks: [],
  }));
  assert.throws(() => parseAnimation({
    ...documentFixture(), nodes: [
      { id: 'a', composite: { kind: 'mask', source: 'b', mode: 'alpha' } },
      { id: 'b', composite: { kind: 'mask', source: 'a', mode: 'alpha' } },
    ], tracks: [],
  }), /Composite graph contains a cycle/);
});

test('sprite uvRectTrack validates atlas bounds and round-trips through the compact float pool', () => {
  const source = {
    ...documentFixture(),
    duration: 1,
    resources: [{ id: 'atlas', type: 'image', uri: '/atlas.png', width: 100, height: 100 }],
    nodes: [{
      id: 'sprite',
      components: [{
        type: 'sprite2d', resource: 'atlas', size: [20, 20],
        uvRectTrack: {
          times: [0, 0.5, 1], valueSize: 4, interpolation: 'step',
          values: [0, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5],
        },
      }],
    }],
    tracks: [],
  };
  const binary = encodeAnimationBinary(source);
  const decoded = parseAnimation(binary);
  const track = decoded.nodes[0].components[0].uvRectTrack;
  assert.deepEqual(Array.from(track.times), [0, 0.5, 1]);
  assert.deepEqual(Array.from(track.values), source.nodes[0].components[0].uvRectTrack.values);
  assert.equal(track.values.buffer, binary);
  assert.throws(() => parseAnimation({
    ...source,
    nodes: [{ id: 'sprite', components: [{
      ...source.nodes[0].components[0],
      uvRectTrack: { ...source.nodes[0].components[0].uvRectTrack, interpolation: 'linear' },
    }] }],
  }), /requires step interpolation/);
  assert.throws(() => parseAnimation({
    ...source,
    nodes: [{ id: 'sprite', components: [{
      ...source.nodes[0].components[0],
      uvRectTrack: { times: [0], valueSize: 4, interpolation: 'step', values: [0.9, 0, 0.2, 1] },
    }] }],
  }), /fit inside/);
});

test('parser validates bounded text, particle and audio core components', () => {
  const source = {
    ...documentFixture(),
    resources: [
      { id: 'dot', type: 'image', uri: '/dot.png' },
      { id: 'tone', type: 'audio', uri: '/tone.ogg', mimeType: 'audio/ogg' },
    ],
    nodes: [{
      id: 'media',
      components: [
        {
          type: 'text2d', text: 'Hello', size: [160, 40], color: [1, 1, 1, 1], fontSize: 24,
          fit: 'font-size', overflow: 'clip', fitFromBaseline: true, wrap: 'word',
          paragraphSpacing: 12,
          paragraphSpacingTrack: { times: [0, 1], values: [12, 24], valueSize: 1, interpolation: 'linear' },
          styleRuns: [
            {
              start: 0, end: 2, fontSize: 18, lineHeight: 22, color: [1, 0, 0, 1],
              fontSizeTrack: { times: [0, 1], values: [18, 20], valueSize: 1, interpolation: 'linear' },
              lineHeightTrack: { times: [0, 1], values: [22, 25], valueSize: 1, interpolation: 'linear' },
            },
            { start: 2, end: 5, fontWeight: 700, tracking: 1.5, color: [0, 0, 1, 1] },
          ],
          lineBackground: { fill: [0, 1, 0, 1], stroke: [1, 0, 1, 1], strokeWidth: 2, cornerRadius: 8, padding: 3 },
        },
        {
          type: 'particle2d', resource: 'dot', maxParticles: 128, emissionRate: 30, burst: 4,
          lifetime: [0.5, 1], speed: [10, 20], angle: [-1, 1], gravity: [0, 20],
          startSize: [4, 8], endSize: [0, 2], startColor: [1, 1, 1, 1], endColor: [1, 0, 0, 0],
          shape: 'circle', shapeRadius: 12, blendMode: 'additive',
        },
        { type: 'audio', resource: 'tone', volume: 0.7, playbackRate: 1.25 },
      ],
    }],
    tracks: [],
  };
  const parsed = parseAnimation(source);
  assert.deepEqual(parsed.nodes[0].components.map(component => component.type), ['text2d', 'particle2d', 'audio']);
  const roundTrip = parseAnimation(encodeAnimationBinary(source));
  assert.equal(roundTrip.nodes[0].components[0].fit, 'font-size');
  assert.equal(roundTrip.nodes[0].components[0].overflow, 'clip');
  assert.equal(roundTrip.nodes[0].components[0].fitFromBaseline, true);
  assert.equal(roundTrip.nodes[0].components[0].wrap, 'word');
  assert.equal(roundTrip.nodes[0].components[0].paragraphSpacing, 12);
  assert.deepEqual(Array.from(roundTrip.nodes[0].components[0].paragraphSpacingTrack.values), [12, 24]);
  assert.deepEqual(Array.from(roundTrip.nodes[0].components[0].styleRuns[0].lineHeightTrack.values), [22, 25]);
  assert.deepEqual(roundTrip.nodes[0].components[0].lineBackground, source.nodes[0].components[0].lineBackground);
  assert.equal(roundTrip.nodes[0].components[1].maxParticles, 128);
  assert.throws(() => parseAnimation(source, { maxTextCharacters: 4 }), /text characters/);
  assert.throws(() => parseAnimation(source, { maxParticleCapacity: 127 }), /particle capacity/);
  assert.throws(() => parseAnimation({
    ...source,
    nodes: [{ id: 'bad', components: [{ type: 'audio', resource: 'dot' }] }],
  }), /must have type "audio"/);
  assert.throws(() => parseAnimation({
    ...source,
    nodes: [{ id: 'bad', components: [{ ...source.nodes[0].components[1], resource: 'tone' }] }],
  }), /must have type "image"/);
});

test('required extensions are explicit and tokenized by registration identity', () => {
  const registry = new AnimationExtensionRegistry();
  const unregister = registry.register({ id: 'org.example.particle@1' });
  const extended = {
    ...documentFixture(),
    extensionsUsed: ['org.example.particle@1'],
    extensionsRequired: ['org.example.particle@1'],
    nodes: [{ id: 'particle', components: [{ type: 'org.example.particle@1', rate: 10 }] }],
    tracks: [],
  };
  assert.equal(parseAnimation(extended, { extensions: registry }).nodes.length, 1);
  unregister();
  assert.throws(() => parseAnimation(extended, { extensions: registry }), /not registered/);
  unregister();
});

test('Lottie converter emits core shape nodes, second-based tracks and diagnostics', () => {
  const result = convertLottie({
    nm: 'Lottie pulse', fr: 30, ip: 0, op: 60, w: 320, h: 180,
    layers: [{
      ind: 1, ty: 1, nm: 'Solid', sw: 40, sh: 20, sc: '#ff8040', ip: 0, op: 60,
      ks: {
        a: { a: 0, k: [20, 10] },
        p: { a: 1, k: [
          { t: 0, s: [40, 90], e: [280, 90], o: { x: 0.42, y: 0 }, i: { x: 0.58, y: 1 } },
          { t: 60, s: [280, 90] },
        ] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
    }],
  });
  assert.equal(result.document.duration, 2);
  assert.equal(result.document.nodes[0].components[0].type, 'shape2d');
  assert.deepEqual(result.document.tracks[0].times, [0, 2]);
  assert.equal(result.convertedLayerCount, 1);
});

test('position spatial tangents survive Lottie conversion, validation and binary round-trip', () => {
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 1, sw: 10, sh: 10, sc: '#ffffff', ip: 0, op: 30,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 1, k: [
          { t: 0, s: [0, 0], e: [100, 0], to: [0, 100], ti: [0, 100], o: { x: 0.333, y: 0.333 }, i: { x: 0.667, y: 0.667 } },
          { t: 30, s: [100, 0] },
        ] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
    }],
  }, { strict: true });
  const track = converted.document.tracks.find(candidate => candidate.property === 'position');
  assert.deepEqual(track.spatialTangents, [0, 100, 0, 100]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_SPATIAL_POSITION'));
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  assert.deepEqual(Array.from(decoded.tracks[0].spatialTangents), [0, 100, 0, 100]);
  assert.throws(() => parseAnimation({
    ...documentFixture(),
    tracks: [{ ...documentFixture().tracks[0], spatialTangents: [0, 1] }],
  }), /spatialTangents require position, non-step and 8 values/);
});

test('zero Lottie spatial handles stay linear and static fill opacity reaches core path alpha', () => {
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      shapes: [
        { ty: 'el', s: { a: 0, k: [20, 20] }, p: { a: 1, k: [
          { t: 0, s: [10, 0], to: [0, 0], ti: [0, 0] }, { t: 30, s: [70, 0] },
        ] } },
        { ty: 'fl', c: { a: 0, k: [0.2, 0.3, 0.7, 1] }, o: { a: 0, k: 60 }, r: 1 },
      ],
    }],
  }, { strict: true });
  assert.equal(converted.document.tracks[0].spatialTangents, undefined);
  assert.ok(Math.abs(converted.document.nodes.find(node => node.components)?.components[0].fill[3] - 0.6) < 1e-6);
});

test('Lottie trim-path and round-corners become ordered source-neutral vector modifiers', () => {
  const shape = { v: [[0, 0], [40, 0], [40, 40], [0, 40]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 80, h: 80,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      shapes: [{
        ty: 'gr', it: [
          { ty: 'sh', nm: 'Modified path', ks: { a: 0, k: shape } },
          { ty: 'rd', r: { a: 0, k: 5 } },
          { ty: 'tm', m: 1, s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [100] }] }, o: { a: 0, k: 90 } },
          { ty: 'st', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 4 }, lc: 1, lj: 1 },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      }],
    }],
  }, { strict: true });
  const component = converted.document.nodes.find(node => node.name === 'Modified path').components[0];
  assert.equal(component.type, 'org.haiyue.vector-shape@1');
  assert.deepEqual(component.modifiers.map(modifier => modifier.kind), ['round-corners', 'trim-path']);
  assert.equal(component.modifiers[1].offset, 0.25);
  assert.deepEqual(component.modifiers[1].endTrack.values, [0, 1]);
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  const decodedComponent = decoded.nodes.find(node => node.name === 'Modified path').components[0];
  assert.deepEqual(decodedComponent.modifiers.map(modifier => modifier.kind), ['round-corners', 'trim-path']);
  assert.deepEqual(Array.from(decodedComponent.modifiers[1].endTrack.values), [0, 1]);
  assert.deepEqual(converted.diagnostics, []);
});

test('Lottie converter maps static bezier paths, masks and alpha track mattes', () => {
  const path = {
    a: 0,
    k: { v: [[0, 0], [40, 0], [40, 40], [0, 40]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true },
  };
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [50, 50] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    nm: 'Composites', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      { ind: 1, ty: 4, nm: 'Matte', ip: 0, op: 30, ks, shapes: [{ ty: 'sh', ks: path }, { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } }] },
      { ind: 2, ty: 1, nm: 'Matted', sw: 80, sh: 80, sc: '#ff0000', ip: 0, op: 30, ks, tt: 1, tp: 1 },
      { ind: 3, ty: 1, nm: 'Masked', sw: 80, sh: 80, sc: '#00ff00', ip: 0, op: 30, ks,
        masksProperties: [{ mode: 'a', inv: false, pt: path, o: { a: 0, k: 100 } }] },
    ],
  }, { strict: true });
  const vector = converted.document.nodes.find(node => node.id.startsWith('layer:1:shape:'));
  assert.equal(vector.components[0].type, 'path2d');
  assert.equal(vector.components[0].commands, 'MLLLLZ');
  assert.deepEqual(converted.document.nodes.find(node => node.id === 'layer:2').composite,
    { kind: 'matte', source: 'layer:1', mode: 'alpha' });
  const masked = converted.document.nodes.find(node => node.id === 'layer:3');
  assert.equal(masked.composite.kind, 'mask');
  assert.equal(converted.document.nodes.find(node => node.id === masked.composite.source).components[0].type, 'path2d');
  assert.deepEqual(converted.diagnostics, []);
});

test('Lottie converter preserves ordered mask operations, luma mattes, feather and expansion', () => {
  const path = value => ({
    a: 0,
    k: { v: [[value, 0], [20 + value, 0], [20 + value, 20], [value, 20]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true },
  });
  const ks = { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      { ind: 1, ty: 1, ip: 0, op: 30, sw: 40, sh: 40, sc: '#ffffff', ks },
      {
        ind: 2, ty: 1, ip: 0, op: 30, sw: 80, sh: 80, sc: '#ff0000', ks, tt: 3, tp: 1,
        masksProperties: [
          { mode: 'a', pt: path(0), o: { a: 0, k: 100 }, f: { a: 0, k: [2, 3] }, x: { a: 0, k: 1 } },
          { mode: 's', inv: true, pt: path(4), o: { a: 0, k: 100 } },
          { mode: 'i', pt: path(8), o: { a: 0, k: 100 } },
          { mode: 'f', pt: path(12), o: { a: 0, k: 100 } },
        ],
      },
    ],
  }, { strict: true });
  const layers = converted.document.nodes.find(node => node.id === 'layer:2').composite.layers;
  assert.deepEqual(layers.map(layer => [layer.operation, layer.mode]), [
    ['add', 'alpha'], ['subtract', 'alpha-inverted'], ['intersect', 'alpha'], ['difference', 'alpha'], ['intersect', 'luma'],
  ]);
  assert.deepEqual(layers[0].feather, [2, 3]);
  assert.equal(layers[0].expansion, 1);
  assert.doesNotThrow(() => parseAnimation(encodeAnimationBinary(converted.document)));
  assert.deepEqual(converted.diagnostics, []);
});

test('mask stacks above one-pass budget become ordered nested coverage nodes without dropping tracks', () => {
  const shape = { v: [[0, 0], [20, 0], [20, 20], [0, 20]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 1, ip: 0, op: 30, sw: 80, sh: 80, sc: '#ffffff',
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      masksProperties: Array.from({ length: 9 }, () => ({
        mode: 'a', pt: { a: 0, k: shape },
        o: { a: 1, k: [{ t: 0, s: [100] }, { t: 30, s: [50] }] },
      })),
    }],
  });
  const nodeIds = new Set(converted.document.nodes.map(node => node.id));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_COMPOSITE_LIMIT'));
  const target = converted.document.nodes.find(node => node.id === 'layer:1');
  const nested = converted.document.nodes.filter(node => node.id.includes(':mask-stack:'));
  assert.equal(nested.length, 1);
  assert.equal(nested[0].composite.layers.length, 8);
  assert.equal(target.composite.layers.length, 2);
  assert.equal(converted.document.tracks.length, 9);
  assert.ok(converted.document.tracks.every(track => nodeIds.has(track.node)));
  assert.doesNotThrow(() => parseAnimation(encodeAnimationBinary(converted.document)));
});

test('animated mask expansion is a scalar composite track and survives binary round-trip', () => {
  const shape = { v: [[0, 0], [20, 0], [20, 20], [0, 20]], i: [], o: [], c: true };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 1, ip: 0, op: 30, sw: 80, sh: 80, sc: '#ffffff',
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      masksProperties: [{
        mode: 'a', pt: { a: 0, k: shape }, o: { a: 0, k: 100 },
        x: { a: 1, k: [{ t: 0, s: [-2] }, { t: 30, s: [6] }] },
      }],
    }],
  }, { strict: true });
  const layer = converted.document.nodes.find(node => node.id === 'layer:1').composite;
  assert.equal(layer.expansion, -2);
  assert.deepEqual(layer.expansionTrack.times, [0, 1]);
  assert.deepEqual(layer.expansionTrack.values, [-2, 6]);
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  const decodedComposite = decoded.nodes.find(node => node.id === 'layer:1').composite;
  const decodedLayer = 'layers' in decodedComposite ? decodedComposite.layers[0] : decodedComposite;
  assert.deepEqual(Array.from(decodedLayer.expansionTrack.values), [-2, 6]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_ANIMATED_MASK_EXPANSION'));
});

test('Lottie shape stack keeps multiple paints, animated paint tracks, gradients and dash strokes', () => {
  const shape = { v: [[0, 0], [40, 0], [40, 40], [0, 40]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 80, h: 80,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      shapes: [{
        ty: 'gr', it: [
          { ty: 'sh', nm: 'Painted path', ks: { a: 0, k: shape } },
          { ty: 'fl', r: 2, c: { a: 1, k: [{ t: 0, s: [1, 0, 0, 1] }, { t: 30, s: [0, 1, 0, 1] }] }, o: { a: 1, k: [{ t: 0, s: [100] }, { t: 30, s: [50] }] } },
          { ty: 'gf', r: 1, t: 1, g: { p: 2, k: { a: 0, k: [0, 1, 1, 0, 1, 0, 0, 1] } }, s: { a: 0, k: [0, 0] }, e: { a: 0, k: [40, 0] }, o: { a: 0, k: 80 } },
          { ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, o: { a: 0, k: 60 }, w: { a: 0, k: 4 }, lc: 2, lj: 2, d: [{ n: 'd', v: { a: 0, k: 6 } }, { n: 'g', v: { a: 0, k: 3 } }, { n: 'o', v: { a: 0, k: 1 } }] },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      }],
    }],
  }, { strict: true });
  const components = converted.document.nodes.find(node => node.name === 'Painted path').components;
  assert.equal(components.length, 3);
  assert.ok(components.every(component => component.type === 'org.haiyue.vector-shape@1'));
  assert.equal(components[0].fill.fillRule, undefined);
  assert.equal(components[0].fill.kind, 'solid');
  assert.equal(components[0].fill.opacity, 1);
  assert.deepEqual(components[0].fill.opacityTrack.values, [1, 0.5]);
  assert.equal(components[0].fillRule, 'evenodd');
  assert.equal(components[1].fill.kind, 'linear-gradient');
  assert.equal(components[1].fill.opacity, 0.8);
  assert.deepEqual(components[2].stroke.dash, [6, 3]);
  assert.equal(components[2].stroke.opacity, 0.6);
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  assert.equal(decoded.nodes.find(node => node.name === 'Painted path').components.length, 3);
  assert.deepEqual(converted.diagnostics, []);
});

test('Lottie converter preserves referenced hidden parents as transform-only nodes and nested matte chains', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const hiddenParentKs = {
    ...ks,
    p: { a: 0, k: [12, 18] },
    r: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [45] }] },
  };
  const source = {
    nm: 'Hidden parent graph', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      { ind: 1, ty: 1, nm: 'Matte', sw: 20, sh: 20, sc: '#ffffff', ip: 0, op: 30, ks },
      { ind: 2, ty: 1, nm: 'First target', sw: 20, sh: 20, sc: '#ff0000', ip: 0, op: 30, ks, tt: 1, tp: 1 },
      { ind: 3, ty: 1, nm: 'Nested target', sw: 20, sh: 20, sc: '#00ff00', ip: 0, op: 30, ks, tt: 1, tp: 2 },
      { ind: 4, ty: 3, nm: 'Hidden parent', parent: 7, hd: true, ip: 0, op: 30, ks: hiddenParentKs },
      { ind: 5, ty: 1, nm: 'Visible child', parent: 4, sw: 20, sh: 20, sc: '#0000ff', ip: 0, op: 30, ks },
      { ind: 6, ty: 4, nm: 'Unreferenced hidden visual', hd: true, ip: 0, op: 30, ks, shapes: [] },
      { ind: 7, ty: 3, nm: 'Hidden grandparent', hd: true, ip: 0, op: 30, ks },
    ],
  };
  const converted = convertLottie(source);
  const child = converted.document.nodes.find(node => node.id === 'layer:5');
  const hiddenParent = converted.document.nodes.find(node => node.id === 'layer:4');
  const nested = converted.document.nodes.find(node => node.id === 'layer:3');
  assert.equal(child.parent, 'layer:4');
  assert.equal(hiddenParent.parent, 'layer:7');
  assert.deepEqual(hiddenParent.transform.position, [12, 18]);
  assert.equal(hiddenParent.components, undefined);
  assert.ok(converted.document.tracks.some(track => track.node === 'layer:4' && track.property === 'rotation'));
  assert.equal(converted.document.nodes.some(node => node.id === 'layer:6'), false);
  assert.deepEqual(nested.composite, { kind: 'matte', source: 'layer:2', mode: 'alpha' });
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_MISSING_PARENT'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_NESTED_COMPOSITE'));
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie converter still diagnoses parent references absent from the source graph', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 1, parent: 99, sw: 20, sh: 20, sc: '#ffffff', ip: 0, op: 30, ks,
    }],
  });
  assert.equal(converted.document.nodes.find(node => node.id === 'layer:1').parent, undefined);
  assert.deepEqual(
    converted.diagnostics.filter(diagnostic => diagnostic.code === 'W_LOTTIE_MISSING_PARENT').map(diagnostic => diagnostic.path),
    ['$.layers[0].parent'],
  );
});

test('Lottie converter treats authored empty paths as valid no-op geometry', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const emptyPath = { ty: 'sh', ks: { a: 0, k: { v: [], i: [], o: [], c: false } } };
  const converted = convertLottie({
    nm: 'Authored empty placeholders', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      { ind: 1, ty: 4, ip: 0, op: 30, ks, shapes: [emptyPath] },
      {
        ind: 2, ty: 4, ip: 0, op: 30, ks,
        shapes: [emptyPath, { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }],
      },
    ],
  }, { strict: true });
  assert.equal(converted.document.nodes.filter(node => node.id === 'layer:1' || node.id === 'layer:2').length, 2);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_EMPTY_SHAPE'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_INVALID_PATH'));
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie converter preserves shape groups, primitive geometry tracks and static polystars', () => {
  const converted = convertLottie({
    nm: 'Shape fidelity', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 4, nm: 'Shapes', ip: 0, op: 30,
      ks: {
        a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
      shapes: [{
        ty: 'gr', nm: 'Moved group', it: [
          {
            ty: 'el', nm: 'Moving ellipse',
            s: { a: 1, k: [{ t: 0, s: [20, 10] }, { t: 30, s: [40, 30] }] },
            p: { a: 1, k: [{ t: 0, s: [10, 20] }, { t: 30, s: [50, 60] }] },
          },
          {
            ty: 'sr', sy: 1, nm: 'Star', d: 1,
            pt: { a: 0, k: 5 }, p: { a: 0, k: [40, 40] }, r: { a: 0, k: 15 },
            ir: { a: 0, k: 10 }, or: { a: 0, k: 20 }, is: { a: 0, k: 0 }, os: { a: 0, k: 0 },
          },
          { ty: 'fl', c: { a: 0, k: [0.2, 0.4, 0.8, 1] }, o: { a: 0, k: 80 } },
          {
            ty: 'tr', p: { a: 0, k: [3, 4] }, a: { a: 0, k: [1, 2] },
            s: { a: 0, k: [120, 80] }, r: { a: 0, k: 30 }, o: { a: 0, k: 90 },
            sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 },
          },
        ],
      }],
    }],
  }, { strict: true });
  const group = converted.document.nodes.find(node => node.name === 'Moved group');
  const ellipse = converted.document.nodes.find(node => node.name === 'Moving ellipse');
  const star = converted.document.nodes.find(node => node.name === 'Star');
  assert.deepEqual(group.transform.position, [3, 4]);
  assert.deepEqual(group.transform.anchor, [1, 2]);
  assert.deepEqual(group.transform.scale, [1.2, 0.8]);
  assert.equal(ellipse.parent, group.id);
  assert.deepEqual(ellipse.transform.position, [10, 20]);
  assert.equal(ellipse.components[0].type, 'path2d');
  assert.deepEqual(converted.document.tracks.filter(track => track.node === ellipse.id).map(track => track.property), ['position', 'scale']);
  assert.equal(star.parent, group.id);
  assert.equal(star.components[0].type, 'path2d');
  assert.equal(star.components[0].commands, 'MLLLLLLLLLZ');
  assert.equal(star.components[0].values.length, 20);
  assert.equal(converted.diagnostics.length, 0);
});

test('Lottie converter keeps static strokes compact in a versioned HYA extension', () => {
  const converted = convertLottie({
    nm: 'Stroke', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: {
        a: { a: 0, k: [0, 0] }, p: { a: 0, k: [50, 50] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
      shapes: [{
        ty: 'gr', it: [
          { ty: 'sh', nm: 'Open line', ks: { a: 0, k: {
            v: [[-20, -20], [0, 20], [20, -20]],
            i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]], c: false,
          } } },
          { ty: 'st', c: { a: 0, k: [0.1, 0.2, 0.3, 1] }, o: { a: 0, k: 80 }, w: { a: 0, k: 6 }, lc: 2, lj: 2 },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      }],
    }],
  }, { strict: true });
  const line = converted.document.nodes.find(node => node.name === 'Open line');
  assert.equal(line.components.length, 1, 'stroke contours should share one compact HYA component');
  assert.equal(line.components[0].type, 'org.haiyue.vector-stroke@1');
  assert.equal(line.components[0].color[3], 0.8);
  assert.equal(line.components[0].commands, 'MLL');
  assert.deepEqual(converted.document.extensionsUsed, ['org.haiyue.vector-stroke@1']);
  assert.deepEqual(converted.diagnostics, []);
});

test('Lottie converter accepts compact two-vertex paths and zero-to-positive primitive and stroke animation', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const twoVertexPath = {
    v: [[-10, 0], [10, 0]],
    i: [[0, -6], [0, 6]],
    o: [[0, 6], [0, -6]],
    c: true,
  };
  const converted = convertLottie({
    nm: 'Bodymovin normalization', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      {
        ind: 1, ty: 4, nm: 'Dynamic ellipse', ip: 0, op: 30, ks: transform,
        shapes: [
          {
            ty: 'el', nm: 'Growing ellipse', p: { a: 0, k: [20, 20] },
            s: { a: 1, k: [{ t: 0, s: [0, 0] }, { t: 30, s: [20, 10] }] },
          },
          { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } },
        ],
      },
      {
        ind: 2, ty: 4, nm: 'Dynamic stroke', ip: 0, op: 30, ks: transform,
        shapes: [
          { ty: 'sh', nm: 'Lens', ks: { a: 0, k: twoVertexPath } },
          {
            ty: 'st', c: { a: 0, k: [0, 0, 1, 1] }, o: { a: 0, k: 100 },
            w: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [4] }] }, lc: 2, lj: 2,
          },
        ],
      },
      {
        ind: 3, ty: 4, nm: 'Invisible stroke', ip: 0, op: 30, ks: transform,
        shapes: [
          { ty: 'sh', ks: { a: 0, k: { ...twoVertexPath, i: [], o: [] } } },
          { ty: 'fl', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 } },
          { ty: 'st', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 0 }, lc: 1, lj: 1 },
        ],
      },
    ],
  }, { strict: true });
  const ellipse = converted.document.nodes.find(node => node.name === 'Growing ellipse');
  const ellipseScale = converted.document.tracks.find(track => track.node === ellipse.id && track.property === 'scale');
  const lens = converted.document.nodes.find(node => node.name === 'Lens').components[0];
  assert.deepEqual(ellipseScale.values, [0, 0, 1, 1]);
  assert.equal(lens.type, 'org.haiyue.vector-shape@1');
  assert.equal(lens.stroke.width, 4);
  assert.deepEqual(lens.stroke.widthTrack.values, [0, 4]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_INVALID_PATH'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_INVALID_SHAPE_SIZE'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_INVALID_STROKE'));
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie converter evaluates static Merge Paths boolean geometry and diagnoses animated inputs', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const rectangle = (position, size = [20, 20]) => ({
    ty: 'rc', p: { a: 0, k: position }, s: { a: 0, k: size }, r: { a: 0, k: 0 },
  });
  const converted = convertLottie({
    nm: 'Static Merge Paths', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30, ks: transform,
      shapes: [{ ty: 'gr', nm: 'Intersection', it: [
        rectangle([0, 0]), rectangle([5, 0]),
        { ty: 'mm', mm: 4, nm: 'Intersect' },
        { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } },
        { ty: 'tr', ...transform },
      ] }],
    }],
  }, { strict: true });
  const component = converted.document.nodes.find(node => node.name === 'Intersect').components[0];
  const xs = component.values.filter((_value, index) => index % 2 === 0);
  const ys = component.values.filter((_value, index) => index % 2 === 1);
  assert.equal(Math.min(...xs), -5);
  assert.equal(Math.max(...xs), 10);
  assert.equal(Math.min(...ys), -10);
  assert.equal(Math.max(...ys), 10);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_UNSUPPORTED_SHAPE'));
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));

  const animated = convertLottie({
    nm: 'Animated Merge Paths', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{ ind: 1, ty: 4, ip: 0, op: 30, ks: transform, shapes: [
      {
        ty: 'rc', p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 },
        s: { a: 1, k: [{ t: 0, s: [10, 10] }, { t: 30, s: [20, 20] }] },
      },
      rectangle([5, 0]),
      { ty: 'mm', mm: 2 },
      { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } },
    ] }],
  });
  assert.ok(animated.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_ANIMATED_MERGE_PATH'));
  assert.ok(!animated.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_UNSUPPORTED_SHAPE'));
});

test('animated Merge Paths mode 1 bakes independent path easings into one stable compound morph', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const shape = offset => ({
    v: [[offset, 0], [offset + 10, 0], [offset + 10, 10], [offset, 10]],
    i: [], o: [], c: true,
  });
  const animatedPath = (offset, times) => ({
    ty: 'sh', ks: { a: 1, k: times.map((time, index) => ({
      t: time, s: [shape(offset + index * 2)],
      o: { x: 0.2, y: 0 }, i: { x: 0.8, y: 1 },
    })) },
  });
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{ ind: 1, ty: 4, ip: 0, op: 30, ks: transform, shapes: [{ ty: 'gr', it: [
      animatedPath(0, [0, 15, 30]), animatedPath(20, [0, 10, 30]),
      { ty: 'mm', mm: 1, nm: 'Animated compound' },
      { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } },
      { ty: 'tr', ...transform },
    ] }] }],
  }, { strict: true });
  const component = converted.document.nodes.find(node => node.name === 'Animated compound').components[0];
  assert.equal(component.type, 'org.haiyue.vector-shape@1');
  assert.equal(component.commands.match(/M/g).length, 2);
  assert.equal(component.morph.interpolation, 'linear');
  assert.ok(component.morph.times.length >= 31);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_ANIMATED_MERGE_PATH'));
  assert.doesNotThrow(() => parseAnimation(encodeAnimationBinary(converted.document)));
});

test('Lottie converter maps static text and audio layers without a player dependency', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    nm: 'Media', fr: 30, ip: 0, op: 60, w: 320, h: 180,
    assets: [{ id: 'sound', p: 'sound.ogg', u: 'assets/' }],
    layers: [
      { ind: 1, ty: 5, nm: 'Title', ip: 0, op: 60, ks, t: { d: { k: [{ s: {
        t: 'Hello', s: 28, f: 'Inter', lh: 34, j: 2, fc: [0.2, 0.4, 0.8], sz: [180, 48],
      } }] } } },
      { ind: 2, ty: 6, nm: 'Sound', refId: 'sound', ip: 0, op: 60, ks },
    ],
  }, { imageBaseUrl: '/motion/' });
  const text = converted.document.nodes.find(node => node.id === 'layer:1').components[0];
  const audio = converted.document.nodes.find(node => node.id === 'layer:2').components[0];
  assert.equal(text.type, 'text2d');
  assert.equal(text.text, 'Hello');
  assert.deepEqual(text.size, [180, 48]);
  assert.deepEqual(audio, { type: 'audio', resource: 'sound', volume: 1, loop: false });
  assert.deepEqual(converted.document.resources[0], { id: 'sound', type: 'audio', uri: '/motion/assets/sound.ogg' });
  assert.equal(converted.convertedLayerCount, 2);
});

test('Lottie animated text keeps font resources, document keys and deterministic character selectors', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    nm: 'Animated title', fr: 30, ip: 0, op: 60, w: 320, h: 180,
    fonts: { list: [{ fName: 'Inter-Regular', fFamily: 'Inter', fStyle: 'Regular' }] },
    layers: [{ ind: 1, ty: 5, nm: 'Title', ip: 0, op: 60, ks, t: {
      d: { k: [
        { t: 0, s: { t: 'READY', s: 30, f: 'Inter-Regular', lh: 36, tr: 40, j: 2, fc: [1, 0, 0], sz: [220, 60] } },
        { t: 30, s: { t: 'GO!', s: 34, f: 'Inter-Regular', lh: 40, tr: 20, j: 2, fc: [0, 1, 0], sz: [220, 60] } },
      ] },
      a: [{
        s: {
          t: 0, b: 3, rn: 1, r: 1,
          s: { a: 0, k: 0 }, e: { a: 0, k: 100 }, o: { a: 0, k: 0 }, a: { a: 0, k: 100 },
          sh: 3, ne: { a: 0, k: -50 }, xe: { a: 0, k: 25 }, sm: { a: 0, k: 50 },
        },
        a: {
          p: { a: 0, k: [0, -12] },
          o: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [100] }] },
          fc: { a: 0, k: [0.2, 0.6, 1] },
        },
      }],
    } }],
  }, { fonts: { 'Inter-Regular': { uri: '/fonts/inter.woff2', integrity: 'sha256-test' } }, strict: true });
  const text = converted.document.nodes[0].components[0];
  assert.equal(text.fontResource, 'font:Inter-Regular');
  assert.equal(text.tracking, 1.2);
  assert.deepEqual(text.documents.map(({ time, text }) => ({ time, text })), [
    { time: 0, text: 'READY' }, { time: 1, text: 'GO!' },
  ]);
  assert.equal(text.animators[0].selector.shape, 'ramp-down');
  assert.equal(text.animators[0].selector.basedOn, 'words');
  assert.deepEqual(text.animators[0].selector.easing, [0, 0.5, 0.75, 1]);
  assert.equal(text.animators[0].selector.smoothness, 0.5);
  assert.equal(Number.isSafeInteger(text.animators[0].selector.randomSeed), true);
  assert.deepEqual(text.animators[0].position, [0, -12]);
  assert.deepEqual(text.animators[0].opacityTrack.values, [0, 1]);
  assert.deepEqual(converted.document.resources, [{
    id: 'font:Inter-Regular', type: 'binary', uri: '/fonts/inter.woff2', mimeType: 'font/woff2', integrity: 'sha256-test',
  }]);
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  assert.equal(decoded.nodes[0].components[0].documents[1].text, 'GO!');
  assert.deepEqual(decoded.nodes[0].components[0].animators[0].selector, text.animators[0].selector);
  assert.deepEqual(Array.from(decoded.nodes[0].components[0].animators[0].opacityTrack.values), [0, 1]);
});

test('Lottie data layers lower text expressions to verified HYA IR without retaining source code', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    nm: 'Data driven title', fr: 30, ip: 0, op: 60, w: 320, h: 180,
    assets: [{ id: 'weather', t: 3, u: 'data/', p: 'weather.json' }],
    layers: [
      { ind: 1, ty: 15, nm: 'weather.json', refId: 'weather', ip: 0, op: 60, ks },
      { ind: 2, ty: 5, nm: 'Temperature', ip: 0, op: 60, ks, t: {
        d: {
          x: 'var data = thisComp.layer("weather.json").sourceData; $bm_rt = data.temp;',
          k: [{ s: { t: '18°', s: 28, f: 'sans-serif', fc: [1, 1, 1], sz: [120, 48] } }],
        },
      } },
    ],
  }, { imageBaseUrl: '/motion/' });
  assert.deepEqual(converted.document.resources[0], {
    id: 'weather', type: 'binary', uri: '/motion/data/weather.json', mimeType: 'application/json',
  });
  const dataNode = converted.document.nodes.find(node => node.id === 'layer:1');
  assert.deepEqual(dataNode.extensions['org.haiyue.data-layer@1'], {
    resource: 'weather', mediaType: 'application/json',
  });
  assert.ok(converted.document.extensionsUsed.includes('org.haiyue.data-layer@1'));
  assert.equal(converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_UNSUPPORTED_LAYER'), false);
  assert.equal(converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_TEXT_EXPRESSION'), false);
  const expression = converted.document.nodes.find(node => node.id === 'layer:2').components[0].expression;
  assert.equal(evaluateSafeExpression(expression, { time: 0, text: '18°', data: { weather: { temp: 21 } } }), '21');
  assert.equal(JSON.stringify(expression).includes('thisComp'), false);
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  assert.deepEqual(decoded.nodes.find(node => node.id === 'layer:1').extensions, dataNode.extensions);
  assert.equal(evaluateSafeExpression(decoded.nodes.find(node => node.id === 'layer:2').components[0].expression, {
    time: 0, text: '18°', data: { weather: { temp: 22 } },
  }), '22');
});

test('Lottie text expression compiler supports bounded math, formatting and Bodymovin data selectors', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const expression = "var $bm_rt; $bm_rt = $bm_sum((thisComp.layer('weather.json')('Data')('Outline')('current')('feels_like') - 273.15).toFixed(2), ' \\xB0C');";
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 320, h: 180,
    assets: [{ id: 'weather', t: 3, p: 'weather.json' }],
    layers: [
      { ind: 1, ty: 15, nm: 'weather.json', refId: 'weather', ip: 0, op: 30, ks },
      { ind: 2, ty: 5, ip: 0, op: 30, ks, t: { d: {
        x: expression,
        k: [{ s: { t: 'fallback', s: 24, fc: [1, 1, 1], sz: [200, 40] } }],
      } } },
    ],
  }, { strict: true });
  const program = converted.document.nodes.find(node => node.id === 'layer:2').components[0].expression;
  assert.equal(evaluateSafeExpression(program, {
    time: 0,
    text: 'fallback',
    data: { weather: { current: { feels_like: 291.14 } } },
  }), '17.99 °C');
  const conditionalDocument = convertLottie({
    fr: 30, ip: 0, op: 60, w: 100, h: 40,
    layers: [{ ind: 1, ty: 5, ip: 0, op: 60, ks, t: { d: {
      x: '$bm_rt = time < 1 ? "early" : "late";',
      k: [{ s: { t: 'fallback', s: 20, fc: [1, 1, 1], sz: [100, 30] } }],
    } } }],
  }, { strict: true }).document;
  const conditional = conditionalDocument.nodes[0].components[0].expression;
  assert.equal(evaluateSafeExpression(conditional, { time: 0.5, text: 'fallback' }), 'early');
  assert.equal(evaluateSafeExpression(conditional, { time: 1.5, text: 'fallback' }), 'late');
  const decodedConditional = parseAnimation(encodeAnimationBinary(conditionalDocument)).nodes[0].components[0].expression;
  assert.equal(evaluateSafeExpression(decodedConditional, { time: 0.5, text: 'fallback' }), 'early');
});

test('Lottie text expression compiler rejects host access and preserves the authored fallback', () => {
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 100, h: 50,
    layers: [{ ind: 1, ty: 5, ip: 0, op: 30, t: { d: {
      x: '$bm_rt = globalThis.fetch("https://example.com");',
      k: [{ s: { t: 'safe fallback', s: 20, f: 'sans-serif', fc: [1, 1, 1], sz: [100, 30] } }],
    } } }],
  });
  const text = converted.document.nodes[0].components[0];
  assert.equal(text.text, 'safe fallback');
  assert.equal(text.expression, undefined);
  assert.match(converted.diagnostics.find(diagnostic => diagnostic.code === 'W_LOTTIE_TEXT_EXPRESSION').message, /not available|Unknown/);
});

test('HYA safe expression verifier rejects unknown opcodes, stack underflow and missing data resources', () => {
  const base = {
    format: ANIMATION_FORMAT, version: ANIMATION_VERSION,
    canvas: { width: 100, height: 50, coordinateSystem: 'screen-y-down' }, duration: 1,
    nodes: [{ id: 'text', components: [{
      type: 'text2d', text: 'fallback', size: [100, 30], color: [1, 1, 1, 1],
      expression: { version: 1, result: 'text', localCount: 0, instructions: [{ op: 'return' }] },
    }] }],
  };
  assert.throws(() => parseAnimation(base), error => error.path.endsWith('.expression.instructions[0]'));
  const missingData = structuredClone(base);
  missingData.nodes[0].components[0].expression.instructions = [
    { op: 'data', resource: 'missing', path: ['value'] }, { op: 'return' },
  ];
  assert.throws(() => parseAnimation(missingData), error => /missing data resource/.test(error.message));
  const unknown = structuredClone(base);
  unknown.nodes[0].components[0].expression.instructions = [{ op: 'eval', source: 'globalThis' }, { op: 'return' }];
  assert.throws(() => parseAnimation(unknown), error => /Unknown safe expression opcode/.test(error.message));
  const bomb = structuredClone(base);
  bomb.nodes[0].components[0].expression.instructions = Array.from({ length: 257 }, () => ({ op: 'constant', value: 1 }));
  assert.throws(() => parseAnimation(bomb), error => /1–256 instructions/.test(error.message));
  const prototypePath = structuredClone(base);
  prototypePath.resources = [{ id: 'data', type: 'binary', uri: 'data.json', mimeType: 'application/json' }];
  prototypePath.nodes[0].components[0].expression.instructions = [
    { op: 'data', resource: 'data', path: ['__proto__'] }, { op: 'return' },
  ];
  assert.throws(() => parseAnimation(prototypePath), error => /invalid or unsafe/.test(error.message));
});

test('Lottie font inventory records substitutions, content hashes and measured metrics', () => {
  const source = {
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    fonts: { list: [{ fName: 'Brand-Bold', fFamily: 'Brand', fStyle: 'Bold', ascent: 72.5 }] },
    layers: [{ ty: 5, t: { d: { k: [{ s: { t: 'Brand', f: 'Brand-Bold' } }, { s: { t: 'Again', f: 'Brand-Bold' } }] } } }],
  };
  const fonts = inspectLottieFonts(source, {
    'Brand-Bold': {
      uri: '/fonts/brand.woff2', family: 'Brand Web', integrity: 'sha256-brand',
      metrics: { unitsPerEm: 1000, ascent: 725, descent: -210, lineGap: 20 },
    },
  });
  assert.deepEqual(fonts, [{
    name: 'Brand-Bold', authoredFamily: 'Brand', authoredStyle: 'Bold', authoredAscent: 72.5,
    usageCount: 2, mapped: true, resolvedFamily: 'Brand Web', resolvedStyle: 'normal', resolvedWeight: 700,
    uri: '/fonts/brand.woff2', mimeType: 'font/woff2', integrity: 'sha256-brand',
    metrics: { unitsPerEm: 1000, ascent: 725, descent: -210, lineGap: 20 },
  }]);
});

test('Lottie system-font fallback preserves weight and style inferred from source font metadata', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    fonts: { list: [{ fName: 'FuturaPT-DemiItalic', fFamily: 'Futura PT', fStyle: 'Demi Italic' }] },
    layers: [{ ind: 1, ty: 5, ip: 0, op: 30, ks, t: { d: { k: [{ s: {
      t: 'Fallback', s: 20, f: 'FuturaPT-DemiItalic', fc: [1, 1, 1], sz: [100, 30],
    } }] } } }],
  };
  const fonts = inspectLottieFonts(source);
  const converted = convertLottie(source);
  const text = converted.document.nodes[0].components[0];
  assert.equal(fonts[0].resolvedWeight, 600);
  assert.equal(fonts[0].resolvedStyle, 'italic');
  assert.equal(text.fontFamily, 'Futura PT');
  assert.equal(text.fontWeight, 600);
  assert.equal(text.fontStyle, 'italic');
  assert.equal(text.fontResource, undefined);
  assert.match(
    converted.diagnostics.find(diagnostic => diagnostic.code === 'W_LOTTIE_FONT_SUBSTITUTION').message,
    /original family, style and weight.*system fallback/,
  );
});

test('Lottie converter expands nested precomps with parent opacity, time windows, start time and stretch', () => {
  const transform = (opacity, position = [0, 0]) => ({
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: position },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: opacity },
  });
  const converted = convertLottie({
    nm: 'Nested precomp', fr: 30, ip: 0, op: 60, w: 100, h: 100,
    assets: [
      {
        id: 'inner', fr: 30, w: 100, h: 100,
        layers: [{
          ind: 1, ty: 1, nm: 'Nested solid', sw: 20, sh: 20, sc: '#3366cc', ip: 0, op: 15,
          ks: {
            ...transform(100),
            p: { a: 1, k: [{ t: 0, s: [10, 10] }, { t: 15, s: [30, 10] }] },
          },
        }],
      },
      {
        id: 'outer', fr: 30, w: 100, h: 100,
        layers: [
          { ind: 1, ty: 3, nm: 'Parent null', ip: 0, op: 60, ks: transform(80, [5, 6]) },
          {
            ind: 2, ty: 0, nm: 'Inner instance', refId: 'inner', parent: 1,
            ip: 15, op: 60, st: 15, sr: 2, ks: transform(50),
          },
        ],
      },
    ],
    layers: [{ ind: 1, ty: 0, nm: 'Outer instance', refId: 'outer', ip: 0, op: 60, st: 0, sr: 1, ks: transform(50) }],
  }, { strict: true });
  const outer = converted.document.nodes.find(node => node.id === 'layer:1');
  const parent = converted.document.nodes.find(node => node.name === 'Parent null');
  const inner = converted.document.nodes.find(node => node.name === 'Inner instance');
  const solid = converted.document.nodes.find(node => node.name === 'Nested solid');
  assert.equal(parent.parent, outer.id);
  assert.equal(inner.parent, parent.id);
  assert.equal(solid.parent, inner.id);
  assert.equal(outer.transform.opacity, 0.5);
  assert.equal(parent.transform.opacity, 0.8);
  assert.equal(inner.transform.opacity, 0.5);
  assert.equal(inner.start, 0.5);
  assert.equal(inner.duration, 1.5);
  assert.equal(solid.start, 0.5);
  assert.equal(solid.duration, 1);
  const position = converted.document.tracks.find(track => track.node === solid.id && track.property === 'position');
  assert.deepEqual(position.times, [0.5, 1.5]);
  assert.deepEqual(converted.diagnostics, []);
  assert.equal(converted.skippedLayerCount, 0);
});

test('ordinary layer time stretch remaps transform, text and composite tracks through one local timeline', () => {
  const shape = { v: [[0, 0], [20, 0], [20, 20], [0, 20]], i: [], o: [], c: true };
  const converted = convertLottie({
    fr: 10, ip: 0, op: 40, w: 100, h: 100,
    layers: [{
      ind: 1, ty: 5, ip: 10, op: 40, st: 10, sr: 2,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 1, k: [{ t: 10, s: [0, 0] }, { t: 20, s: [10, 0] }] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
      t: { d: { k: [
        { t: 10, s: { t: 'A', f: 'sans-serif', s: 20, sz: [50, 30] } },
        { t: 20, s: { t: 'B', f: 'sans-serif', s: 20, sz: [50, 30] } },
      ] } },
      masksProperties: [{
        mode: 'a', pt: { a: 0, k: shape }, o: { a: 0, k: 100 },
        x: { a: 1, k: [{ t: 10, s: [0] }, { t: 20, s: [4] }] },
      }],
    }],
  });
  const position = converted.document.tracks.find(track => track.property === 'position');
  const node = converted.document.nodes.find(candidate => candidate.id === 'layer:1');
  assert.deepEqual(position.times, [1, 3]);
  assert.deepEqual(node.components[0].documents.map(document => document.time), [1, 3]);
  assert.deepEqual(node.composite.expansionTrack.times, [1, 3]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_TIME_STRETCH'));
});

test('Lottie precomp uses its local canvas for media and discovers nested audio resources', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    nm: 'Precomp media', fr: 30, ip: 0, op: 30, w: 200, h: 100,
    assets: [
      { id: 'image', p: 'data:image/png;base64,AA==' },
      { id: 'sound', p: 'data:audio/ogg;base64,AA==' },
      {
        id: 'nested', fr: 30, w: 80, h: 40,
        layers: [
          { ind: 1, ty: 2, nm: 'Nested image', refId: 'image', ip: 0, op: 30, ks: transform },
          { ind: 2, ty: 6, nm: 'Nested audio', refId: 'sound', ip: 0, op: 30, ks: transform },
        ],
      },
    ],
    layers: [{ ind: 1, ty: 0, nm: 'Nested media', refId: 'nested', ip: 0, op: 30, st: 0, sr: 1, ks: transform }],
  }, { strict: true });
  const image = converted.document.nodes.find(node => node.name === 'Nested image');
  const audio = converted.document.nodes.find(node => node.name === 'Nested audio');
  assert.deepEqual(image.components[0].size, [80, 40]);
  assert.equal(audio.components[0].type, 'audio');
  assert.equal(converted.document.resources.find(resource => resource.id === 'sound').type, 'audio');
  assert.deepEqual(converted.diagnostics, []);
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie converter recognizes legacy keyframe arrays when the animated flag is omitted', () => {
  const pathStart = {
    v: [[0, 0], [20, 0], [20, 20], [0, 20]],
    i: [[0, 0], [0, 0], [0, 0], [0, 0]],
    o: [[0, 0], [0, 0], [0, 0], [0, 0]],
    c: true,
  };
  const pathEnd = { ...pathStart, v: [[5.12345, 0], [25.12345, 0], [25.12345, 20], [5.12345, 20]] };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 40, h: 40,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { k: [{ t: 0, s: [0, 0], e: [10, 0] }, { t: 30, s: [10, 0] }] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
      shapes: [{
        ty: 'sh',
        ks: { k: [{ t: 0, s: [pathStart], e: [pathEnd] }, { t: 30, s: [pathEnd] }] },
      }, {
        ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 },
      }],
    }],
  });
  const pathNode = converted.document.nodes.find(node => node.components?.[0]?.type === 'org.haiyue.vector-shape@1');
  const position = converted.document.tracks.find(track => track.node === 'layer:1' && track.property === 'position');
  assert.equal(pathNode.components[0].commands, 'MCCCCZ');
  assert.deepEqual(pathNode.components[0].morph.times, [0, 1]);
  assert.equal(pathNode.components[0].morph.values.length, pathNode.components[0].morph.valueSize * 2);
  assert.equal(pathNode.components[0].morphRelative, true);
  const firstEndDelta = pathNode.components[0].morph.values[pathNode.components[0].morph.valueSize];
  assert.equal(firstEndDelta, 5.125);
  assert.ok(Math.abs(firstEndDelta - 5.12345) <= 1 / 128, 'animated path quantization must remain sub-pixel bounded');
  assert.deepEqual(position.times, [0, 1]);
  assert.ok(converted.document.extensionsUsed.includes('org.haiyue.vector-shape@1'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_ANIMATED_PATH'));
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_INVALID_PATH'));
  const decoded = parseAnimation(encodeAnimationBinary(converted.document));
  assert.equal(decoded.nodes.find(node => node.id === pathNode.id).components[0].type, 'org.haiyue.vector-shape@1');
});

test('animated path time keys are de-duplicated after Float32 storage conversion', () => {
  const shape = {
    v: [[0, 0], [20, 0], [20, 20]], i: [[0, 0], [0, 0], [0, 0]],
    o: [[0, 0], [0, 0], [0, 0]], c: true,
  };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 40, h: 40,
    layers: [{
      ind: 1, ty: 4, ip: 0, op: 30,
      ks: { a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      shapes: [
        { ty: 'sh', ks: { a: 1, k: [
          { t: 0, s: [shape] },
          { t: 29.9999999, s: [{ ...shape, v: [[1, 0], [21, 0], [20, 20]] }] },
          { t: 30, s: [{ ...shape, v: [[2, 0], [22, 0], [20, 20]] }] },
        ] } },
        { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } },
      ],
    }],
  });
  const morph = converted.document.nodes.find(node => node.components?.[0]?.type === 'org.haiyue.vector-shape@1').components[0].morph;
  assert.deepEqual(morph.times, [0, 1]);
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie converter preserves animated mask opacity as a real track', () => {
  const shape = {
    v: [[0, 0], [20, 0], [20, 20], [0, 20]],
    i: [[0, 0], [0, 0], [0, 0], [0, 0]],
    o: [[0, 0], [0, 0], [0, 0], [0, 0]],
    c: true,
  };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 40, h: 40,
    layers: [{
      ind: 1, ty: 1, ip: 0, op: 30, sw: 40, sh: 40, sc: '#ffffff',
      ks: {
        a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
      masksProperties: [{
        mode: 'a',
        pt: { a: 1, k: [
          { t: 0, s: [shape], e: [{ ...shape, v: [[5, 0], [25, 0], [25, 20], [5, 20]] }] },
          { t: 30, s: [{ ...shape, v: [[5, 0], [25, 0], [25, 20], [5, 20]] }] },
        ] },
        o: { a: 1, k: [{ t: 0, s: [0], e: [100] }, { t: 30, s: [100] }] },
      }],
    }],
  });
  const target = converted.document.nodes.find(node => node.id === 'layer:1');
  const source = converted.document.nodes.find(node => node.id === target.composite.source);
  const maskNode = converted.document.nodes.find(node => node.parent === source.id);
  const opacity = converted.document.tracks.find(track => track.node === maskNode.id && track.property === 'opacity');
  assert.equal(maskNode.components[0].type, 'org.haiyue.vector-path-morph@1');
  assert.deepEqual(opacity.times, [0, 1]);
  assert.deepEqual(opacity.values, [0, 1]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_ANIMATED_MASK_OPACITY'));
  assert.doesNotThrow(() => encodeAnimationBinary(converted.document));
});

test('Lottie precomp keeps unsupported time remap and effects on their exact source paths', () => {
  const ks = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 20, h: 20,
    assets: [{ id: 'nested', fr: 30, w: 20, h: 20, layers: [] }],
    layers: [{ ind: 1, ty: 0, refId: 'nested', ip: 0, op: 30, st: 0, sr: 1, ks, tm: { a: 0, k: 0 }, ef: [{ ty: 5 }] }],
  });
  assert.deepEqual(converted.diagnostics.map(({ code, path }) => ({ code, path })), [
    { code: 'W_LOTTIE_EFFECT', path: '$.layers[0].ef[0]' },
    { code: 'W_LOTTIE_TIME_REMAP', path: '$.layers[0].tm' },
  ]);
  assert.ok(!converted.diagnostics.some(diagnostic => diagnostic.code === 'W_LOTTIE_UNSUPPORTED_LAYER'));
});

test('Lottie converter preserves static and animated Tint in the source-neutral effect stack', () => {
  const base = {
    ind: 1, ty: 1, ip: 0, op: 30, sw: 20, sh: 20, sc: '#ff0000',
    ks: {
      a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
      r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
    },
  };
  const tint = {
    ty: 5, nm: 'Tint', ef: [
      { nm: 'Map Black To', v: { a: 0, k: [0, 0, 1, 1] } },
      { nm: 'Map White To', v: { a: 0, k: [1, 1, 0, 1] } },
      { nm: 'Amount to Tint', v: { a: 0, k: 100 } },
    ],
  };
  const converted = convertLottie({ fr: 30, ip: 0, op: 30, w: 20, h: 20, layers: [{ ...base, ef: [tint] }] });
  assert.deepEqual(converted.document.nodes[0].effects, [{
    kind: 'tint', black: [0, 0, 1], white: [1, 1, 0], amount: 1,
  }]);
  assert.deepEqual(converted.diagnostics, []);
  assert.deepEqual(parseAnimation(encodeAnimationBinary(converted.document)).nodes[0].effects[0], converted.document.nodes[0].effects[0]);

  const animated = convertLottie({
    fr: 30, ip: 0, op: 30, w: 20, h: 20,
    layers: [{ ...base, ef: [{ ...tint, ef: [
      ...tint.ef.slice(0, 2),
      { nm: 'Amount to Tint', v: { a: 1, k: [{ t: 0, s: [0] }, { t: 30, s: [100] }] } },
    ] }] }],
  });
  assert.deepEqual(animated.diagnostics, []);
  assert.deepEqual(animated.document.nodes[0].effects[0].amountTrack.times, [0, 1]);
  assert.deepEqual(animated.document.nodes[0].effects[0].amountTrack.values, [0, 1]);
  assert.doesNotThrow(() => encodeAnimationBinary(animated.document));
});

test('Lottie converter bakes monotonic legacy time remap into ordinary HYA track times', () => {
  const staticTransform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const converted = convertLottie({
    fr: 30, ip: 0, op: 30, w: 20, h: 20,
    assets: [{
      id: 'nested', fr: 30, w: 20, h: 20,
      layers: [{
        ind: 1, ty: 1, sw: 10, sh: 10, sc: '#ffffff', ip: 0, op: 30,
        ks: {
          ...staticTransform,
          p: { a: 1, k: [{ t: 0, s: [0, 0], e: [10, 0] }, { t: 30, s: [10, 0] }] },
        },
      }],
    }],
    layers: [{
      ind: 1, ty: 0, refId: 'nested', ip: 0, op: 30, st: 0, sr: 1, ks: staticTransform,
      tm: {
        // Legacy Bodymovin form deliberately omits `a: 1`.
        k: [
          { t: 0, s: [0], e: [1], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
          { t: 15, s: [1] },
        ],
      },
    }],
  }, { strict: true });
  const nested = converted.document.nodes.find(node => node.id === 'layer:1/layer:1');
  const position = converted.document.tracks.find(track => track.node === nested.id && track.property === 'position');
  assert.ok(Math.abs(position.times[0] - 0) < 1e-6);
  assert.ok(Math.abs(position.times[1] - 0.5) < 1e-5);
  assert.deepEqual(converted.diagnostics, []);
});
