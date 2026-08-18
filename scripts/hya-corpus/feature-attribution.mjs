const LAYER_FEATURES = new Map([
  [0, 'layers/precomp'],
  [1, 'layers/solid'],
  [2, 'layers/image'],
  [3, 'layers/null'],
  [4, 'layers/shape'],
  [5, 'layers/text'],
  [6, 'layers/audio'],
  [15, 'layers/data'],
]);

const SHAPE_FEATURES = new Map([
  ['el', 'shapes/ellipse'],
  ['rc', 'shapes/rectangle'],
  ['sh', 'shapes/path'],
  ['sr', 'shapes/polystar'],
  ['fl', 'styles/fill'],
  ['st', 'styles/stroke'],
  ['gf', 'styles/gradient-fill'],
  ['gs', 'styles/gradient-stroke'],
  ['tm', 'operators/trim-path'],
  ['rp', 'operators/repeater'],
  ['mm', 'operators/merge-path'],
  ['rd', 'operators/round-corners'],
  ['pb', 'operators/pucker-bloat'],
  ['zz', 'operators/zig-zag'],
  ['op', 'operators/offset-path'],
  ['tw', 'operators/twist'],
]);

const DIAGNOSTIC_FEATURES = new Map([
  ['W_LOTTIE_PRECOMP', 'layers/precomp'],
  ['W_LOTTIE_MISSING_PARENT', 'layers/parent'],
  ['W_LOTTIE_MISSING_IMAGE', 'layers/image'],
  ['W_LOTTIE_MISSING_AUDIO', 'layers/audio'],
  ['W_LOTTIE_INVALID_TEXT', 'layers/text'],
  ['W_LOTTIE_ANIMATED_TEXT', 'animation/text-document'],
  ['W_LOTTIE_TEXT_DOCUMENT_TIME', 'animation/text-document'],
  ['W_LOTTIE_TEXT_SELECTOR', 'animation/text-selector'],
  ['W_LOTTIE_TEXT_EXPRESSION', 'expressions/text-document'],
  ['W_LOTTIE_MISSING_DATA', 'layers/data'],
  ['W_LOTTIE_FONT_SUBSTITUTION', 'text/font-substitution'],
  ['W_LOTTIE_3D_LAYER', 'transforms/3d'],
  ['W_LOTTIE_BLEND_MODE', 'styles/layer-blend-mode'],
  ['W_LOTTIE_AUTO_ORIENT', 'transforms/auto-orient'],
  ['W_LOTTIE_SPATIAL_POSITION', 'animation/spatial-position'],
  ['W_LOTTIE_LAYER_SKEW', 'transforms/layer-skew'],
  ['W_LOTTIE_TIME_REMAP', 'timing/time-remap'],
  ['W_LOTTIE_TIME_STRETCH', 'timing/time-stretch'],
  ['W_LOTTIE_EFFECT', 'effects/layer-effect'],
  ['W_LOTTIE_EFFECT_PARAM', 'effects/layer-effect'],
  ['W_LOTTIE_SPLIT_POSITION', 'transforms/split-position'],
  ['W_LOTTIE_ANIMATED_ANCHOR', 'animation/anchor'],
  ['W_LOTTIE_GROUP_SKEW', 'transforms/group-skew'],
  ['W_LOTTIE_ANIMATED_ROUNDED_RECT', 'animation/rounded-rectangle'],
  ['W_LOTTIE_ROUNDED_RECT', 'shapes/rounded-rectangle'],
  ['W_LOTTIE_INVALID_POLYSTAR', 'shapes/polystar'],
  ['W_LOTTIE_ANIMATED_POLYSTAR_GEOMETRY', 'animation/polystar-geometry'],
  ['W_LOTTIE_POLYSTAR_ROUNDNESS', 'shapes/polystar-roundness'],
  ['W_LOTTIE_ANIMATED_POLYSTAR_ROUNDNESS', 'animation/polystar-roundness'],
  ['W_LOTTIE_INVALID_STROKE', 'styles/stroke'],
  ['W_LOTTIE_ANIMATED_STROKE', 'animation/stroke'],
  ['W_LOTTIE_STROKE_DASH', 'styles/stroke-dash'],
  ['W_LOTTIE_ANIMATED_STROKE_DASH', 'animation/stroke-dash'],
  ['W_LOTTIE_GRADIENT_STOP_LIMIT', 'styles/gradient-stop-budget'],
  ['W_LOTTIE_GRADIENT_HIGHLIGHT', 'styles/radial-gradient-highlight'],
  ['W_LOTTIE_ANIMATED_FILL', 'animation/fill'],
  ['W_LOTTIE_ANIMATED_PATH', 'animation/path'],
  ['W_LOTTIE_PATH_TOPOLOGY', 'animation/path-topology'],
  ['W_LOTTIE_ANIMATED_MERGE_PATH', 'operators/merge-path'],
  ['W_LOTTIE_MERGE_PATH_INPUT', 'operators/merge-path'],
  ['W_LOTTIE_MERGE_PATH_GEOMETRY', 'operators/merge-path'],
  ['W_LOTTIE_OPEN_FILLED_PATH', 'shapes/open-path'],
  ['W_LOTTIE_INVALID_PATH', 'shapes/path'],
  ['W_LOTTIE_INVALID_SHAPE_SIZE', 'shapes/primitive-size'],
  ['W_LOTTIE_MASK_MODE', 'composites/mask-mode'],
  ['W_LOTTIE_MULTI_INVERTED_MASK', 'composites/mask-inversion'],
  ['W_LOTTIE_ANIMATED_MASK_OPACITY', 'animation/mask-opacity'],
  ['W_LOTTIE_MASK_FEATHER', 'composites/mask-feather'],
  ['W_LOTTIE_ANIMATED_MASK_FEATHER', 'animation/mask-feather'],
  ['W_LOTTIE_ANIMATED_MASK_EXPANSION', 'animation/mask-expansion'],
  ['W_LOTTIE_COMPOSITE_LIMIT', 'composites/stack-budget'],
  ['W_LOTTIE_UNSUPPORTED_MATTE', 'composites/matte'],
  ['W_LOTTIE_COMBINED_MASK_MATTE', 'composites/mask-matte'],
  ['W_LOTTIE_NESTED_COMPOSITE', 'composites/nested'],
  ['W_LOTTIE_LUMA_MATTE', 'composites/luma-matte'],
  ['W_LOTTIE_MISSING_MATTE_SOURCE', 'composites/matte'],
  ['W_LOTTIE_EMPTY_SHAPE', 'conversion/no-renderable-shape'],
]);

