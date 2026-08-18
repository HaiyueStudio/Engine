import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANIMATION_FORMAT,
  ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
  ANIMATION_VERSION,
  encodeAnimationBinary,
  parseAnimation,
} from '../dist/index.js';
import { convertLottie } from '../dist/lottie.js';

const samplesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const manifest = JSON.parse(await readFile(resolve(samplesDirectory, 'manifest.json'), 'utf8'));
const documents = new Map(createDocuments().map(document => [document.extensions?.['org.haiyue.sample@1']?.id, document]));

await mkdir(samplesDirectory, { recursive: true });
for (const entry of manifest.entries) {
  const document = documents.get(entry.id);
  if (!document) throw new Error(`Missing source document for HYA sample ${entry.id}.`);
  const binary = encodeAnimationBinary(document);
  const parsed = parseAnimation(binary);
  if (parsed.source !== 'binary') throw new Error(`Generated sample ${entry.id} did not round-trip as binary HYA.`);
  await writeFile(resolve(samplesDirectory, entry.file), new Uint8Array(binary));
  console.log(`[hya:samples] ${entry.id.padEnd(24)} ${String(binary.byteLength).padStart(6)} B`);
}

function createDocuments() {
  return [
    sample('transform-position', 'Position Keyframes', {
      nodes: [
        backdrop(),
        {
          id: 'ball',
          transform: { position: [120, 180] },
          components: [{ type: 'shape2d', shape: 'ellipse', size: [72, 72], fill: [0.2, 0.95, 0.72, 1] }],
        },
      ],
      tracks: [{
        node: 'ball', property: 'position', interpolation: 'linear',
        times: [0, 0.75, 1.5, 2.25, 3],
        values: [120, 180, 320, 90, 520, 180, 320, 270, 120, 180],
      }],
    }),
    sample('transform-hierarchy', 'Hierarchy Transform', {
      nodes: [
        backdrop(),
        {
          id: 'orbit', transform: { position: [320, 180] },
          components: [{ type: 'shape2d', shape: 'ellipse', size: [34, 34], fill: [1, 0.78, 0.18, 1] }],
        },
        {
          id: 'arm', parent: 'orbit', transform: { position: [120, 0] },
          components: [{ type: 'shape2d', shape: 'rect', size: [180, 12], position: [-90, 0], fill: [0.22, 0.5, 0.78, 0.45] }],
        },
        {
          id: 'satellite', parent: 'arm', transform: { position: [0, 0] },
          components: [{ type: 'shape2d', shape: 'rect', size: [58, 58], fill: [0.38, 0.86, 1, 1] }],
        },
      ],
      tracks: [
        { node: 'orbit', property: 'rotation', interpolation: 'linear', times: [0, 3], values: [0, Math.PI * 2] },
        { node: 'arm', property: 'scale', interpolation: 'cubic-bezier', times: [0, 1.5, 3], values: [0.72, 0.72, 1.15, 1.15, 0.72, 0.72], easings: [0.3, 0, 0.2, 1, 0.3, 0, 0.2, 1] },
      ],
    }),
    sample('spatial-bezier', 'Spatial Bezier', {
      nodes: [
        backdrop(),
        {
          id: 'comet', transform: { position: [110, 245] },
          components: [{ type: 'shape2d', shape: 'ellipse', size: [54, 54], fill: [1, 0.35, 0.48, 1] }],
        },
      ],
      tracks: [{
        node: 'comet', property: 'position', interpolation: 'cubic-bezier',
        times: [0, 1.5, 3], values: [110, 245, 320, 100, 530, 245],
        easings: [0.42, 0, 0.58, 1, 0.42, 0, 0.58, 1],
        spatialTangents: [130, -180, -130, 90, 130, 90, -130, -180],
      }],
    }),
    sample('sprite-sheet-coin', 'Spritesheet Coin', {
      duration: 25 / 12,
      frameRate: 12,
      resources: [{
        id: 'coin-atlas', type: 'image', uri: 'assets/sprite1.png',
        width: 1020, height: 1020, mimeType: 'image/png', colorSpace: 'srgb',
      }],
      nodes: [
        backdrop(),
        {
          id: 'coin',
          transform: { position: [320, 180] },
          components: [{
            type: 'sprite2d', resource: 'coin-atlas', size: [286, 286],
            uvRectTrack: spriteSheetTrack(5, 5, 12),
          }],
        },
      ],
      tracks: [],
    }),
    sample('projected-wire-cube', 'Projected Wire Cube', projectedWireCube()),
    sample('depth-tunnel', 'Depth Tunnel', depthTunnel()),
    sample('perspective-card-flip', 'Perspective Card Flip', perspectiveCardFlip()),
    lottiePrecompLayersSample(),
    sample('vector-gradient', 'Vector Gradient', {
      extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID],
      nodes: [
        backdrop(),
        {
          id: 'diamond', transform: { position: [320, 180] },
          components: [{
            type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
            commands: 'MLLLZ',
            values: [0, -105, 135, 0, 0, 105, -135, 0],
            fill: {
              kind: 'linear-gradient', start: [-135, -90], end: [135, 90],
              stops: [0, 0.12, 0.95, 0.75, 1, 0.5, 0.25, 0.5, 1, 1, 1, 0.98, 0.2, 0.45, 1],
              startTrack: { times: [0, 3], values: [-135, -90, 135, -90], valueSize: 2, interpolation: 'linear' },
              endTrack: { times: [0, 3], values: [135, 90, -135, 90], valueSize: 2, interpolation: 'linear' },
            },
          }],
        },
      ],
      tracks: [{ node: 'diamond', property: 'rotation', interpolation: 'linear', times: [0, 3], values: [0, Math.PI * 2] }],
    }),
    sample('vector-trim-path', 'Trim Path', {
      extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID],
      nodes: [
        backdrop(),
        {
          id: 'loop', transform: { position: [320, 180] },
          components: [{
            type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
            commands: 'MCCCCZ',
            values: [0, -105, 78, -105, 125, -58, 125, 0, 125, 58, 78, 105, 0, 105, -78, 105, -125, 58, -125, 0, -125, -58, -78, -105, 0, -105],
            stroke: { color: [0.28, 0.88, 1, 1], width: 18, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
            modifiers: [{
              kind: 'trim-path', start: 0, end: 0.12, offset: 0, mode: 'simultaneous',
              endTrack: { times: [0, 1.4, 3], values: [0.12, 1, 0.12], valueSize: 1, interpolation: 'cubic-bezier', easings: [0.4, 0, 0.2, 1, 0.4, 0, 0.2, 1] },
              offsetTrack: { times: [0, 3], values: [0, 1], valueSize: 1, interpolation: 'linear' },
            }],
          }],
        },
      ],
    }),
    sample('vector-path-morph', 'Path Morph', {
      extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID],
      nodes: [
        backdrop(),
        {
          id: 'morph', transform: { position: [320, 180] },
          components: [{
            type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
            commands: 'MLLLZ',
            values: [-110, -80, 110, -80, 110, 80, -110, 80],
            morph: {
              times: [0, 1.5, 3], valueSize: 8, interpolation: 'cubic-bezier',
              values: [-110, -80, 110, -80, 110, 80, -110, 80, 0, -125, 125, 0, 0, 125, -125, 0, -110, -80, 110, -80, 110, 80, -110, 80],
              easings: [0.4, 0, 0.2, 1, 0.4, 0, 0.2, 1],
            },
            fill: { kind: 'solid', color: [0.7, 0.34, 1, 1] },
            stroke: { color: [0.94, 0.86, 1, 1], width: 6, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
          }],
        },
      ],
    }),
    sample('mask-stack', 'Mask Stack', {
      nodes: [
        backdrop(),
        {
          id: 'mask-orbit', transform: { position: [220, 180] },
          components: [{ type: 'shape2d', shape: 'ellipse', size: [230, 230], fill: [1, 1, 1, 1] }],
        },
        {
          id: 'mask-cutout', transform: { position: [320, 180] },
          components: [{ type: 'shape2d', shape: 'ellipse', size: [72, 72], fill: [1, 1, 1, 1] }],
        },
        {
          id: 'masked-card', transform: { position: [320, 180] },
          composite: { layers: [
            { kind: 'mask', source: 'mask-orbit', mode: 'alpha', operation: 'add', feather: [7, 7] },
            { kind: 'mask', source: 'mask-cutout', mode: 'alpha', operation: 'subtract', feather: [3, 3] },
          ] },
          components: [{ type: 'shape2d', shape: 'rect', size: [440, 230], fill: [0.18, 0.86, 0.6, 1] }],
        },
      ],
      tracks: [{ node: 'mask-orbit', property: 'position', interpolation: 'cubic-bezier', times: [0, 1.5, 3], values: [190, 180, 450, 180, 190, 180], easings: [0.4, 0, 0.2, 1, 0.4, 0, 0.2, 1] }],
    }),
    sample('text-selector', 'Text Selector', {
      nodes: [
        backdrop(),
        {
          id: 'headline', transform: { position: [320, 180] },
          components: [{
            type: 'text2d', text: 'HAIYUE', size: [560, 150], fontFamily: 'system-ui', fontSize: 86, fontWeight: 800,
            textAlign: 'center', verticalAlign: 'middle', color: [0.22, 0.94, 0.76, 1], resolutionScale: 1.5,
            animators: [{
              selector: {
                start: 0, end: 32, units: 'percent', shape: 'smooth',
                offsetTrack: { times: [0, 1.5, 3], values: [-45, 100, -45], valueSize: 1, interpolation: 'cubic-bezier', easings: [0.35, 0, 0.2, 1, 0.35, 0, 0.2, 1] },
              },
              position: [0, -42], scale: [1.24, 1.24], rotation: -0.12, opacity: 0.14,
              fillColor: [1, 0.46, 0.24, 1], tracking: 8,
            }],
          }],
        },
      ],
    }),
    sample('drop-shadow-effect', 'Drop Shadow Effect', {
      nodes: [
        backdrop(),
        {
          id: 'card', transform: { position: [320, 180] },
          effects: [{
            kind: 'drop-shadow', color: [0.02, 0.08, 0.18, 1], opacity: 0.85, offset: [12, 18], blur: 18,
            offsetTrack: { times: [0, 1.5, 3], values: [12, 18, -18, 28, 12, 18], valueSize: 2, interpolation: 'cubic-bezier', easings: [0.4, 0, 0.2, 1, 0.4, 0, 0.2, 1] },
            blurTrack: { times: [0, 1.5, 3], values: [12, 32, 12], valueSize: 1, interpolation: 'linear' },
          }],
          components: [{ type: 'shape2d', shape: 'rect', size: [250, 150], fill: [0.22, 0.56, 1, 1] }],
        },
      ],
      tracks: [{ node: 'card', property: 'rotation', interpolation: 'cubic-bezier', times: [0, 1.5, 3], values: [-0.12, 0.12, -0.12], easings: [0.4, 0, 0.2, 1, 0.4, 0, 0.2, 1] }],
    }),
    sample('particle-emitter', 'Particle Emitter', {
      nodes: [
        backdrop(),
        {
          id: 'emitter', transform: { position: [320, 265] },
          components: [{
            type: 'particle2d', maxParticles: 420, emissionRate: 72, burst: 24, duration: 3, loop: true, seed: 2307,
            lifetime: [0.8, 1.8], speed: [80, 230], angle: [-2.45, -0.7], gravity: [0, 170],
            startSize: [8, 18], endSize: [1, 4], startColor: [0.22, 0.92, 1, 0.95], endColor: [0.62, 0.22, 1, 0],
            shape: 'circle', shapeRadius: 28, blendMode: 'additive', radial: false,
          }],
        },
      ],
    }),
  ];
}

