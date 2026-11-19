export const design = [320, 200];
const white = [1, 1, 1, 1], navy = [.07, .18, .4, 1], red = [1, 0, 0, 1], blue = [0, 0, 1, 1], green = [0, 1, 0, 1], yellow = [1, 1, 0, 1];

function art(size, color, { endColor, eventAt, image, loop = false, stripes = false, interpolate = false } = {}) {
  const [width, height] = size;
  const rect = (id, x, w, fill) => ({
    id, transform: { position: [x, height / 2] },
    components: [{ type: 'shape2d', shape: 'rect', size: [w, height], fill }],
  });
  const document = {
    format: 'haiyue-animation', version: '1.0', duration: 4,
    canvas: { width, height, coordinateSystem: 'screen-y-down' },
    resources: image ? [{ id: 'tiny', type: 'image', uri: 'asset:tiny', width: 3, height: 3,
      colorSpace: 'linear', mimeType: 'image/png', integrity: image.integrity }] : [],
    extensionsUsed: [], tracks: [],
    nodes: stripes ? [rect('left', width / 8, width / 4, red), rect('node', width / 2, width / 2, green),
      rect('right', width * 7 / 8, width / 4, blue)] : [rect('node', width / 2, width, color)],
  };
  if (image) document.nodes.push({ id: 'sprite', transform: { position: [width - 12, height - 12] },
    components: [{ type: 'sprite2d', resource: 'tiny', size: [10, 10] }] });
  const source = { format: 'haiyue-composition', version: 1,
    parts: [{ id: 'core', extension: 'org.haiyue.animation-core@1', required: true, requires: [], dependencies: [], document }],
    targets: [] };
  if (!endColor && !eventAt) return source;
  source.targets.push({ id: 'shape', part: 'core', kind: 'animation-node', address: ['node'] });
  const channels = [{ id: 'paint', target: 'shape', path: 'components.0.paint.fill.color', family: 'paint-path',
    valueKind: 'color', valueSize: 4, policy: 'override', defaultValue: color }];
  const tracks = [{ id: 'paint', channel: 'paint', keys: [
    { time: 0, value: color, interpolation: { kind: interpolate ? 'linear' : 'hold' } }, { time: eventAt ?? .25, value: endColor },
  ] }];
  if (eventAt) {
    channels.push({ id: 'signal', target: 'shape', path: 'event.finish', family: 'event-audio-script',
      valueKind: 'callback', policy: 'ownership', effectKind: 'event' });
    tracks.push({ id: 'signal', channel: 'signal', keys: [{ time: eventAt, value: { name: 'actor-ready' } }] });
  }
  source.parts.push({ id: 'state', extension: 'org.haiyue.animation-state-machine@2', required: true, requires: [], dependencies: ['core'],
    document: {
      format: 'haiyue-animation-state-machine@2', extension: 'org.haiyue.animation-state-machine@2', components: [],
      channels, clips: [{ id: 'motion', duration: 1, tracks }],
      stateMachines: [{ id: 'main', inputs: [], layers: [{ id: 'base', order: 0,
        states: [{ id: 'motion', motion: { kind: 'clip', clip: 'motion', playback: loop ? 'loop' : 'one-shot' } }],
        transitions: [{ id: 'entry', from: '@entry', to: 'motion', duration: 0, conditionGroups: [] }],
      }] }],
    },
  });
  return source;
}

export function catalogue(image) {
  const hold = { mode: 'hold' };
  const once = { mode: 'once', duration: 1 };
  const loop = { mode: 'loop', duration: 1 };
  const transitions = { arrive: { fromTime: 0, toTime: .25, stateId: 'settled' } };
  const states = { settled: { time: .25 } };
  const parameters = art([62,55], yellow);
  parameters.targets.push({ id: 'shape', part: 'core', kind: 'animation-node', address: ['node'] });
  parameters.parts.push({ id: 'data', extension: 'org.haiyue.data-binding@1', required: true, requires: [], dependencies: ['core'], document: {
    format: 'haiyue-data-binding', version: 1, extension: 'org.haiyue.data-binding@1',
    enums: [], converters: [], propertyGroups: [], components: [],
    models: [{ id: 'Paint', properties: [{ id: 'alpha', kind: 'number', defaultValue: 1 }] }],
    instances: [{ id: 'paint', model: 'Paint', scope: 'local', values: { alpha: 1 } }],
    bindings: [{ id: 'alpha', target: 'shape', targetPath: ['opacity'], source: { mode: 'explicit', instance: 'paint', path: ['alpha'] }, direction: 'read' }],
  } });
  return {
    background: { size: design, source: art(design, navy), playback: hold },
    rain: { size: design, source: art(design, navy, { endColor: [.11,.22,.44,1], loop: true, interpolate: true }), playback: loop },
    left: { size: [125,115], source: art([125,115], red), playback: hold },
    'left-motion': { size: [125,115], source: art([125,115], red, { endColor: white, eventAt: .10, loop: true, interpolate: true }), playback: loop },
    right: { size: [125,115], source: art([125,115], blue, { image }), playback: hold },
    'right-motion': { size: [125,115], source: art([125,115], blue, { image, endColor: green, eventAt: .25, interpolate: true }), playback: once, transitions, states },
    effect: { size: [62,55], source: art([62,55], yellow), playback: hold },
    'effect-motion': { size: [62,55], source: art([62,55], yellow, { endColor: white }), playback: hold, transitions, states },
    'effect-playing': { size: [62,55], source: art([62,55], yellow, { endColor: white, interpolate: true }), playback: once },
    'effect-data': { size: [62,55], source: parameters, playback: hold, states: { hidden: { data: { alpha: 0 } } },
      parameters: { alpha: { instance: { part: 'data', id: 'paint' }, path: ['alpha'] } } },
    wide: { size: [80,40], source: art([80,40], green, { stripes: true }), playback: hold },
  };
}

export function shot(background = 'background', left = 'left', right = 'right', effect = 'effect') {
  return [
    { id: 'background', assetId: background, bounds: [0,0,320,200], order: 0 },
    { id: 'left', assetId: left, bounds: [40,42,125,115], order: 1 },
    { id: 'right', assetId: right, bounds: [130,48,125,115], order: 2 },
    { id: 'effect', assetId: effect, bounds: [134,56,62,55], order: 3 },
  ];
}
