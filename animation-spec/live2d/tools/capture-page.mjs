const resultNode = document.querySelector('#result');
const progress = document.querySelector('#progress');

void capture().then(captureResult => {
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify({ status: 'passed', capture: captureResult });
}).catch(error => {
  console.error(error);
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
});

async function capture() {
  const query = new URLSearchParams(location.search);
  const modelUri = required(query, 'model');
  const coreUri = query.get('core') ?? './live2dcubismcore.min.js';
  const motionUri = query.get('motion');
  const expressionUri = query.get('expression');
  const physicsUri = query.get('physics');
  const poseUri = query.get('pose');
  const frameworkRequested = query.get('framework') === '1';
  const constantInputs = parseConstantInputs(query.get('constants'));
  const requestedFrameRate = positive(query.get('fps') ?? '30', 'fps');
  progress.textContent = 'loading Cubism Core';
  const coreProvenance = await loadVerifiedScript(coreUri);
  const core = globalThis.Live2DCubismCore;
  if (!core?.Moc || !core?.Model) throw new Error('The supplied script did not expose Live2DCubismCore.Moc/Model.');
  const modelUrl = new URL(modelUri, location.href);
  const model3 = await fetchJson(modelUrl);
  const references = model3.FileReferences;
  if (!references?.Moc || !Array.isArray(references.Textures)) throw new Error('model3.json requires FileReferences.Moc and Textures.');
  const mocBuffer = await fetch(new URL(references.Moc, modelUrl)).then(requireOk).then(response => response.arrayBuffer());
  const motionAsset = motionUri ? await fetchJsonAsset(new URL(motionUri, location.href), 'motion3') : null;
  const expressionAsset = expressionUri ? await fetchJsonAsset(new URL(expressionUri, location.href), 'exp3') : null;
  const physicsAsset = physicsUri ? await fetchJsonAsset(new URL(physicsUri, location.href), 'physics3') : null;
  const poseAsset = poseUri ? await fetchJsonAsset(new URL(poseUri, location.href), 'pose3') : null;
  if (expressionAsset) validateExpression(expressionAsset.json);
  if (physicsAsset) validatePhysics(physicsAsset.json);
  if (poseAsset) validatePose(poseAsset.json);
  const duration = motionAsset?.json?.Meta?.Duration ?? positive(query.get('duration') ?? '1', 'duration');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Motion duration must be positive.');
  const stepCount = Math.max(1, Math.ceil(duration * requestedFrameRate));
  const frameRate = stepCount / duration;
  const evaluation = frameworkRequested
    ? await createFrameworkEvaluation(mocBuffer, model3, motionAsset, expressionAsset, physicsAsset, poseAsset)
    : createCoreEvaluation(core, mocBuffer, motionAsset?.json ?? null);
  if ((expressionAsset || physicsAsset || poseAsset) && evaluation.kind !== 'framework') throw new Error('Expression, Physics, and Pose require the official Cubism Framework evaluator.');
  const model = evaluation.coreModel;
  const parameterDefaults = Float32Array.from(model.parameters.defaultValues);
  const partDefaults = Float32Array.from(model.parts.opacities);
  const parameterIndex = new Map(Array.from(model.parameters.ids, (id, index) => [String(id), index]));
  const partIndex = new Map(Array.from(model.parts.ids, (id, index) => [String(id), index]));
  const canvas = model.canvasinfo;
  const frames = [];
  progress.textContent = `capturing ${stepCount + 1} frames`;
  for (let frame = 0; frame <= stepCount; frame++) {
    const time = duration * frame / stepCount;
    model.parameters.values.set(parameterDefaults);
    model.parts.opacities.set(partDefaults);
    const sampleTime = motionAsset?.json?.Meta?.Loop && time === duration ? 0 : time;
    const deltaTime = frame === 0 ? 0 : duration / stepCount;
    const modelOpacity = evaluation.apply({ time: sampleTime, deltaTime, parameterIndex, partIndex, constantInputs });
    frames.push({ time, drawables: captureDrawables(core, model, modelOpacity, canvas) });
  }
  const pixelsPerUnit = Number(canvas.PixelsPerUnit);
  const captureResult = {
    format: 'live2d-cubism-drawable-capture', version: 1,
    name: model3.Name ?? model3.name ?? 'Cubism model',
    source: {
      kind: evaluation.kind === 'framework' ? 'cubism-framework-capture' : 'cubism-core-capture',
      model: modelUri, motion: motionUri ?? null, expression: expressionUri ?? null, physics: physicsUri ?? null, pose: poseUri ?? null,
      coreVersion: String(core.Version?.csmGetVersion?.() ?? 'unknown'), coreProvenance, frameworkVersion: evaluation.frameworkVersion,
      recipeAssets: Object.fromEntries([motionAsset, expressionAsset, physicsAsset, poseAsset].filter(Boolean).map(asset => [asset.kind, asset.provenance])),
      updateOrder: ['reset-defaults', 'motion', 'expression', 'constant-inputs', 'physics', 'pose', 'model-update'],
    },
    capabilities: {
      motion: Boolean(motionAsset), expression: evaluation.executed.expression, physics: evaluation.executed.physics, pose: evaluation.executed.pose,
      drawableColors: model.drawables.multiplyColors && model.drawables.screenColors ? 'captured' : 'unavailable',
    },
    canvas: { width: Number(canvas.CanvasWidth), height: Number(canvas.CanvasHeight), pixelsPerUnit, coordinateSystem: 'model-y-up', uvOrigin: 'bottom-left' },
    duration, frameRate,
    textures: references.Textures.map((uri, index) => ({ id: `texture-${index}`, uri })),
    frames,
  };
  evaluation.close();
  progress.textContent = 'complete';
  return captureResult;
}

