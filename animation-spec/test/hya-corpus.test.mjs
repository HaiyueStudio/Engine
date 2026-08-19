import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { convertLottie } from '../dist/lottie.js';
import { analyzeLottieFeatures, summarizeFeatureAttribution } from '../../scripts/hya-corpus/feature-attribution.mjs';
import { createCapabilitySnapshot } from '../../scripts/hya-corpus/capability-roadmap.mjs';
import { entryFontMappings } from '../../scripts/hya-corpus/corpus.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'corpus/manifest.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, 'corpus/results/latest.json'), 'utf8'));
const capabilitySnapshot = JSON.parse(readFileSync(resolve(root, '../examples/hya-lottie-corpus-dashboard/capabilities.json'), 'utf8'));

test('real Lottie corpus is pinned, hashed, and deliberately includes capability gaps', () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.corpus, 'hya-lottie-real-v1');
  assert.match(manifest.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.source.dataLicense, 'CC0-1.0');
  assert.ok(manifest.source.rawBaseUrl.includes(manifest.source.revision));
  assert.match(manifest.sources['airbnb-lottie-web'].revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.sources['airbnb-lottie-web'].dataLicense, 'MIT');
  assert.ok(manifest.entries.length >= 23);

  const ids = new Set();
  const expectations = new Set();
  let frameCount = 0;
  let largeCount = 0;
  for (const entry of manifest.entries) {
    assert.ok(!ids.has(entry.id), `duplicate corpus id ${entry.id}`);
    ids.add(entry.id);
    expectations.add(entry.expectation);
    assert.match(entry.source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.source.bytes > 0);
    if (entry.sizeClass === 'large') {
      largeCount++;
      assert.equal(entry.source.sourceId, 'airbnb-lottie-web');
    }
    assert.ok(entry.animation.width > 0 && entry.animation.height > 0 && entry.animation.frameRate > 0);
    assert.ok(entry.frames.length > 0, `${entry.id} has no reference frames`);
    for (const frame of entry.frames) {
      assert.match(frame.sha256, /^[a-f0-9]{64}$/);
      assert.ok(frame.bytes > 0);
      if (frame.referenceKind) {
        const bytes = readFileSync(resolve(root, 'corpus', frame.referencePath));
        assert.equal(bytes.byteLength, frame.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.sha256);
      }
      frameCount++;
    }
  }
  assert.deepEqual([...expectations].sort(), ['degraded', 'supported', 'unsupported']);
  assert.ok(largeCount >= 6, 'large browser-delivery corpus is missing');
  assert.ok(frameCount > manifest.entries.length, 'animated properties should include non-zero reference frames');
});

test('banner web fonts are pinned as licensed WOFF2 delivery resources with real metrics', () => {
  assert.match(manifest.sources['google-fonts'].revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.sources['google-fonts'].dataLicense, 'OFL-1.1');
  const banner = manifest.entries.find(entry => entry.id === 'large/banner-ui-text');
  assert.equal(banner.expectation, 'supported');
  const fontResources = banner.resources.filter(resource => resource.kind === 'font');
  assert.equal(fontResources.length, 2);
  assert.equal(fontResources.reduce((total, resource) => total + resource.bytes, 0), 51392);
  for (const resource of fontResources) {
    assert.equal(resource.sourceId, 'google-fonts');
    assert.equal(resource.mimeType, 'font/woff2');
    assert.equal(resource.license.spdx, 'OFL-1.1');
    assert.ok(resource.license.url.includes(manifest.sources['google-fonts'].revision));
    assert.match(resource.sha256, /^[a-f0-9]{64}$/);
  }
  const mappings = entryFontMappings(manifest, banner);
  assert.deepEqual(Object.keys(mappings).sort(), [
    'Montserrat-Bold',
    'Montserrat-Regular',
    'VarelaRound-Regular',
  ]);
  assert.equal(mappings['Montserrat-Bold'].weight, 700);
  assert.equal(mappings['Montserrat-Bold'].metrics.capHeight, 700);
  assert.equal(mappings['VarelaRound-Regular'].metrics.unitsPerEm, 1000);
  assert.equal(mappings['VarelaRound-Regular'].mimeType, 'font/woff2');
  assert.match(mappings['VarelaRound-Regular'].uri, /google-fonts\/fonts\/varela-round-latin-v21\.woff2$/);

  const footage = manifest.entries.find(entry => entry.id === 'large/footage-images-text');
  assert.deepEqual(entryFontMappings(manifest, footage), {}, 'proprietary Arial/Futura assets must not be implied or bundled');
});

