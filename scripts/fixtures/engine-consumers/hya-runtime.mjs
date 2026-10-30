import assert from 'node:assert/strict';
import { createHyaPlayer } from '@haiyue/extensions/hya-player';
import { createHyaTextShaper } from '@haiyue/extensions/hya-text';
import { createHyaLayout } from '@haiyue/extensions/hya-layout';
import { createHyaData, createHyaSemantics } from '@haiyue/extensions/hya-data';
import { createHyaAudio, createBrowserHyaAudioHost } from '@haiyue/extensions/hya-audio';

// Minimal source-neutral documents. This consumer verifies package mechanics and
// ownership, not glyph quality, GPU rendering, physical input or audible output.
const dataDocument = {
  format: 'haiyue-data-binding', version: 1, extension: 'org.haiyue.data-binding@1',
  enums: [], models: [{ id: 'Model', properties: [{ id: 'count', kind: 'number', defaultValue: 0 }] }],
  instances: [{ id: 'model', model: 'Model', scope: 'local', values: {} }],
  converters: [], propertyGroups: [], components: [], bindings: [],
};
const layoutDocument = {
  format: 'haiyue-responsive-layout-2d', version: 1, extension: 'org.haiyue.layout-2d@1',
  shaping: { stack: 'haiyue-text-shaping@1', backendRevision: 'packed-consumer',
    unicodeVersion: '15.1', graphemeRevision: 'uax29-43', bidiRevision: 'uax9-50' },
  assets: [], textStyles: [], textBlocks: [],
  artboards: [{ id: 'main', width: 64, height: 32, root: 'root',
    nodes: [{ id: 'root', kind: 'container', style: { width: { unit: 'fill' }, height: { unit: 'fill' } } }] }],
  instances: [{ id: 'stage', artboard: 'main', fit: 'fill', alignment: [0, 0] }],
};
const disposables = [];
try {
  const data = createHyaData(dataDocument); disposables.push(data);
  let notifications = 0;
  const subscription = data.subscribe(() => notifications++);
  data.run(write => write.set('model', ['count'], 7));
  assert.equal(data.read('model', ['count']), 0, 'queued changes stay uncommitted');
  data.advance(); assert.equal(data.read('model', ['count']), 7); assert.equal(notifications, 1);
  subscription.unsubscribe();

  const semantics = createHyaSemantics({ format: 'haiyue-semantics', version: 1,
    extension: 'org.haiyue.semantics@1', reducedMotion: { mode: 'ignore' }, nodes: [] },
  { bindings: data, action() {} }); disposables.push(semantics);
  assert.equal(semantics.update({ revision: 1, geometry: {} }).nodes.length, 0);

  let fontReleases = 0;
  const text = await createHyaTextShaper(layoutDocument, { async acquire() {
    return { shape() { throw Error('No text blocks in this document'); }, release() { fontReleases++; } };
  } }); disposables.push(text);
  text.dispose(); text.dispose(); assert.equal(fontReleases, 1, 'font lease releases exactly once');
  const layout = createHyaLayout(layoutDocument); disposables.push(layout);
  const geometry = layout.evaluate({ viewport: [64, 32], dpr: 1, time: 0 });
  assert.ok(geometry.nodes.length > 0); assert.deepEqual([...geometry.viewport], [64, 32]);

  const player = await createHyaPlayer({ format: 'haiyue-composition', version: 1,
    parts: [{ id: 'data', extension: dataDocument.extension, required: true,
      requires: [], dependencies: [], document: dataDocument }], targets: [] },
  { mode: 'evaluate', viewport: [64, 32], host: { capabilities: new Set([dataDocument.extension]), invalidate() {} } });
  disposables.push(player);
  player.data.run(write => write.set('model', ['count'], 9));
  const frame = player.advance({ sequence: 1, deltaSeconds: 0, viewport: [64, 32], dpr: 1 });
  assert.equal(frame.ready, true); assert.equal(player.data.read('model', ['count']), 9);
  player.pause(); player.seek(0); assert.equal(player.status, 'paused');

  const audio = await createHyaAudio({ format: 'haiyue-audio-events', version: 1,
    extension: 'org.haiyue.audio-events@1', playbackProfile: 'sample-accurate',
    clock: { sampleRate: 48000, lookAheadFrames: 4800, driftToleranceFrames: 64, driftPolicy: 'resync',
      lateDecodePolicy: 'catch-up', visibilityPolicy: 'pause-resume', suspendedPolicy: 'queue-until-resume' },
    browser: { autoplay: 'attempt' },
    limits: { maxVoices: 4, maxVoicesPerResource: 3, maxDecodeJobs: 4, maxEventTokens: 128,
      maxDecodedFrames: 100000, maxDecodedBytes: 1000000 },
    voiceStealing: 'steal-oldest', resources: [], buses: [{ id: 'master', gain: 1 }], cues: [], timelineEvents: [],
  }, { profile: 'sample-accurate', sampleRate: 48000, state: 'running', nowFrame() { return 0; }, async unlock() {},
    async decode() { throw Error('No audio resources in this document'); },
    schedule() { throw Error('No audio cues in this document'); } }); disposables.push(audio);
  await assert.rejects(audio.update({ domain: 'composition', time: 0, rate: 1, operation: 'advance' }),
    error => error.code === 'E_AUDIO_RUNTIME_AUTOPLAY');
  await audio.unlock(); // Explicit host protocol only; no claim of a browser user gesture.
  await audio.update({ domain: 'composition', time: 0, rate: 1, operation: 'advance' });
  assert.equal(typeof createBrowserHyaAudioHost, 'function');
  console.log(JSON.stringify({ status: 'passed', entrypoints: 5, retainedRuntimeFactories: 7,
    invokedFactories: 6, browserAudioFactoryExport: true, gpuOrDeviceQualification: false }));
} finally {
  for (const value of disposables.reverse()) value.dispose();
}