function createCoreEvaluation(core, mocBuffer, motion) {
  const moc = core.Moc.fromArrayBuffer(mocBuffer);
  if (!moc) throw new Error('Cubism Core rejected the .moc3 payload.');
  const model = core.Model.fromMoc(moc);
  if (!model) { moc.release?.(); throw new Error('Cubism Core could not create a model from the .moc3 payload.'); }
  return {
    kind: 'core', frameworkVersion: null, coreModel: model,
    executed: { expression: false, physics: false, pose: false },
    apply({ time, parameterIndex, partIndex, constantInputs }) {
      let modelOpacity = 1;
      if (motion) for (const curve of motion.Curves ?? []) {
        const value = sampleSegments(curve.Segments, time);
        if (curve.Target === 'Parameter') { const index = parameterIndex.get(curve.Id); if (index !== undefined) model.parameters.values[index] = value; }
        else if (curve.Target === 'PartOpacity') { const index = partIndex.get(curve.Id); if (index !== undefined) model.parts.opacities[index] = value; }
        else if (curve.Target === 'Model' && curve.Id === 'Opacity') modelOpacity = value;
      }
      applyConstantInputs(model, parameterIndex, constantInputs);
      model.update();
      return modelOpacity;
    },
    close() { model.release?.(); moc.release?.(); },
  };
}