test('checked-in schema v3 dashboard report covers every corpus sample and all five metric families', () => {
  const smallEntries = manifest.entries.filter(entry => entry.sizeClass !== 'large');
  const largeEntries = manifest.entries.filter(entry => entry.sizeClass === 'large');
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.suiteVersion, manifest.corpus);
  assert.equal(report.source.revision, manifest.source.revision);
  assert.equal(report.samples.length, manifest.entries.length);
  assert.equal(report.summary.sampleCount, manifest.entries.length);
  assert.equal(report.summary.referenceFrameCount, manifest.entries.reduce((total, entry) => total + entry.frames.length, 0));
  assert.equal(report.cohorts.small.sampleCount, smallEntries.length);
  assert.equal(report.cohorts.large.sampleCount, largeEntries.length);
  assert.equal(report.cohorts.small.referenceFrameCount, smallEntries.reduce((total, entry) => total + entry.frames.length, 0));
  assert.equal(report.cohorts.large.referenceFrameCount, largeEntries.reduce((total, entry) => total + entry.frames.length, 0));
  assert.ok(Array.isArray(report.featureSummary) && report.featureSummary.length > 0);
  assert.equal(report.summary.unclassifiedFailureCount, 0);
  assert.equal(report.cohorts.small.unclassifiedFailureCount, 0);
  assert.equal(report.cohorts.large.unclassifiedFailureCount, 0);
  assert.ok(report.cohorts.small.gzipByteSaving >= 0.15, 'formal small-corpus gzip saving must remain at or above 15%');
  assert.ok(report.cohorts.small.minimumFidelity >= 0.949, 'existing small-corpus fidelity regressed');
  assert.ok(report.cohorts.small.medianParseSpeedup >= 1.25, 'formal small-corpus HYA parse evidence must remain at or above 1.25x');
  assert.equal(report.parseStability.runs.length, report.methodology.parseStabilityRuns);
  assert.ok(report.parseStability.minimum >= 1.25, 'every formal HYA parse stability run must remain at or above 1.25x');
  assert.equal(report.parseStabilityByCohort.small.runs.length, report.methodology.parseStabilityRuns);
  assert.equal(report.parseStabilityByCohort.large.runs.length, report.methodology.parseStabilityRuns);
  assert.ok(report.parseStabilityByCohort.small.minimum >= 1.25);

  const byId = new Map(report.samples.map(sample => [sample.id, sample]));
  for (const entry of manifest.entries) {
    const sample = byId.get(entry.id);
    assert.ok(sample, `report omitted ${entry.id}`);
    assert.equal(sample.sizeClass, entry.sizeClass ?? 'small');
    assert.ok(sample.source.bytes > 0 && sample.hya.bytes > 0);
    assert.ok(sample.source.gzipBytes > 0 && sample.hya.gzipBytes > 0);
    assert.ok(Number.isFinite(sample.parse.lottieToRuntime.medianMs));
    assert.ok(Number.isFinite(sample.parse.hyaToRuntime.medianMs));
    assert.ok(sample.parse.batchSize >= 1, `${entry.id} has no batched parse methodology`);
    assert.equal(sample.delivery.source.network.bytes, sample.source.bytes);
    assert.equal(sample.delivery.hya.network.bytes, sample.hya.bytes);
    assert.equal(sample.source.deliveryPayloadBytes, sample.source.bytes + sample.source.externalResourceBytes);
    assert.ok(sample.hya.deliveryPayloadBytes >= sample.hya.bytes);
    assert.equal(sample.delivery.source.network.streamed, true);
    assert.equal(sample.delivery.hya.network.streamed, true);
    assert.ok(sample.delivery.source.network.totalMs > 0, `${entry.id} has no source HTTP timing`);
    assert.ok(sample.delivery.hya.network.totalMs > 0, `${entry.id} has no HYA HTTP timing`);
    assert.ok(sample.delivery.source.jsonParseMs >= 0, `${entry.id} has no source JSON parse timing`);
    assert.ok(sample.delivery.hya.parseMs >= 0, `${entry.id} has no HYA parse timing`);
    assert.ok(sample.firstFrame?.totalMs > 0, `${entry.id} has no first-frame result`);
    assert.equal(sample.firstFrame.network.bytes, sample.hya.bytes);
    assert.ok(sample.fidelity?.score >= 0 && sample.fidelity.score <= 1, `${entry.id} has no fidelity result`);
    assert.equal(sample.frames.length, entry.frames.length);
    assert.ok(sample.featureAnalysis.detectedFeatureCount > 0, `${entry.id} has no detected features`);
    assert.equal(sample.featureAnalysis.unclassifiedFailureCount, 0, `${entry.id} has unclassified diagnostics`);
    for (const frame of sample.frames) {
      assert.ok(frame.metrics?.score >= 0 && frame.metrics.score <= 1);
      assert.ok(frame.metrics?.alphaIoU >= 0 && frame.metrics.alphaIoU <= 1);
    }
  }
  assert.ok(Math.max(...report.samples.map(sample => sample.fidelity.alphaIoU)) > 0.5,
    'all alpha IoU results look like a blank WebGPU canvas readback');
});