function sample(id, name, fields) {
  return {
    format: ANIMATION_FORMAT,
    version: ANIMATION_VERSION,
    name,
    canvas: { width: 640, height: 360, coordinateSystem: 'screen-y-down' },
    duration: 3,
    frameRate: 60,
    endBehavior: 'loop',
    ...fields,
    extensions: { ...(fields.extensions ?? {}), 'org.haiyue.sample@1': { id } },
  };
}

function lottiePrecompLayersSample() {
  const lottie = {
    nm: 'Nested Precomp Layers', fr: 60, ip: 0, op: 180, w: 640, h: 360,
    assets: [
      {
        id: 'gem', fr: 60, w: 120, h: 120,
        layers: [
          {
            ind: 3, ty: 1, nm: 'Vertical beam', parent: 1,
            sw: 20, sh: 72, sc: '#ff4f9a', ip: 0, op: 180,
            ks: lottieTransform({ position: [-10, -36], opacity: 88 }),
          },
          {
            ind: 2, ty: 1, nm: 'Horizontal beam', parent: 1,
            sw: 72, sh: 20, sc: '#4be7ff', ip: 0, op: 180,
            ks: lottieTransform({ position: [-36, -10] }),
          },
          {
            ind: 1, ty: 3, nm: 'Gem parent', ip: 0, op: 180,
            ks: lottieTransform({
              position: [60, 60],
              rotation: {
                a: 1,
                k: [
                  { t: 0, s: [0], e: [180], o: { x: 0.42, y: 0 }, i: { x: 0.58, y: 1 } },
                  { t: 90, s: [180], e: [360], o: { x: 0.42, y: 0 }, i: { x: 0.58, y: 1 } },
                  { t: 180, s: [360] },
                ],
              },
              scale: {
                a: 1,
                k: [
                  { t: 0, s: [82, 82], e: [112, 112] },
                  { t: 90, s: [112, 112], e: [82, 82] },
                  { t: 180, s: [82, 82] },
                ],
              },
              opacity: 92,
            }),
          },
        ],
      },
      {
        id: 'orbit', fr: 60, w: 320, h: 180,
        layers: [
          {
            ind: 3, ty: 0, nm: 'Stretched gem', refId: 'gem', parent: 1,
            ip: 15, op: 165, st: 15, sr: 1.5,
            ks: lottieTransform({ anchor: [60, 60], position: [-104, 0], scale: [82, 82], opacity: 72 }),
          },
          {
            ind: 2, ty: 0, nm: 'Primary gem', refId: 'gem', parent: 1,
            ip: 0, op: 180, st: 0, sr: 1,
            ks: lottieTransform({ anchor: [60, 60], position: [104, 0] }),
          },
          {
            ind: 1, ty: 3, nm: 'Orbit parent', ip: 0, op: 180,
            ks: lottieTransform({
              position: [160, 90],
              rotation: { a: 1, k: [{ t: 0, s: [-12], e: [12] }, { t: 90, s: [12], e: [-12] }, { t: 180, s: [-12] }] },
            }),
          },
        ],
      },
    ],
    layers: [
      {
        ind: 2, ty: 0, nm: 'Orbit precomp', refId: 'orbit', ip: 0, op: 180, st: 0, sr: 1,
        ks: lottieTransform({ anchor: [160, 90], position: [320, 180], opacity: 96 }),
      },
      {
        ind: 1, ty: 1, nm: 'Backdrop', sw: 640, sh: 360, sc: '#071126', ip: 0, op: 180,
        ks: lottieTransform(),
      },
    ],
  };
  const converted = convertLottie(lottie, { strict: true });
  return sample('lottie-precomp-layers', 'Lottie Nested Precomp', converted.document);
}