async function createFrameworkEvaluation(mocBuffer, model3, motionAsset, expressionAsset, physicsAsset, poseAsset) {
  await import('./framework-evaluator.js');
  const framework = globalThis.__HYA_CUBISM_FRAMEWORK__;
  if (!framework?.CubismFramework || !framework?.CubismMoc) throw new Error('The supplied official Framework bundle did not expose the evaluator API.');
  framework.CubismFramework.startUp();
  framework.CubismFramework.initialize();
  const moc = framework.CubismMoc.create(mocBuffer, false);
  if (!moc) throw new Error('Official Cubism Framework rejected the .moc3 payload.');
  const model = moc.createModel();
  if (!model) { moc.release(); throw new Error('Official Cubism Framework could not create a model.'); }
  const coreModel = model.getModel();
  model.saveParameters();
  const motion = motionAsset ? framework.CubismMotion.create(motionAsset.buffer, motionAsset.buffer.byteLength) : null;
  const expression = expressionAsset ? framework.CubismExpressionMotion.create(expressionAsset.buffer, expressionAsset.buffer.byteLength) : null;
  const physics = physicsAsset ? framework.CubismPhysics.create(physicsAsset.buffer, physicsAsset.buffer.byteLength) : null;
  const pose = poseAsset ? framework.CubismPose.create(poseAsset.buffer, poseAsset.buffer.byteLength) : null;
  if (motionAsset && !motion) throw new Error('Official Cubism Framework rejected motion3.json.');
  if (expressionAsset && !expression) throw new Error('Official Cubism Framework rejected exp3.json.');
  if (physicsAsset && !physics) throw new Error('Official Cubism Framework rejected physics3.json.');
  if (poseAsset && !pose) throw new Error('Official Cubism Framework rejected pose3.json.');
  if (motion?.setEffectIds) {
    const groups = Array.isArray(model3.Groups) ? model3.Groups : [];
    motion.setEffectIds(
      createFrameworkIdList(framework, groups.find(group => group?.Target === 'Parameter' && group?.Name === 'EyeBlink')?.Ids),
      createFrameworkIdList(framework, groups.find(group => group?.Target === 'Parameter' && group?.Name === 'LipSync')?.Ids),
    );
  }
  const motionQueue = motion ? new framework.CubismMotionQueueManager() : null;
  const expressionQueue = expression ? new framework.CubismMotionQueueManager() : null;
  if (motionQueue) { motionQueue.setEventCallback(() => {}); motionQueue.startMotion(motion, false, 0); }
  if (expressionQueue) { expressionQueue.setEventCallback(() => {}); expressionQueue.startMotion(expression, false, 0); }
  return {
    kind: 'framework', frameworkVersion: framework.version, coreModel,
    executed: { expression: Boolean(expression), physics: Boolean(physics), pose: Boolean(pose) },
    apply({ time, deltaTime, parameterIndex, constantInputs }) {
      model.loadParameters();
      coreModel.parts.opacities.set(partDefaultsFor(model));
      model.setModelOapcity?.(1);
      motionQueue?.doUpdateMotion(model, time);
      expressionQueue?.doUpdateMotion(model, time);
      applyConstantInputs(coreModel, parameterIndex, constantInputs);
      physics?.evaluate(model, deltaTime);
      pose?.updateParameters(model, deltaTime);
      model.update();
      return Number(model.getModelOapcity?.() ?? 1);
    },
    close() {
      motionQueue?.release(); expressionQueue?.release();
      framework.CubismPhysics.delete?.(physics); framework.CubismPose.delete?.(pose);
      moc.deleteModel(model); moc.release();
      if (typeof framework.CubismRenderer?.staticRelease !== 'function') framework.CubismRenderer.staticRelease = () => {};
      framework.CubismFramework.dispose(); framework.CubismFramework.cleanUp?.();
    },
  };
}

function createFrameworkIdList(framework, ids) {
  const values = (Array.isArray(ids) ? ids : []).map(id => framework.CubismFramework.getIdManager().getId(String(id)));
  // R4 uses csmVector while R5 uses Array. This structural list deliberately
  // supports both official APIs without importing Framework container types.
  values.getSize = () => values.length;
  values.at = index => values[index];
  return values;
}

const partDefaultCache = new WeakMap();
function partDefaultsFor(model) { let value = partDefaultCache.get(model); if (!value) { value = Float32Array.from(model.getModel().parts.opacities); partDefaultCache.set(model, value); } return value; }
function applyConstantInputs(model, parameterIndex, inputs) { for (const input of inputs) { const index = parameterIndex.get(input.id); if (index === undefined) throw new Error(`Constant input references unknown parameter ${input.id}.`); model.parameters.values[index] = input.value; } }