test('dashboard capability snapshot separates current support from formal performance evidence', () => {
  assert.equal(capabilitySnapshot.schemaVersion, 1);
  assert.equal(capabilitySnapshot.kind, 'hya-capability-support');
  assert.equal(capabilitySnapshot.summary.featureCount, capabilitySnapshot.features.length);
  assert.equal(capabilitySnapshot.summary.precompStatus, 'full');
  const precomp = capabilitySnapshot.features.find(feature => feature.feature === 'layers/precomp');
  assert.equal(precomp.status, 'full');
  assert.equal(precomp.failureCount, 0);
  assert.match(precomp.strategy, /parent|opacity|track/);
  const primitiveSize = capabilitySnapshot.features.find(feature => feature.feature === 'shapes/primitive-size');
  const stroke = capabilitySnapshot.features.find(feature => feature.feature === 'styles/stroke');
  const mergePath = capabilitySnapshot.features.find(feature => feature.feature === 'operators/merge-path');
  assert.equal(primitiveSize.status, 'full');
  assert.equal(stroke.status, 'full');
  assert.equal(mergePath.status, 'full');
  assert.deepEqual(mergePath.diagnosticCodes, []);
  for (const feature of capabilitySnapshot.features.filter(feature => feature.status === 'full')) {
    assert.equal(feature.priority, 'done', `${feature.feature} retained stale roadmap priority`);
  }
  for (const feature of capabilitySnapshot.features.filter(feature => feature.status !== 'full')) {
    assert.ok(feature.strategy.length > 20, `${feature.feature} has no actionable strategy`);
    assert.ok(feature.owner.length > 0, `${feature.feature} has no owner`);
    assert.ok(feature.priority.length > 0, `${feature.feature} has no priority`);
  }

  const synthetic = createCapabilitySnapshot([{
    featureAnalysis: {
      features: [{
        feature: 'operators/merge-path', occurrences: 2, status: 'unsupported', failureCount: 1,
        diagnosticCodes: ['W_LOTTIE_UNSUPPORTED_SHAPE'], failures: [],
      }],
    },
    fidelity: null,
  }], { generatedAt: '2026-01-01T00:00:00.000Z', gitRevision: 'test', workingTreeDirty: false });
  assert.equal(synthetic.features[0].priority, 'P0');
  assert.equal(synthetic.features[0].owner, 'converter');
});