const UNSUPPORTED_DIAGNOSTICS = new Set([
  'W_LOTTIE_PRECOMP',
  'W_LOTTIE_UNSUPPORTED_LAYER',
  'W_LOTTIE_UNSUPPORTED_SHAPE',
  'W_LOTTIE_EMPTY_SHAPE',
  'W_LOTTIE_MISSING_IMAGE',
  'W_LOTTIE_MISSING_AUDIO',
  'W_LOTTIE_MISSING_DATA',
  'W_LOTTIE_TEXT_EXPRESSION',
  'W_LOTTIE_INVALID_TEXT',
  'W_LOTTIE_INVALID_PATH',
  'W_LOTTIE_INVALID_SHAPE_SIZE',
  'W_LOTTIE_INVALID_POLYSTAR',
  'W_LOTTIE_INVALID_STROKE',
  'W_LOTTIE_MERGE_PATH_INPUT',
  'W_LOTTIE_MERGE_PATH_GEOMETRY',
  'W_LOTTIE_MISSING_MATTE_SOURCE',
  'W_LOTTIE_NESTED_COMPOSITE',
  'W_LOTTIE_TIME_REMAP',
  'W_LOTTIE_EFFECT',
  'W_LOTTIE_BLEND_MODE',
  'W_LOTTIE_AUTO_ORIENT',
  'W_LOTTIE_SPATIAL_POSITION',
  'W_LOTTIE_LAYER_SKEW',
  'W_LOTTIE_GRADIENT_HIGHLIGHT',
  'W_LOTTIE_COMPOSITE_LIMIT',
  'W_LOTTIE_UNSUPPORTED_MATTE',
]);

const HIGH_IMPACT_DIAGNOSTICS = new Set([
  ...UNSUPPORTED_DIAGNOSTICS,
  'W_LOTTIE_LUMA_MATTE',
  'W_LOTTIE_COMBINED_MASK_MATTE',
]);