function captureDrawables(core, model, modelOpacity, canvas) {
  const drawables = model.drawables;
  const ids = Array.from(drawables.ids, String);
  return ids.map((id, index) => {
    const constantFlags = drawables.constantFlags[index];
    const masks = coreDrawableMaskIds(drawables, ids, index);
    const blendMode = core.Utils.hasBlendAdditiveBit(constantFlags) ? 'additive' : core.Utils.hasBlendMultiplicativeBit(constantFlags) ? 'multiplicative' : 'normal';
    const invertedMask = typeof core.Utils.hasIsInvertedMaskBit === 'function'
      && core.Utils.hasIsInvertedMaskBit(constantFlags);
    return {
      id, textureIndex: drawables.textureIndices[index], renderOrder: drawables.renderOrders[index],
      opacity: drawables.opacities[index] * modelOpacity, blendMode,
      culling: !core.Utils.hasIsDoubleSidedBit(constantFlags), masks, invertedMask,
      positions: centerCorePositions(drawables.vertexPositions[index], canvas), uvs: Array.from(drawables.vertexUvs[index]), indices: Array.from(drawables.indices[index]),
      multiplyColor: colorAt(drawables.multiplyColors, index, [1, 1, 1, 1]),
      screenColor: colorAt(drawables.screenColors, index, [0, 0, 0, 0]),
    };
  });
}

function coreDrawableMaskIds(drawables, ids, drawableIndex) {
  const source = drawables.masks[drawableIndex] ?? [];
  // Cubism Core publishes the semantic count separately. Do not consume stale
  // values that can remain in the backing mask-index view beyond this count.
  const count = Number(drawables.maskCounts?.[drawableIndex] ?? source.length);
  if (!Number.isInteger(count) || count < 0 || count > source.length) {
    throw new Error(`Cubism drawable ${drawableIndex} has an invalid mask count ${count}.`);
  }
  return Array.from({ length: count }, (_, index) => ids[Number(source[index])]);
}

function centerCorePositions(source, canvas) {
  const positions = Array.from(source);
  const pixelsPerUnit = Number(canvas.PixelsPerUnit);
  const offsetX = (Number(canvas.CanvasOriginX) - Number(canvas.CanvasWidth) / 2) / pixelsPerUnit;
  const offsetY = (Number(canvas.CanvasHeight) / 2 - Number(canvas.CanvasOriginY)) / pixelsPerUnit;
  for (let index = 0; index < positions.length; index += 2) {
    positions[index] += offsetX;
    positions[index + 1] += offsetY;
  }
  return positions;
}

function colorAt(colors, index, fallback) {
  if (!colors) return fallback;
  const nested = colors[index];
  if (nested && typeof nested !== 'number') return Array.from(nested);
  return Array.from(colors.slice(index * 4, index * 4 + 4));
}