function lottieTransform({
  anchor = [0, 0],
  position = [0, 0],
  scale = [100, 100],
  rotation = 0,
  opacity = 100,
} = {}) {
  const property = value => typeof value === 'number' || Array.isArray(value)
    ? { a: 0, k: value }
    : value;
  return {
    a: property(anchor),
    p: property(position),
    s: property(scale),
    r: property(rotation),
    o: property(opacity),
  };
}

function backdrop() {
  return {
    id: 'backdrop',
    transform: { position: [320, 180] },
    components: [{ type: 'shape2d', shape: 'rect', size: [640, 360], fill: [0.018, 0.033, 0.072, 1] }],
  };
}

function spriteSheetTrack(columns, rows, framesPerSecond) {
  const times = [];
  const values = [];
  for (let frame = 0; frame < columns * rows; frame++) {
    times.push(frame / framesPerSecond);
    values.push((frame % columns) / columns, Math.floor(frame / columns) / rows, 1 / columns, 1 / rows);
  }
  return { times, values, valueSize: 4, interpolation: 'step' };
}

function projectedWireCube() {
  const vertices = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const times = Array.from({ length: 13 }, (_, index) => index * 0.25);
  const frames = times.map(time => vertices.map(vertex => projectCubeVertex(vertex, time / 3 * Math.PI * 2)));
  const components = edges.map(([from, to]) => {
    const projectedValues = frames.flatMap(frame => [
      frame[from][0], frame[from][1], frame[to][0], frame[to][1],
    ]);
    const colors = frames.flatMap(frame => cubeEdgeColor((frame[from][2] + frame[to][2]) * 0.5));
    return {
      type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
      commands: 'ML',
      values: projectedValues.slice(0, 4),
      morph: { times, values: projectedValues, valueSize: 4, interpolation: 'linear' },
      stroke: {
        color: colors.slice(0, 4), width: 5, lineCap: 'round', lineJoin: 'round', miterLimit: 4,
        colorTrack: { times, values: colors, valueSize: 4, interpolation: 'linear' },
      },
    };
  });
  return {
    extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID],
    nodes: [
      backdrop(),
      {
        id: 'cube-shadow', transform: { position: [320, 300], opacity: 0.42 },
        components: [{ type: 'shape2d', shape: 'ellipse', size: [245, 34], fill: [0.01, 0.01, 0.04, 0.72] }],
      },
      { id: 'cube', transform: { position: [320, 176] }, components },
    ],
    tracks: [
      { node: 'cube', property: 'position', interpolation: 'cubic-bezier', times: [0, 1.5, 3], values: [320, 180, 320, 164, 320, 180], easings: [0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1] },
      { node: 'cube-shadow', property: 'scale', interpolation: 'cubic-bezier', times: [0, 1.5, 3], values: [1, 1, 0.78, 0.72, 1, 1], easings: [0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1] },
    ],
  };
}