/** Builds a deterministic feature inventory and assigns every converter diagnostic to one feature. */
export function analyzeLottieFeatures(source, diagnostics, declaredFeatures = []) {
  const root = typeof source === 'string' ? JSON.parse(source) : source;
  const occurrences = new Map();
  scanRoot(asObject(root), occurrences);
  const failures = diagnostics.map(diagnostic => classifyDiagnostic(diagnostic, occurrences));
  const failuresByFeature = groupBy(failures, failure => failure.feature);
  // Manifest declarations also describe capabilities whose implementation is
  // intentionally silent when successful (for example topology repair and
  // composite stack decomposition). Keep them in the support snapshot even
  // after their former diagnostics reach zero.
  const featureIds = new Set([...occurrences.keys(), ...failuresByFeature.keys(), ...declaredFeatures]);
  const features = [...featureIds].sort().map(feature => {
    const featureFailures = failuresByFeature.get(feature) ?? [];
    const unsupported = featureFailures.some(failure => failure.support === 'unsupported');
    return {
      feature,
      declared: declaredFeatures.includes(feature),
      occurrences: occurrences.get(feature)?.length ?? 0,
      paths: occurrences.get(feature) ?? [],
      status: unsupported ? 'unsupported' : featureFailures.length > 0 ? 'partial' : 'full',
      failureCount: featureFailures.length,
      diagnosticCodes: [...new Set(featureFailures.map(failure => failure.code))].sort(),
      failures: featureFailures,
    };
  });
  const primaryFailure = failures.length === 0 ? null : [...failures].sort(compareFailurePriority)[0];
  return {
    declaredFeatures: [...declaredFeatures],
    detectedFeatureCount: occurrences.size,
    failedFeatureCount: features.filter(feature => feature.failureCount > 0).length,
    unclassifiedFailureCount: failures.filter(failure => failure.feature === 'conversion/unclassified').length,
    primaryFailure,
    features,
  };
}

/** Aggregates feature health. Fidelity loss is observational correlation, not causal attribution. */
export function summarizeFeatureAttribution(samples) {
  const records = new Map();
  for (const sample of samples) {
    for (const feature of sample.featureAnalysis.features) {
      let record = records.get(feature.feature);
      if (!record) {
        record = {
          feature: feature.feature,
          sampleCount: 0,
          occurrenceCount: 0,
          affectedSampleCount: 0,
          unsupportedSampleCount: 0,
          failureCount: 0,
          fidelityScores: [],
          diagnosticCodes: new Set(),
        };
        records.set(feature.feature, record);
      }
      record.sampleCount++;
      record.occurrenceCount += feature.occurrences;
      record.failureCount += feature.failureCount;
      if (feature.failureCount > 0) record.affectedSampleCount++;
      if (feature.status === 'unsupported') record.unsupportedSampleCount++;
      if (Number.isFinite(sample.fidelity?.score)) record.fidelityScores.push(sample.fidelity.score);
      for (const code of feature.diagnosticCodes) record.diagnosticCodes.add(code);
    }
  }
  return [...records.values()].map(record => ({
    feature: record.feature,
    status: record.unsupportedSampleCount > 0 ? 'unsupported' : record.affectedSampleCount > 0 ? 'partial' : 'full',
    sampleCount: record.sampleCount,
    occurrenceCount: record.occurrenceCount,
    affectedSampleCount: record.affectedSampleCount,
    unsupportedSampleCount: record.unsupportedSampleCount,
    failureCount: record.failureCount,
    cleanSampleRatio: record.sampleCount === 0 ? 1 : 1 - record.affectedSampleCount / record.sampleCount,
    averageFidelity: average(record.fidelityScores),
    observedFidelityLoss: average(record.fidelityScores.map(score => 1 - score)),
    diagnosticCodes: [...record.diagnosticCodes].sort(),
  })).sort((a, b) => {
    const status = { unsupported: 0, partial: 1, full: 2 };
    return status[a.status] - status[b.status]
      || b.affectedSampleCount - a.affectedSampleCount
      || (b.observedFidelityLoss ?? -1) - (a.observedFidelityLoss ?? -1)
      || a.feature.localeCompare(b.feature);
  });
}

function scanRoot(root, occurrences) {
  if (asList(asObject(root.fonts).list).length > 0) addOccurrence(occurrences, 'text/font-resource', '$.fonts.list');
  const assets = asList(root.assets);
  for (let index = 0; index < assets.length; index++) {
    const asset = asObject(assets[index]);
    if (!Array.isArray(asset.layers)) continue;
    addOccurrence(occurrences, 'layers/precomp', `$.assets[${index}]`);
    for (let layerIndex = 0; layerIndex < asset.layers.length; layerIndex++) {
      scanLayer(asObject(asset.layers[layerIndex]), `$.assets[${index}].layers[${layerIndex}]`, occurrences);
    }
  }
  const layers = asList(root.layers);
  for (let index = 0; index < layers.length; index++) scanLayer(asObject(layers[index]), `$.layers[${index}]`, occurrences);
}