function sampleSegments(values, time) {
  if (!Array.isArray(values) || values.length < 2) throw new Error('Motion3 curve segments are invalid.');
  let startTime = values[0], startValue = values[1], cursor = 2;
  if (time <= startTime) return startValue;
  while (cursor < values.length) {
    const kind = values[cursor++];
    if (kind === 0 || kind === 2 || kind === 3) {
      const endTime = values[cursor++], endValue = values[cursor++];
      if (time <= endTime) return kind === 2 ? startValue : kind === 3 ? endValue : mix(startValue, endValue, clamp((time - startTime) / (endTime - startTime), 0, 1));
      startTime = endTime; startValue = endValue;
    } else if (kind === 1) {
      const x1 = values[cursor++], y1 = values[cursor++], x2 = values[cursor++], y2 = values[cursor++], endTime = values[cursor++], endValue = values[cursor++];
      if (time <= endTime) return bezierForTime(startTime, startValue, x1, y1, x2, y2, endTime, endValue, time);
      startTime = endTime; startValue = endValue;
    } else throw new Error(`Motion3 segment type ${kind} is unsupported.`);
  }
  return startValue;
}
function bezierForTime(x0, y0, x1, y1, x2, y2, x3, y3, time) { let low = 0, high = 1; for (let i = 0; i < 18; i++) { const t = (low + high) / 2; if (cubic(x0, x1, x2, x3, t) < time) low = t; else high = t; } return cubic(y0, y1, y2, y3, (low + high) / 2); }
function cubic(a, b, c, d, t) { const u = 1 - t; return u ** 3 * a + 3 * u ** 2 * t * b + 3 * u * t ** 2 * c + t ** 3 * d; }
function mix(a, b, t) { return a + (b - a) * t; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function required(query, name) { const value = query.get(name); if (!value) throw new Error(`Missing query parameter ${name}.`); return value; }
function positive(value, name) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive.`); return number; }
function requireOk(response) { if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}: ${response.url}`); return response; }
async function fetchJson(url) { return fetch(url).then(requireOk).then(response => response.json()); }
async function fetchJsonAsset(url, kind) {
  const buffer = await fetch(url).then(requireOk).then(response => response.arrayBuffer());
  let json;
  try { json = JSON.parse(new TextDecoder().decode(buffer)); }
  catch (error) { throw new Error(`${kind} JSON is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  return { kind, buffer, json, provenance: { uri: url.pathname, byteLength: buffer.byteLength, sha256: await sha256(buffer) } };
}
function validateExpression(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.Parameters)) throw new Error('exp3.json requires a Parameters array.');
  for (let index = 0; index < json.Parameters.length; index++) {
    const parameter = json.Parameters[index];
    if (!parameter || typeof parameter.Id !== 'string' || !parameter.Id || !Number.isFinite(parameter.Value)) throw new Error(`exp3.json Parameters[${index}] requires Id and a finite Value.`);
    if (parameter.Blend !== undefined && !['Add', 'Multiply', 'Overwrite'].includes(parameter.Blend)) throw new Error(`exp3.json Parameters[${index}].Blend is unsupported: ${parameter.Blend}.`);
  }
}
function validatePhysics(json) {
  if (!json || typeof json !== 'object' || !json.Meta || !Array.isArray(json.PhysicsSettings)) throw new Error('physics3.json requires Meta and PhysicsSettings.');
  if (!Number.isInteger(json.Meta.PhysicsSettingCount) || json.Meta.PhysicsSettingCount !== json.PhysicsSettings.length) throw new Error('physics3.json Meta.PhysicsSettingCount does not match PhysicsSettings.');
}
function validatePose(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.Groups)) throw new Error('pose3.json requires a Groups array.');
  for (let groupIndex = 0; groupIndex < json.Groups.length; groupIndex++) {
    if (!Array.isArray(json.Groups[groupIndex])) throw new Error(`pose3.json Groups[${groupIndex}] must be an array.`);
    for (let partIndex = 0; partIndex < json.Groups[groupIndex].length; partIndex++) if (typeof json.Groups[groupIndex][partIndex]?.Id !== 'string') throw new Error(`pose3.json Groups[${groupIndex}][${partIndex}] requires Id.`);
  }
}
function parseConstantInputs(value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('constants query must be valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.some(input => !input || typeof input.id !== 'string' || !input.id || !Number.isFinite(input.value))) throw new Error('constants query must be an array of { id, value } objects.');
  return parsed;
}
async function sha256(buffer) { const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)); return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
async function loadVerifiedScript(src) {
  const response = await fetch(new URL(src, location.href), { cache: 'no-store' }).then(requireOk);
  const buffer = await response.arrayBuffer();
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'text/javascript' }));
  try { await loadScript(objectUrl); }
  finally { URL.revokeObjectURL(objectUrl); }
  return { uri: src, byteLength: buffer.byteLength, sha256: await sha256(buffer) };
}
function loadScript(src) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => reject(new Error(`Could not load ${src}.`)); document.head.append(script); }); }