function projectCubeVertex([x, y, z], angle) {
  const tilt = -0.52;
  const tiltedY = y * Math.cos(tilt) - z * Math.sin(tilt);
  const tiltedZ = y * Math.sin(tilt) + z * Math.cos(tilt);
  const rotatedX = x * Math.cos(angle) + tiltedZ * Math.sin(angle);
  const rotatedZ = -x * Math.sin(angle) + tiltedZ * Math.cos(angle);
  const perspective = 360 / (4.4 + rotatedZ);
  return [rotatedX * perspective, tiltedY * perspective, rotatedZ];
}

function cubeEdgeColor(depth) {
  const near = Math.max(0, Math.min(1, (depth + 1.6) / 3.2));
  return [
    0.42 - near * 0.18,
    0.34 + near * 0.62,
    1 - near * 0.12,
    0.96,
  ];
}

function depthTunnel() {
  const ringCount = 8;
  const frameCount = 24;
  const times = Array.from({ length: frameCount + 1 }, (_, index) => index * 3 / frameCount);
  const nodes = [backdrop(), {
    id: 'vanishing-point', transform: { position: [320, 180] },
    components: [{ type: 'shape2d', shape: 'ellipse', size: [18, 18], fill: [0.65, 0.92, 1, 0.95] }],
  }];
  const tracks = [];
  for (let ring = 0; ring < ringCount; ring++) {
    const phase = ring / ringCount;
    const progress = times.map((_, frame) => (frame / frameCount + phase) % 1);
    const scales = progress.flatMap(value => {
      const scale = 0.08 + 1.72 * value * value;
      return [scale, scale];
    });
    const opacities = progress.map(value => Math.pow(Math.sin(Math.PI * value), 1.35) * 0.94);
    const rotations = progress.map(value => (ring % 2 === 0 ? 1 : -1) * (0.08 + value * 0.34));
    const color = tunnelColor(ring / (ringCount - 1));
    const id = `tunnel-ring-${ring}`;
    nodes.push({
      id, transform: { position: [320, 180], opacity: opacities[0] },
      components: [{
        type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
        commands: 'MLLLZ', values: [-180, -102, 180, -102, 180, 102, -180, 102],
        stroke: { color, width: 3.5, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
      }],
    });
    tracks.push(
      { node: id, property: 'scale', interpolation: 'linear', times, values: scales },
      { node: id, property: 'opacity', interpolation: 'linear', times, values: opacities },
      { node: id, property: 'rotation', interpolation: 'linear', times, values: rotations },
    );
  }
  return { extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID], nodes, tracks };
}