function scanLayer(layer, path, occurrences) {
  addOccurrence(occurrences, LAYER_FEATURES.get(layer.ty) ?? 'layers/unknown', path);
  if (layer.parent !== undefined) addOccurrence(occurrences, 'layers/parent', `${path}.parent`);
  if (layer.ddd === 1) addOccurrence(occurrences, 'transforms/3d', `${path}.ddd`);
  if (typeof layer.bm === 'number' && layer.bm !== 0) addOccurrence(occurrences, 'styles/layer-blend-mode', `${path}.bm`);
  if (layer.ao === 1) addOccurrence(occurrences, 'transforms/auto-orient', `${path}.ao`);
  if (layer.tm !== undefined) addOccurrence(occurrences, 'timing/time-remap', `${path}.tm`);
  if (typeof layer.sr === 'number' && layer.sr !== 1) addOccurrence(occurrences, 'timing/time-stretch', `${path}.sr`);
  scanEffects(asList(layer.ef), `${path}.ef`, occurrences);
  const masks = asList(layer.masksProperties);
  if (masks.length > 0) addOccurrence(occurrences, 'composites/mask', `${path}.masksProperties`);
  for (let index = 0; index < masks.length; index++) {
    const mask = asObject(masks[index]);
    if (mask.inv === true) addOccurrence(occurrences, 'composites/mask-inversion', `${path}.masksProperties[${index}].inv`);
    if (mask.mode !== undefined && mask.mode !== 'a' && mask.mode !== 'n') addOccurrence(occurrences, 'composites/mask-mode', `${path}.masksProperties[${index}].mode`);
    if (isAnimated(mask.o)) addOccurrence(occurrences, 'animation/mask-opacity', `${path}.masksProperties[${index}].o`);
    if (mask.f !== undefined) addOccurrence(occurrences, 'composites/mask-feather', `${path}.masksProperties[${index}].f`);
    if (mask.x !== undefined) addOccurrence(occurrences, 'composites/mask-expansion', `${path}.masksProperties[${index}].x`);
  }
  if (typeof layer.tt === 'number' && layer.tt !== 0) {
    addOccurrence(occurrences, layer.tt === 1 || layer.tt === 2 ? 'composites/matte' : 'composites/luma-matte', `${path}.tt`);
  }
  scanTransform(asObject(layer.ks), `${path}.ks`, 'layer', occurrences);
  scanShapeList(asList(layer.shapes), `${path}.shapes`, occurrences);
  const textKeys = asList(asObject(asObject(layer.t).d).k);
  if (textKeys.length > 1) addOccurrence(occurrences, 'animation/text-document', `${path}.t.d.k`);
  if (typeof asObject(asObject(layer.t).d).x === 'string') addOccurrence(occurrences, 'expressions/text-document', `${path}.t.d.x`);
  const textAnimators = asList(asObject(layer.t).a);
  if (textAnimators.length > 0) addOccurrence(occurrences, 'animation/text-animator', `${path}.t.a`);
  for (let index = 0; index < textAnimators.length; index++) {
    addOccurrence(occurrences, 'animation/text-selector', `${path}.t.a[${index}].s`);
  }
}

