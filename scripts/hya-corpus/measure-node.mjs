import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { convertLottie } from '../../animation-spec/dist/lottie.js';
import { encodeAnimationBinary, parseAnimation } from '../../animation-spec/dist/index.js';
import { analyzeLottieFeatures } from './feature-attribution.mjs';
import {
  ASSET_ROOT,
  BROWSER_INPUT_PATH,
  GENERATED_ROOT,
  clearGeneratedCorpus,
  entryFontMappings,
  entryResourceAssetPath,
  entrySizeClass,
  entrySource,
  entrySourceAssetPath,
  entrySourceUrl,
  frameReferenceAssetPath,
  generatedHyaPath,
  projectUrl,
  writeJson,
} from './corpus.mjs';

let benchmarkSink;

export function measureNodeCorpus(
  manifest,
  {
    iterations = 100,
    batchSize = 50,
    largeIterations = 20,
    largeBatchSize = 1,
  } = {},
) {
  if (!Number.isSafeInteger(iterations) || iterations < 10) {
    throw new Error('HYA corpus iterations must be a safe integer of at least 10.');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('HYA corpus batch size must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(largeIterations) || largeIterations < 10) {
    throw new Error('HYA large-corpus iterations must be a safe integer of at least 10.');
  }
  if (!Number.isSafeInteger(largeBatchSize) || largeBatchSize < 1) {
    throw new Error('HYA large-corpus batch size must be a positive safe integer.');
  }
  clearGeneratedCorpus();
  mkdirSync(GENERATED_ROOT, { recursive: true });
  const samples = [];
  const browserSamples = [];

  for (const entry of manifest.entries) {
    const sizeClass = entrySizeClass(entry);
    const sampleIterations = sizeClass === 'large' ? largeIterations : iterations;
    const sampleBatchSize = sizeClass === 'large' ? largeBatchSize : batchSize;
    const sourceAssetPath = entrySourceAssetPath(manifest, entry);
    const sourceBytes = readFileSync(sourceAssetPath);
    const sourceText = sourceBytes.toString('utf8');
    const imageBaseUrl = `${projectUrl(dirname(sourceAssetPath))}/`;
    const fonts = entryFontMappings(manifest, entry);
    const conversionOptions = {
      imageBaseUrl,
      ...(Object.keys(fonts).length > 0 ? { fonts } : {}),
    };
    const conversion = convertLottie(sourceText, conversionOptions);
    const binary = new Uint8Array(encodeAnimationBinary(conversion.document));
    const hyaInput = binary.buffer;
    const hyaPath = generatedHyaPath(entry.id);
    writeFileSync(hyaPath, binary);

    const jsonParse = measureIterations(() => JSON.parse(sourceText), sampleIterations, sampleBatchSize);
    const lottieRuntimeParse = measureIterations(
      () => convertLottie(sourceText, conversionOptions),
      sampleIterations,
      sampleBatchSize,
    );
    const hyaParse = measureIterations(() => parseAnimation(hyaInput), sampleIterations, sampleBatchSize);
    const diagnosticCounts = countDiagnostics(conversion.diagnostics);
    const sourceGzipBytes = gzipSync(sourceBytes, { level: 9 }).byteLength;
    const hyaGzipBytes = gzipSync(binary, { level: 9 }).byteLength;
    const totalLayers = conversion.convertedLayerCount + conversion.skippedLayerCount;
    const layerCoverage = totalLayers === 0 ? 1 : conversion.convertedLayerCount / totalLayers;
    const featureAnalysis = analyzeLottieFeatures(sourceText, conversion.diagnostics, entry.features);
    const { sourceId, source } = entrySource(manifest, entry);
    const externalResourceBytes = (entry.resources ?? []).reduce((total, resource) => total + resource.bytes, 0);

    samples.push({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      sizeClass,
      features: entry.features,
      expectation: entry.expectation,
      provenance: {
        sourceId,
        repository: source.repository,
        revision: source.revision,
        dataLicense: source.dataLicense,
      },
      source: {
        bytes: sourceBytes.byteLength,
        gzipBytes: sourceGzipBytes,
        externalResourceBytes,
        deliveryPayloadBytes: sourceBytes.byteLength + externalResourceBytes,
        sha256: entry.source.sha256,
        url: entrySourceUrl(manifest, entry),
      },
      hya: {
        bytes: binary.byteLength,
        gzipBytes: hyaGzipBytes,
        deliveryPayloadBytes: binary.byteLength + externalResourceBytes,
        sizeRatio: ratio(binary.byteLength, sourceBytes.byteLength),
        gzipSizeRatio: ratio(hyaGzipBytes, sourceGzipBytes),
      },
      parse: {
        iterations: sampleIterations,
        batchSize: sampleBatchSize,
        jsonOnly: jsonParse,
        lottieToRuntime: lottieRuntimeParse,
        hyaToRuntime: hyaParse,
        speedup: ratio(lottieRuntimeParse.medianMs, hyaParse.medianMs),
      },
      conversion: {
        convertedLayerCount: conversion.convertedLayerCount,
        skippedLayerCount: conversion.skippedLayerCount,
        layerCoverage,
        nodeCount: conversion.document.nodes.length,
        trackCount: conversion.document.tracks?.length ?? 0,
        diagnosticCounts,
        diagnostics: conversion.diagnostics,
        status: conversion.skippedLayerCount > 0 || conversion.diagnostics.length > 0 ? 'degraded' : 'clean',
      },
      featureAnalysis,
      delivery: null,
      fidelity: null,
      firstFrame: null,
      frames: entry.frames.map(frame => ({
        frame: frame.frame,
        referenceKind: frame.referenceKind ?? 'after-effects',
        referenceUrl: frame.referenceKind
          ? projectUrl(frameReferenceAssetPath(frame))
          : new URL(frame.referencePath, manifest.source.rawBaseUrl).href,
        metrics: null,
      })),
    });

    browserSamples.push({
      id: entry.id,
      title: entry.title,
      sizeClass,
      width: entry.animation.width,
      height: entry.animation.height,
      frameRate: entry.animation.frameRate,
      inFrame: entry.animation.inFrame,
      sourceUrl: projectUrl(sourceAssetPath),
      hyaUrl: projectUrl(hyaPath),
      externalResourceUrls: (entry.resources ?? []).map(resource => projectUrl(
        entryResourceAssetPath(manifest, entry, resource),
      )),
      externalResources: (entry.resources ?? []).map(resource => ({
        url: projectUrl(entryResourceAssetPath(manifest, entry, resource)),
        bytes: resource.bytes,
        kind: resource.kind ?? 'asset',
      })),
      frames: entry.frames.map(frame => ({
        frame: frame.frame,
        referenceKind: frame.referenceKind ?? 'after-effects',
        referenceUrl: projectUrl(frameReferenceAssetPath(frame)),
      })),
    });
  }

  writeJson(BROWSER_INPUT_PATH, {
    schemaVersion: 2,
    corpus: manifest.corpus,
    assetRoot: projectUrl(ASSET_ROOT),
    samples: browserSamples,
  });
  return samples;
}

function measureIterations(callback, iterations, batchSize) {
  const warmup = Math.min(20, Math.max(5, Math.floor(iterations / 10)));
  for (let index = 0; index < warmup; index++) runBatch(callback, batchSize);
  const values = new Array(iterations);
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    runBatch(callback, batchSize);
    values[index] = (performance.now() - start) / batchSize;
  }
  values.sort((a, b) => a - b);
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: values[0] ?? 0,
    maxMs: values.at(-1) ?? 0,
  };
}

function runBatch(callback, batchSize) {
  for (let index = 0; index < batchSize; index++) benchmarkSink = callback();
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}

function countDiagnostics(diagnostics) {
  const counts = {};
  for (const diagnostic of diagnostics) counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
  return counts;
}

function ratio(value, denominator) {
  return denominator === 0 ? null : value / denominator;
}
