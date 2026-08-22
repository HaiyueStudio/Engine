const resultNode = document.querySelector('#result');
const progress = document.querySelector('#progress');

void capture().then(captureResult => {
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify({ status: 'passed', capture: captureResult });
}).catch(error => {
  console.error(error);
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
});

async function capture() {
  const query = new URLSearchParams(location.search);
  const modelUri = required(query, 'model');
  const motionUri = query.get('motion');
  const requestedFrameRate = positive(query.get('fps') ?? '30', 'fps');
  progress.textContent = 'loading Cubism Core';
  await loadScript('./live2dcubismcore.min.js');
  const core = globalThis.Live2DCubismCore;
  if (!core?.Moc || !core?.Model) throw new Error('The supplied script did not expose Live2DCubismCore.Moc/Model.');
  const modelUrl = new URL(modelUri, location.href);
  const model3 = await fetchJson(modelUrl);
  const references = model3.FileReferences;
  if (!references?.Moc || !Array.isArray(references.Textures)) throw new Error('model3.json requires FileReferences.Moc and Textures.');
  const mocBuffer = await fetch(new URL(references.Moc, modelUrl)).then(requireOk).then(response => response.arrayBuffer());
  const moc = core.Moc.fromArrayBuffer(mocBuffer);
  if (!moc) throw new Error('Cubism Core rejected the .moc3 payload.');
  const model = core.Model.fromMoc(moc);
  if (!model) { moc.release?.(); throw new Error('Cubism Core could not create a model from the .moc3 payload.'); }
  const motion = motionUri ? await fetchJson(new URL(motionUri, location.href)) : null;
  const duration = motion?.Meta?.Duration ?? positive(query.get('duration') ?? '1', 'duration');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Motion duration must be positive.');
  const stepCount = Math.max(1, Math.ceil(duration * requestedFrameRate));
  const frameRate = stepCount / duration;
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
    let modelOpacity = 1;
    if (motion) {
      const sampleTime = motion.Meta.Loop && time === duration ? 0 : time;
      for (const curve of motion.Curves ?? []) {
        const value = sampleSegments(curve.Segments, sampleTime);
        if (curve.Target === 'Parameter') {
          const index = parameterIndex.get(curve.Id);
          if (index !== undefined) model.parameters.values[index] = value;
        } else if (curve.Target === 'PartOpacity') {
          const index = partIndex.get(curve.Id);
          if (index !== undefined) model.parts.opacities[index] = value;
        } else if (curve.Target === 'Model' && curve.Id === 'Opacity') modelOpacity = value;
      }
    }
    model.update();
    frames.push({ time, drawables: captureDrawables(core, model, modelOpacity, canvas) });
  }
  const pixelsPerUnit = Number(canvas.PixelsPerUnit);
  const captureResult = {
    format: 'live2d-cubism-drawable-capture', version: 1,
    name: model3.Name ?? model3.name ?? 'Cubism model',
    source: { kind: 'cubism-core-capture', model: modelUri, motion: motionUri ?? null, coreVersion: String(core.Version?.csmGetVersion?.() ?? 'unknown') },
    canvas: { width: Number(canvas.CanvasWidth), height: Number(canvas.CanvasHeight), pixelsPerUnit, coordinateSystem: 'model-y-up', uvOrigin: 'bottom-left' },
    duration, frameRate,
    textures: references.Textures.map((uri, index) => ({ id: `texture-${index}`, uri })),
    frames,
  };
  model.release?.();
  moc.release?.();
  progress.textContent = 'complete';
  return captureResult;
}

function captureDrawables(core, model, modelOpacity, canvas) {
  const drawables = model.drawables;
  const ids = Array.from(drawables.ids, String);
  return ids.map((id, index) => {
    const constantFlags = drawables.constantFlags[index];
    const masks = Array.from(drawables.masks[index] ?? [], maskIndex => ids[maskIndex]);
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
function loadScript(src) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => reject(new Error(`Could not load ${src}.`)); document.head.append(script); }); }