function tunnelColor(progress) {
  return [0.25 + progress * 0.48, 0.92 - progress * 0.46, 1, 0.96];
}

function perspectiveCardFlip() {
  const times = [0, 0.45, 0.72, 1.05, 1.5, 1.95, 2.22, 2.55, 3];
  const angles = [0, 0.34, 0.489, 0.7, 1, 1.3, 1.489, 1.66, 2].map(turn => turn * Math.PI);
  const cardTrack = projectedPlaneTrack([
    [-140, -90], [140, -90], [140, 90], [-140, 90],
  ], angles);
  const markTrack = projectedPlaneTrack([
    [0, -43], [42, 0], [0, 43], [-42, 0],
  ], angles);
  const sideColors = {
    times: [0, 0.72, 2.22, 3], valueSize: 4, interpolation: 'step',
    values: [0.14, 0.78, 1, 1, 0.92, 0.25, 0.58, 1, 0.14, 0.78, 1, 1, 0.14, 0.78, 1, 1],
  };
  return {
    extensionsUsed: [ANIMATION_VECTOR_SHAPE_EXTENSION_ID],
    nodes: [
      backdrop(),
      {
        id: 'card-shadow', transform: { position: [320, 292], opacity: 0.5 },
        components: [{ type: 'shape2d', shape: 'ellipse', size: [300, 36], fill: [0.005, 0.008, 0.03, 0.78] }],
      },
      {
        id: 'card', transform: { position: [320, 172] },
        effects: [{
          kind: 'drop-shadow', color: [0.02, 0.04, 0.12, 1], opacity: 0.82, offset: [18, 22], blur: 20,
          offsetTrack: { times: [0, 0.72, 1.5, 2.22, 3], values: [18, 22, 2, 30, -18, 22, -2, 30, 18, 22], valueSize: 2, interpolation: 'linear' },
          blurTrack: { times: [0, 0.72, 1.5, 2.22, 3], values: [18, 30, 18, 30, 18], valueSize: 1, interpolation: 'linear' },
        }],
        components: [
          {
            type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
            commands: 'MLLLZ', values: cardTrack.slice(0, 8),
            morph: { times, values: cardTrack, valueSize: 8, interpolation: 'linear' },
            fill: { kind: 'solid', color: [0.14, 0.78, 1, 1], colorTrack: sideColors },
            stroke: { color: [0.87, 0.98, 1, 0.96], width: 5, lineCap: 'round', lineJoin: 'round', miterLimit: 4 },
          },
          {
            type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
            commands: 'MLLLZ', values: markTrack.slice(0, 8),
            morph: { times, values: markTrack, valueSize: 8, interpolation: 'linear' },
            fill: { kind: 'solid', color: [0.98, 0.9, 0.28, 0.94] },
          },
        ],
      },
    ],
    tracks: [
      { node: 'card', property: 'position', interpolation: 'cubic-bezier', times: [0, 0.72, 1.5, 2.22, 3], values: [320, 178, 320, 160, 320, 178, 320, 160, 320, 178], easings: [0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1] },
      { node: 'card-shadow', property: 'scale', interpolation: 'linear', times: [0, 0.72, 1.5, 2.22, 3], values: [1, 1, 0.22, 0.72, 1, 1, 0.22, 0.72, 1, 1] },
      { node: 'card-shadow', property: 'opacity', interpolation: 'linear', times: [0, 0.72, 1.5, 2.22, 3], values: [0.5, 0.14, 0.5, 0.14, 0.5] },
    ],
  };
}

function projectedPlaneTrack(points, angles) {
  return angles.flatMap(angle => points.flatMap(([x, y]) => projectPlanePoint(x, y, angle)));
}

function projectPlanePoint(x, y, angle) {
  const normalizedX = x / 140;
  const depth = -normalizedX * Math.sin(angle) * 1.18;
  const perspective = 4 / (4 + depth);
  return [x * Math.cos(angle) * perspective, y * perspective];
}