test('animated Merge Paths remains a classified partial capability', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    nm: 'Animated merge attribution', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{ ind: 1, ty: 4, ip: 0, op: 30, ks: transform, shapes: [
      {
        ty: 'rc', p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 },
        s: { a: 1, k: [{ t: 0, s: [10, 10] }, { t: 30, s: [20, 20] }] },
      },
      { ty: 'rc', p: { a: 0, k: [5, 0] }, s: { a: 0, k: [20, 20] }, r: { a: 0, k: 0 } },
      { ty: 'mm', mm: 2 },
      { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } },
    ] }],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(source, conversion.diagnostics, ['operators/merge-path']);
  const mergePath = analysis.features.find(feature => feature.feature === 'operators/merge-path');
  assert.equal(mergePath.status, 'partial');
  assert.deepEqual(mergePath.diagnosticCodes, ['W_LOTTIE_ANIMATED_MERGE_PATH']);
  assert.equal(analysis.unclassifiedFailureCount, 0);
});

test('large corpus covers marketing, UI motion, nested precomp, image, text, and complex curves', () => {
  const large = manifest.entries.filter(entry => entry.sizeClass === 'large');
  const features = new Set(large.flatMap(entry => entry.features));
  const categories = new Set(large.map(entry => entry.category));
  assert.ok(categories.has('large-marketing'));
  assert.ok(categories.has('large-ui-motion'));
  for (const feature of [
    'layers/precomp',
    'layers/image',
    'layers/text',
    'curves/complex',
    'timing/time-remap',
    'effects/layer-effect',
  ]) assert.ok(features.has(feature), `large corpus is missing ${feature}`);
  const imageSample = large.find(entry => entry.features.includes('layers/image'));
  assert.ok(imageSample?.resources?.length >= 2, 'large image sample has no pinned external resources');
  assert.ok(large.every(entry => entry.frames.every(frame => frame.referenceKind === 'lottie-web-canvas')));
});

test('feature attribution assigns unsupported operators and supported precomps to exact feature buckets', () => {
  const path = {
    a: 0,
    k: { v: [[0, 0], [20, 0], [20, 20]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]], c: false },
  };
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    nm: 'Attribution', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    assets: [{ id: 'nested', layers: [] }],
    layers: [
      { ind: 1, ty: 4, ip: 0, op: 30, ks: transform, shapes: [{ ty: 'sh', ks: path }, { ty: 'rp', c: 2 }] },
      { ind: 2, ty: 0, refId: 'nested', ip: 0, op: 30, ks: transform },
    ],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(source, conversion.diagnostics, ['operators/repeater', 'layers/precomp']);
  const repeater = analysis.features.find(feature => feature.feature === 'operators/repeater');
  const precomp = analysis.features.find(feature => feature.feature === 'layers/precomp');
  assert.equal(repeater.status, 'unsupported');
  assert.ok(repeater.failures.some(failure => failure.code === 'W_LOTTIE_UNSUPPORTED_SHAPE'));
  assert.equal(precomp.status, 'full');
  assert.equal(precomp.failureCount, 0);
  assert.equal(analysis.unclassifiedFailureCount, 0);
  const summary = summarizeFeatureAttribution([{ featureAnalysis: analysis, fidelity: { score: 0.4 } }]);
  assert.equal(summary.find(feature => feature.feature === 'operators/repeater').observedFidelityLoss, 0.6);
});

test('hidden transform parents and authored empty paths remain clean capability evidence', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [
      { ind: 1, ty: 3, hd: true, ip: 0, op: 30, ks: transform },
      {
        ind: 2, ty: 4, parent: 1, ip: 0, op: 30, ks: transform,
        shapes: [
          { ty: 'sh', ks: { a: 0, k: { v: [], i: [], o: [], c: false } } },
          { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } },
        ],
      },
    ],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(source, conversion.diagnostics, [
    'layers/parent',
    'conversion/no-renderable-shape',
  ]);
  assert.equal(conversion.document.nodes.find(node => node.id === 'layer:2')?.parent, 'layer:1');
  assert.equal(analysis.features.find(feature => feature.feature === 'layers/parent')?.status, 'full');
  assert.equal(analysis.features.find(feature => feature.feature === 'conversion/no-renderable-shape')?.status, 'full');
  assert.equal(analysis.unclassifiedFailureCount, 0);
});