function scanEffects(effects, path, occurrences) {
  if (effects.length === 0) return;
  addOccurrence(occurrences, 'effects/layer-effect', path);
  for (let index = 0; index < effects.length; index++) {
    const effect = asObject(effects[index]);
    const name = `${String(effect.mn ?? '')} ${String(effect.nm ?? '')}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const feature = name.includes('tint') || effect.ty === 20 ? 'effects/tint'
      : name.includes('drop shadow') || effect.ty === 25 ? 'effects/drop-shadow'
      : name.includes('gaussian blur') || name.includes('fast blur') || effect.ty === 29 ? 'effects/blur'
      : name.includes('color matrix') ? 'effects/color-matrix'
      : name.includes('opacity') ? 'effects/opacity'
      : name.includes('fill') || effect.ty === 21 ? 'effects/fill'
      : 'effects/layer-effect';
    addOccurrence(occurrences, feature, `${path}[${index}]`);
  }
}

function scanShapeList(shapes, path, occurrences) {
  for (let index = 0; index < shapes.length; index++) {
    const shape = asObject(shapes[index]);
    const shapePath = `${path}[${index}]`;
    if (shape.hd === true) continue;
    if (shape.ty === 'gr') {
      addOccurrence(occurrences, 'shapes/group', shapePath);
      const items = asList(shape.it);
      const transformIndex = items.findIndex(item => asObject(item).ty === 'tr');
      if (transformIndex >= 0) {
        const transformPath = `${shapePath}.it[${transformIndex}]`;
        addOccurrence(occurrences, 'transforms/group', transformPath);
        scanTransform(asObject(items[transformIndex]), transformPath, 'group', occurrences);
      }
      scanShapeList(items, `${shapePath}.it`, occurrences);
      continue;
    }
    if (shape.ty === 'tr') continue;
    const feature = SHAPE_FEATURES.get(shape.ty) ?? `operators/${String(shape.ty ?? 'unknown')}`;
    addOccurrence(occurrences, feature, shapePath);
    if (shape.ty === 'sh') {
      if (isAnimated(shape.ks)) addOccurrence(occurrences, 'animation/path', `${shapePath}.ks`);
      const staticShape = readStaticShape(shape.ks);
      if (staticShape.c === false) addOccurrence(occurrences, 'shapes/open-path', `${shapePath}.ks`);
    }
    if (shape.ty === 'rc') {
      addOccurrence(occurrences, 'shapes/primitive-size', `${shapePath}.s`);
      if (isAnimated(shape.p)) addOccurrence(occurrences, 'animation/shape-position', `${shapePath}.p`);
      if (isAnimated(shape.s)) addOccurrence(occurrences, 'animation/shape-size', `${shapePath}.s`);
      if (isAnimated(shape.r) || Math.abs(readStaticScalar(shape.r, 0)) > 1e-6) addOccurrence(occurrences, 'shapes/rounded-rectangle', `${shapePath}.r`);
    }
    if (shape.ty === 'el') {
      addOccurrence(occurrences, 'shapes/primitive-size', `${shapePath}.s`);
      if (isAnimated(shape.p)) addOccurrence(occurrences, 'animation/shape-position', `${shapePath}.p`);
      if (isAnimated(shape.s)) addOccurrence(occurrences, 'animation/shape-size', `${shapePath}.s`);
    }
    if (shape.ty === 'sr') {
      addOccurrence(occurrences, shape.sy === 2 ? 'shapes/polygon' : 'shapes/star', shapePath);
      if ([shape.pt, shape.or, shape.ir].some(isAnimated)) addOccurrence(occurrences, 'animation/polystar-geometry', shapePath);
      if (isAnimated(shape.is) || isAnimated(shape.os)
        || Math.abs(readStaticScalar(shape.is, 0)) > 1e-6
        || Math.abs(readStaticScalar(shape.os, 0)) > 1e-6) addOccurrence(occurrences, 'shapes/polystar-roundness', shapePath);
      if (isAnimated(shape.p)) addOccurrence(occurrences, 'animation/shape-position', `${shapePath}.p`);
      if (isAnimated(shape.r)) addOccurrence(occurrences, 'animation/shape-rotation', `${shapePath}.r`);
    }
    if (shape.ty === 'fl' && (isAnimated(shape.c) || isAnimated(shape.o))) addOccurrence(occurrences, 'animation/fill', shapePath);
    if (shape.ty === 'gf' || shape.ty === 'gs') {
      const pointCount = Number(asObject(shape.g).p ?? 0);
      if (pointCount > 8) addOccurrence(occurrences, 'styles/gradient-stop-budget', `${shapePath}.g.p`);
      if (shape.t === 2 && (isAnimated(shape.h) || isAnimated(shape.a)
        || Math.abs(readStaticScalar(shape.h, 0)) > 1e-6
        || Math.abs(readStaticScalar(shape.a, 0)) > 1e-6)) addOccurrence(occurrences, 'styles/radial-gradient-highlight', shapePath);
    }
    if (shape.ty === 'st') {
      if (isAnimated(shape.c) || isAnimated(shape.o) || isAnimated(shape.w)) addOccurrence(occurrences, 'animation/stroke', shapePath);
      if (asList(shape.d).length > 0) addOccurrence(occurrences, 'styles/stroke-dash', `${shapePath}.d`);
    }
  }
}

function scanTransform(transform, path, scope, occurrences) {
  const position = asObject(transform.p);
  if (position.s === true || position.x !== undefined || position.y !== undefined) addOccurrence(occurrences, 'transforms/split-position', `${path}.p`);
  if (isAnimated(position) && asList(position.k).some(keyframe => asObject(keyframe).to !== undefined || asObject(keyframe).ti !== undefined)) {
    addOccurrence(occurrences, 'animation/spatial-position', `${path}.p.k`);
  }
  for (const [property, value] of [['position', transform.p], ['scale', transform.s], ['rotation', transform.r ?? transform.rz], ['opacity', transform.o], ['anchor', transform.a]]) {
    if (isAnimated(value)) addOccurrence(occurrences, `animation/${scope}-${property}`, `${path}.${property === 'rotation' ? 'r' : property[0]}`);
  }
  if (scope === 'group' && (isAnimated(transform.sk) || isAnimated(transform.sa)
    || Math.abs(readStaticScalar(transform.sk, 0)) > 1e-6
    || Math.abs(readStaticScalar(transform.sa, 0)) > 1e-6)) addOccurrence(occurrences, 'transforms/group-skew', path);
  if (scope === 'layer' && (isAnimated(transform.sk) || isAnimated(transform.sa)
    || Math.abs(readStaticScalar(transform.sk, 0)) > 1e-6
    || Math.abs(readStaticScalar(transform.sa, 0)) > 1e-6)) addOccurrence(occurrences, 'transforms/layer-skew', path);
}

function classifyDiagnostic(diagnostic, occurrences) {
  let feature = DIAGNOSTIC_FEATURES.get(diagnostic.code);
  if (!feature) feature = closestFeature(diagnostic.path, occurrences);
  if (!feature && diagnostic.code === 'W_LOTTIE_UNSUPPORTED_LAYER') feature = 'layers/unknown';
  if (!feature) feature = 'conversion/unclassified';
  const support = UNSUPPORTED_DIAGNOSTICS.has(diagnostic.code) ? 'unsupported' : 'partial';
  const impact = diagnostic.code === 'W_LOTTIE_EMPTY_SHAPE' ? 'low'
    : HIGH_IMPACT_DIAGNOSTICS.has(diagnostic.code) ? 'high'
    : diagnostic.code.startsWith('W_LOTTIE_ANIMATED_') || diagnostic.code.includes('OPEN_FILLED') ? 'medium' : 'low';
  return {
    feature,
    support,
    impact,
    severity: diagnostic.severity,
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
  };
}

function closestFeature(path, occurrences) {
  let best = null;
  let bestLength = -1;
  for (const [feature, paths] of occurrences) {
    for (const occurrencePath of paths) {
      if ((path.startsWith(occurrencePath) || occurrencePath.startsWith(path)) && occurrencePath.length > bestLength) {
        best = feature;
        bestLength = occurrencePath.length;
      }
    }
  }
  return best;
}

function compareFailurePriority(a, b) {
  const impact = { high: 0, medium: 1, low: 2 };
  const support = { unsupported: 0, partial: 1 };
  return impact[a.impact] - impact[b.impact]
    || support[a.support] - support[b.support]
    || a.feature.localeCompare(b.feature)
    || a.code.localeCompare(b.code);
}

function addOccurrence(occurrences, feature, path) {
  const paths = occurrences.get(feature) ?? [];
  if (!paths.includes(path)) paths.push(path);
  occurrences.set(feature, paths);
}

function groupBy(values, selector) {
  const grouped = new Map();
  for (const value of values) {
    const key = selector(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function readStaticShape(value) {
  const property = asObject(value);
  if (property.a === 1) {
    const first = asObject(asList(property.k)[0]);
    const start = asList(first.s)[0];
    return asObject(start ?? first.s);
  }
  return asObject(property.k ?? value);
}

function readStaticScalar(value, fallback) {
  const property = asObject(value);
  const raw = property.a === 1 ? asObject(asList(property.k)[0]).s : property.k;
  const values = numberList(raw);
  return values[0] ?? fallback;
}

function isAnimated(value) {
  const property = asObject(value);
  return property.a === 1 && Array.isArray(property.k);
}

function numberList(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (!Array.isArray(value)) return [];
  const flattened = value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
  return flattened.filter(item => typeof item === 'number' && Number.isFinite(item));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
