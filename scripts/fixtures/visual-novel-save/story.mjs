export const catalog = Object.fromEntries(['rain','left-motion','right','effect','left','background'].map(id =>
  [id, { kind: 'hya', path: id + '.hya' }]));
catalog.music = { kind: 'audio', path: 'music.wav' };
const nodes = {
  'dock/setup': { type: 'action', name: 'visualNovel.stage', next: 'dock/intro' },
  'dock/intro': { type: 'dialogue', textKey: 'intro', next: 'dock/fork' },
  'dock/fork': { type: 'choice', textKey: 'fork', options: [
    { id: 'left', textKey: 'left', next: 'dock/award', effects: [{ op: 'set', variable: 'side', value: 'left' }] },
    { id: 'right', textKey: 'right', next: 'dock/award', effects: [{ op: 'set', variable: 'side', value: 'right' }] },
  ] },
  'dock/award': { type: 'action', name: 'award', next: 'dock/branch' },
  'dock/branch': { type: 'branch', condition: { op: 'eq', variable: 'side', value: 'left' }, then: 'dock/left', otherwise: 'dock/right' },
  'dock/left': { type: 'dialogue', textKey: 'leftEnd', next: 'dock/ending' },
  'dock/right': { type: 'dialogue', textKey: 'rightEnd', next: 'dock/ending' },
  'dock/ending': { type: 'end', textKey: 'end', ending: 'done' },
};
const lines = Object.fromEntries(Object.entries(nodes).filter(([, node]) => 'textKey' in node).map(([nodeId, node]) =>
  [node.textKey, { nodeId, textKey: node.textKey, voices: {} }]));
export const backdrop = [
  { id: 'background', assetId: 'rain', order: 0, bounds: [0,0,320,200] },
  { id: 'left', assetId: 'left-motion', order: 1, bounds: [35,18,125,115] },
  { id: 'right', assetId: 'left', order: 2, bounds: [140,24,125,115] },
  { id: 'effect', assetId: 'effect', order: 3, bounds: [220,31,62,55] },
];
export const story = {
  definition: {
    schemaVersion: 1,
    narrative: { schemaVersion: 1, id: 'g05-story', version: '1', start: 'dock/setup', variables: { side: '', coins: 0 }, nodes },
    assets: catalog, presets: { dock: backdrop },
    cues: { 'dock/setup': [[{ op: 'show', presetId: 'dock', slots: backdrop }]] },
    replays: { chapter: { startLineId: 'intro', endLineId: 'leftEnd' }, cg: { startLineId: 'intro', endLineId: 'rightEnd' } },
  },
  lines, defaultLocale: 'zh-Hans', routes: {},
  locales: { 'zh-Hans': { schemaVersion: 1, locale: 'zh-Hans', messages: {
    intro: '晚潮已涨。', fork: '请选择航线。', left: '左侧港湾', right: '右侧岛屿',
    leftEnd: '到达港湾。', rightEnd: '到达岛屿。', end: '终幕',
  } } },
};