test('declared silent capabilities remain visible after their diagnostics reach zero', () => {
  const analysis = analyzeLottieFeatures({ fr: 30, ip: 0, op: 30, w: 64, h: 64, layers: [] }, [], [
    'animation/path-topology',
    'composites/stack-budget',
  ]);
  assert.deepEqual(analysis.features.map(feature => [feature.feature, feature.status, feature.declared]), [
    ['animation/path-topology', 'full', true],
    ['composites/stack-budget', 'full', true],
  ]);
});

test('time remap and layer effects stay in exact feature buckets', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    nm: 'Exact unsupported attribution', fr: 30, ip: 0, op: 30, w: 100, h: 100,
    layers: [{
      ind: 1,
      ty: 1,
      sw: 100,
      sh: 100,
      sc: '#ffffff',
      ip: 0,
      op: 30,
      ks: transform,
      tm: { a: 0, k: 0 },
      ef: [{ ty: 5, nm: 'Unsupported effect' }],
    }],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(
    source,
    conversion.diagnostics,
    ['timing/time-remap', 'effects/layer-effect'],
  );
  const timeRemap = analysis.features.find(feature => feature.feature === 'timing/time-remap');
  const effect = analysis.features.find(feature => feature.feature === 'effects/layer-effect');
  assert.ok(timeRemap?.diagnosticCodes.includes('W_LOTTIE_TIME_REMAP'));
  assert.ok(effect?.diagnosticCodes.includes('W_LOTTIE_EFFECT'));
  assert.equal(timeRemap.status, 'unsupported');
  assert.equal(effect.status, 'unsupported');
  assert.equal(analysis.unclassifiedFailureCount, 0);
});

test('text substitution, selector and partial effect diagnostics remain classified', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    fonts: { list: [{ fName: 'MissingFont', fFamily: 'Missing Font', fStyle: 'Regular' }] },
    layers: [{
      ind: 1, ty: 5, ip: 0, op: 30, ks: transform,
      t: {
        d: { k: [{ t: 0, s: { t: 'A', s: 20, f: 'MissingFont', fc: [1, 1, 1], sz: [40, 30] } }] },
        a: [{ s: { t: 1, b: 1 }, a: { o: { a: 0, k: 50 } } }],
      },
      ef: [{ nm: 'Tint', ef: [] }],
    }],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(source, conversion.diagnostics);
  assert.ok(analysis.features.find(feature => feature.feature === 'text/font-substitution')?.diagnosticCodes.includes('W_LOTTIE_FONT_SUBSTITUTION'));
  assert.ok(analysis.features.find(feature => feature.feature === 'animation/text-selector')?.diagnosticCodes.includes('W_LOTTIE_TEXT_SELECTOR'));
  assert.ok(analysis.features.find(feature => feature.feature === 'effects/layer-effect')?.diagnosticCodes.includes('W_LOTTIE_EFFECT_PARAM'));
  assert.equal(analysis.unclassifiedFailureCount, 0);
});

test('data layers and text expressions are attributed independently with no unclassified failure', () => {
  const transform = {
    a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
  };
  const source = {
    fr: 30, ip: 0, op: 30, w: 100, h: 100,
    assets: [{ id: 'data', t: 3, p: 'payload.json' }],
    layers: [
      { ind: 1, ty: 15, refId: 'data', ip: 0, op: 30, ks: transform },
      { ind: 2, ty: 5, ip: 0, op: 30, ks: transform, t: {
        d: { x: '$bm_rt = "dynamic";', k: [{ s: { t: 'fallback', f: 'sans-serif' } }] },
      } },
    ],
  };
  const conversion = convertLottie(source);
  const analysis = analyzeLottieFeatures(source, conversion.diagnostics);
  assert.equal(analysis.features.find(feature => feature.feature === 'layers/data')?.status, 'full');
  const expression = analysis.features.find(feature => feature.feature === 'expressions/text-document');
  assert.equal(expression?.status, 'unsupported');
  assert.deepEqual(expression?.diagnosticCodes, ['W_LOTTIE_TEXT_EXPRESSION']);
  assert.equal(analysis.features.some(feature => feature.feature === 'layers/unknown'), false);
  assert.equal(analysis.unclassifiedFailureCount, 0);
});
