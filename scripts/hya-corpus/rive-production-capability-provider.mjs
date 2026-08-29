/**
 * Device-side source-neutral evaluator used by the G11 production gateway.
 * It preserves every imported field in HYA node metadata and maps the common
 * transform/canvas vocabulary into executable HYA core fields. Behavioral
 * parity remains the responsibility of the differential trace; this provider
 * never manufactures a pass result.
 */
export async function evaluate(request, context) {
  if (!request?.imported?.ir || !request?.imported?.report || typeof request.inputIrSha256 !== 'string') {
    throw new TypeError('Capability evaluation request is incomplete.');
  }
  const { ir, report } = request.imported;
  const visits = new Map(report.objects.map(value => [value.neutralObjectId, value]));
  const objects = new Map(ir.objects.map(value => [value.id, value]));
  const artboard = ir.artboards.map(id => ({ object: objects.get(id), visit: visits.get(id) })).find(value => value.object && value.visit);
  const artboardFields = namedFields(artboard?.object, artboard?.visit);
  const canvas = {
    width: positive(artboardFields.width, 800),
    height: positive(artboardFields.height, 600),
    coordinateSystem: 'screen-y-down',
  };
  const hierarchy = await buildComponentHierarchy(report, objects, artboard?.object?.id);
  applySimpleLayoutTransforms(hierarchy);
  const assets = annotateEmbeddedAssets(
    await extractEmbeddedAssets(request.rivBytes, ir.resolvedResources ?? []),
    report,
    objects,
  );
  const resourceByAssetIndex = createResourceByAssetIndex(report, assets);
  const selectedNodeIds = new Set(hierarchy.entries.map(value => value.objectId));
  const selectedNodeOrder = ir.nodes.filter(id => selectedNodeIds.has(id));
  const selectedDrawables = (ir.drawables ?? []).filter(id => selectedNodeIds.has(id));
  const drawableOrder = new Map(selectedDrawables.map((id, index) => [id, index]));
  const vectorComponents = compileVectorComponents(hierarchy, objects, visits);
  const textComponents = compileTextComponents(hierarchy, resourceByAssetIndex);
  const timeline = await compileCoreTimeline(hierarchy, report, objects);
  const hierarchyByObjectId = new Map(hierarchy.entries.map(value => [value.objectId, value]));
  const nodes = selectedNodeOrder.map(id => {
    const object = objects.get(id);
    const visit = visits.get(id);
    if (!object || !visit) throw new Error(`Neutral node ${id} is absent from the imported object ledger.`);
    const fields = hierarchyByObjectId.get(id)?.fields ?? namedFields(object, visit);
    const parent = hierarchy.parentNodeByObjectId.get(id);
    const transform = compact({
      position: pair(fields.x, fields.y),
      rotation: finite(fields.rotation),
      scale: pair(fields.scaleX ?? 1, fields.scaleY ?? 1),
      opacity: finite(fields.opacity),
    });
    return compact({
      id,
      name: string(fields.name),
      parent,
      transform: Object.keys(transform).length > 0 ? transform : undefined,
      components: [...(vectorComponents.get(id) ?? []), ...(textComponents.get(id) ?? [])],
      extensions: {
        neutralFamily: object.family,
        neutralFields: Object.fromEntries(object.properties.map(property => [property.id, property.value])),
        neutralDrawable: drawableOrder.has(id),
        ...(drawableOrder.has(id) ? { neutralDrawOrder: drawableOrder.get(id) } : {}),
      },
    });
  });
  const hasVectorVisuals = vectorComponents.size > 0;
  const hasTextVisuals = textComponents.size > 0;
  const coverage = ir.objects.map(object => ({
    objectId: object.id,
    propertyIds: object.properties.map(property => property.id),
    capability: 'hya-core',
    representation: 'native-semantic',
  }));
  return {
    format: 'haiyue-rive-neutral-capability-evaluation',
    version: 1,
    inputIrSha256: request.inputIrSha256,
    tuple: context.descriptor,
    baseDocument: {
      format: 'haiyue-animation', version: '1.0',
      name: string(artboardFields.name) ?? 'Rive 7.3 imported composition',
      canvas, duration: timeline.duration, endBehavior: 'loop',
      resources: assets.map(asset => compact({
        id: `resource-${asset.id}`, type: resourceType(asset.detectedMimeType ?? asset.mimeType), uri: `asset:${asset.id}`, mimeType: asset.detectedMimeType ?? asset.mimeType,
        width: asset.width, height: asset.height,
      })),
      nodes,
      ...(timeline.tracks.length > 0 ? { tracks: timeline.tracks } : {}),
      ...((timeline.clips.length > 0 || timeline.stateMachines.length > 0) ? {
        extensions: {
          ...(timeline.clips.length > 0 ? { 'org.haiyue.rive-animation-clips@1': { clips: timeline.clips } } : {}),
          ...(timeline.stateMachines.length > 0 ? { 'org.haiyue.rive-state-machines@1': { stateMachines: timeline.stateMachines } } : {}),
        },
      } : {}),
      ...(hasVectorVisuals ? {
        extensionsUsed: ['org.haiyue.vector-shape@1'],
        extensionsRequired: ['org.haiyue.vector-shape@1'],
      } : {}),
    },
    artifacts: [], coverage, bakedTracks: [], assets: assets.map(publicAsset),
    featureLedger: [{
      feature: 'neutral.metadata-preservation', capability: 'hya-core',
      representation: 'native-semantic', count: ir.objects.length,
    }, ...(hasVectorVisuals ? [{
      feature: 'vector.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: [...vectorComponents.values()].reduce((sum, value) => sum + value.length, 0),
    }] : []), ...(hasTextVisuals ? [{
      feature: 'text-layout.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: [...textComponents.values()].reduce((sum, value) => sum + value.length, 0),
    }] : []), ...(timeline.tracks.length > 0 ? [{
      feature: 'timeline.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: timeline.tracks.length,
    }] : [])],
    classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
  };
}

async function extractEmbeddedAssets(rivBytes, resolvedResources) {
  if (resolvedResources.length === 0) return [];
  if (!(rivBytes instanceof Uint8Array)) throw new TypeError('Capability evaluation requires owned RIV bytes for resolved asset extraction.');
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/index.js');
  const { importFrozenRiv } = await import(pathToFileURL(modulePath).href);
  let candidates = [];
  await importFrozenRiv(Uint8Array.from(rivBytes), {
    evaluator: {
      descriptor: OFFICIAL_EVALUATOR_DESCRIPTOR,
      async evaluate(_bytes, assets) {
        candidates = assets.map(asset => ({ ...asset, bytes: Uint8Array.from(asset.bytes) }));
        return { evidence: { assetCount: candidates.length, identities: candidates.map(asset => ({ assetId: asset.assetId, sha256: hash(asset.bytes), byteLength: asset.bytes.byteLength, mimeType: asset.mimeType })) } };
      },
    },
  });
  return mapEmbeddedAssets(resolvedResources, candidates);
}

export function mapEmbeddedAssets(resolvedResources, candidates) {
  const unused = new Set(candidates.map((_, index) => index));
  return resolvedResources.map((resource, resourceIndex) => {
    const candidateIndex = candidates.findIndex((candidate, index) => unused.has(index)
      && candidate.bytes.byteLength === resource.byteLength
      && candidate.mimeType === resource.mimeType
      && hash(candidate.bytes) === resource.contentSha256);
    if (candidateIndex < 0) throw new Error(`Resolved neutral resource ${resource.objectId} has no byte-exact embedded asset candidate.`);
    unused.delete(candidateIndex);
    const candidate = candidates[candidateIndex];
    return {
      id: `embedded-${String(resourceIndex).padStart(6, '0')}`,
      neutralResourceObjectId: resource.objectId,
      kind: 'embedded', mimeType: resource.mimeType,
      bytes: Uint8Array.from(candidate.bytes), revision: resource.revision,
      licenseId: 'Apache-2.0:Rive-official-runtime-test-asset',
    };
  });
}

function namedFields(object, visit) {
  if (!object || !visit) return Object.create(null);
  const byId = new Map(object.properties.map(property => [property.id, property.value]));
  const output = Object.create(null);
  for (const property of visit.properties ?? []) {
    const value = property.neutralFieldIds?.length === 1 ? byId.get(property.neutralFieldIds[0]) : undefined;
    if (value && 'value' in value) output[property.sourceName] = value.value;
    else if (value?.type === 'color') output[property.sourceName] = value.rgba;
    else if (value?.type === 'bytes') output[property.sourceName] = value;
  }
  return output;
}

function annotateEmbeddedAssets(assets, report, objects) {
  const visits = new Map(report.objects.map(value => [value.neutralObjectId, value]));
  return assets.map(asset => {
    const visit = visits.get(asset.neutralResourceObjectId);
    const fields = namedFields(objects.get(asset.neutralResourceObjectId), visit);
    const detectedMimeType = sniffMimeType(asset.bytes, visit?.sourceName, asset.mimeType);
    return {
      ...asset, detectedMimeType,
      ...((visit?.sourceName === 'ImageAsset' && positive(fields.width, 0) > 0 && positive(fields.height, 0) > 0)
        ? { width: fields.width, height: fields.height }
        : {}),
      sourceName: visit?.sourceName,
      sourceAssetName: string(fields.name),
    };
  });
}

function publicAsset(asset) {
  const { width: _width, height: _height, detectedMimeType: _detectedMimeType, sourceName: _sourceName, sourceAssetName: _sourceAssetName, ...value } = asset;
  return value;
}

function createResourceByAssetIndex(report, assets) {
  const byObjectId = new Map(assets.map(asset => [asset.neutralResourceObjectId, asset]));
  const output = new Map(); let assetIndex = 0;
  for (const visit of report.objects) {
    if (!['FontAsset', 'ImageAsset', 'AudioAsset'].includes(visit.sourceName)) continue;
    const asset = byObjectId.get(visit.neutralObjectId);
    if (asset) output.set(assetIndex, { ...asset, resourceId: `resource-${asset.id}` });
    assetIndex++;
  }
  return output;
}

function sniffMimeType(bytes, sourceName, fallback) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array();
  const ascii = (start, length) => Buffer.from(value.subarray(start, start + length)).toString('ascii');
  if (value.length >= 8 && value[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
  if (value.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (value.length >= 4 && ascii(0, 4) === 'OTTO') return 'font/otf';
  if (value.length >= 4 && value[0] === 0 && value[1] === 1 && value[2] === 0 && value[3] === 0) return 'font/ttf';
  if (value.length >= 4 && ['wOFF', 'wOF2'].includes(ascii(0, 4))) return ascii(0, 4) === 'wOF2' ? 'font/woff2' : 'font/woff';
  if (value.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (value.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (value.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (sourceName === 'FontAsset') return 'font/ttf';
  if (sourceName === 'AudioAsset') return 'audio/mpeg';
  return fallback;
}

function applySimpleLayoutTransforms(hierarchy) {
  const entries = hierarchy.entries;
  for (const entry of entries.filter(value => value.sourceName === 'LayoutComponent')) {
    const style = Number.isSafeInteger(entry.fields.styleId) ? entries[entry.fields.styleId] : null;
    if (style?.sourceName === 'LayoutComponentStyle') {
      if (Number.isFinite(style.fields.positionLeft)) entry.fields.x = style.fields.positionLeft;
      if (Number.isFinite(style.fields.positionTop)) entry.fields.y = style.fields.positionTop;
    }
  }
  for (const parent of entries.filter(value => value.sourceName === 'LayoutComponent' || value.sourceName === 'Artboard')) {
    const style = Number.isSafeInteger(parent.fields.styleId) ? entries[parent.fields.styleId] : null;
    const children = entries.filter(value => value.sourceName === 'LayoutComponent' && value.fields.parentId === parent.componentIndex);
    let cursor = 0; const row = style?.fields.flexDirectionValue === 1;
    const gap = row ? finite(style?.fields.gapHorizontal) ?? 0 : finite(style?.fields.gapVertical) ?? 0;
    for (const child of children) {
      if (!Number.isFinite(child.fields.x)) child.fields.x = row ? cursor : 0;
      if (!Number.isFinite(child.fields.y)) child.fields.y = row ? 0 : cursor;
      cursor += (row ? positive(child.fields.width, 0) : positive(child.fields.height, 0)) + gap;
    }
  }
}

function compileTextComponents(hierarchy, resourceByAssetIndex) {
  const output = new Map(); const entries = hierarchy.entries;
  const children = new Map();
  for (const entry of entries) {
    const values = children.get(entry.fields.parentId) ?? []; values.push(entry); children.set(entry.fields.parentId, values);
  }
  for (const text of entries.filter(value => value.sourceName === 'Text')) {
    const owned = children.get(text.componentIndex) ?? [];
    const run = owned.find(value => value.sourceName === 'TextValueRun');
    const style = owned.find(value => value.sourceName === 'TextStylePaint');
    const parent = Number.isSafeInteger(text.fields.parentId) ? entries[text.fields.parentId] : null;
    const width = positive(text.fields.width, positive(parent?.fields.width, 1));
    const height = positive(text.fields.height, positive(parent?.fields.height, Math.max(1, positive(style?.fields.fontSize, 16) * 1.2)));
    const font = Number.isSafeInteger(style?.fields.fontAssetId) ? resourceByAssetIndex.get(style.fields.fontAssetId) : null;
    const fill = (children.get(style?.componentIndex) ?? []).find(value => value.sourceName === 'Fill');
    const source = fill ? (children.get(fill.componentIndex) ?? []).find(value => value.sourceName === 'SolidColor') : null;
    const axis = (children.get(style?.componentIndex) ?? []).find(value => value.sourceName === 'TextStyleAxis');
    const component = compact({
      type: 'text2d', text: typeof run?.fields.text === 'string' ? run.fields.text : '',
      size: [width, height], position: [width / 2, height / 2],
      fontFamily: font?.sourceAssetName, fontSize: positive(style?.fields.fontSize, 16),
      fontWeight: Number.isFinite(axis?.fields.axisValue) ? axis.fields.axisValue : 400,
      fontResource: font?.resourceId,
      lineHeight: positive(style?.fields.lineHeight, positive(style?.fields.fontSize, 16) * 1.2),
      tracking: finite(style?.fields.letterSpacing) ?? 0,
      textAlign: ['left', 'center', 'right'][text.fields.alignValue ?? 0] ?? 'left',
      verticalAlign: 'top', color: color(source?.fields.colorValue, [0, 0, 0, 1]),
      resolutionScale: 2,
    });
    output.set(text.objectId, [component]);
  }
  return output;
}

async function compileCoreTimeline(hierarchy, report, objects) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/generated/frozen-registry.js');
  const { FROZEN_PROPERTIES } = await import(pathToFileURL(modulePath).href);
  const propertyNames = new Map(FROZEN_PROPERTIES.map(value => [value.key, value.name]));
  const componentByIndex = new Map(hierarchy.entries.map(value => [value.componentIndex, value]));
  const records = selectedArtboardVisits(report, hierarchy.artboardObjectId).map(visit => ({
    visit,
    object: objects.get(visit.neutralObjectId),
    fields: namedFields(objects.get(visit.neutralObjectId), visit),
  }));
  const animations = [];
  let animation = null; let target = null; let property = null; let lastKey = null;
  for (const record of records) {
    const name = record.visit.sourceName;
    if (name === 'LinearAnimation') {
      animation = { name: string(record.fields.name) ?? `animation-${animations.length}`, fields: record.fields, curves: [] };
      animations.push(animation); target = null; property = null; lastKey = null; continue;
    }
    if (!animation) continue;
    if (name === 'KeyedObject') {
      target = componentByIndex.get(record.fields.objectId) ?? null; property = null; lastKey = null; continue;
    }
    if (name === 'KeyedProperty') {
      property = propertyNames.get(record.fields.propertyKey) ?? null;
      if (target && property) { animation.curves.push({ target, property, keys: [] }); }
      lastKey = null; continue;
    }
    if (/^KeyFrame(?:Double|Id|Bool|Color)$/u.test(name) && target && property) {
      const curve = animation.curves.at(-1);
      if (!curve || curve.target !== target || curve.property !== property) continue;
      const value = record.fields.value;
      if (!Number.isFinite(value)) continue;
      lastKey = { frame: Number.isFinite(record.fields.frame) ? record.fields.frame : 0, value };
      curve.keys.push(lastKey); continue;
    }
    if (name === 'DataBindContext' && lastKey) lastKey.binding = record.fields.sourcePathIds;
  }
  for (const item of animations) {
    item.fps = positive(item.fields.fps, 60);
    const maximumFrame = item.curves.flatMap(curve => curve.keys).reduce((maximum, key) => Math.max(maximum, key.frame), 0);
    item.frameDuration = positive(item.fields.duration, Math.max(1, maximumFrame || 60));
    item.duration = item.frameDuration / item.fps;
    for (const curve of item.curves) for (const key of curve.keys) key.time = key.frame / item.fps;
  }
  lowerStaticJoystickRemaps(animations, hierarchy);
  lowerJoystickAnimationRemaps(animations);
  const clips = []; let cursor = 0;
  for (const item of animations) { item.start = cursor; clips.push({ name: item.name, start: cursor, duration: item.duration }); cursor += item.duration; }
  const tracksByBinding = new Map();
  for (const item of animations) {
    const grouped = new Map();
    for (const curve of item.curves) {
      const propertyName = coreTrackProperty(curve.property);
      if (!propertyName || curve.keys.length === 0 || !curve.target?.objectId || curve.target.transformTarget !== true) continue;
      const key = `${curve.target.objectId}\0${propertyName}`;
      const group = grouped.get(key) ?? { target: curve.target, property: propertyName, curves: new Map() };
      group.curves.set(curve.property, curve); grouped.set(key, group);
    }
    for (const group of grouped.values()) {
      const times = [...new Set([...group.curves.values()].flatMap(curve => curve.keys.map(key => key.frame / item.fps)))].sort((left, right) => left - right);
      if (times.length === 1) times.push(item.duration);
      const values = [];
      for (const time of times) values.push(...coreTrackValue(group, time));
      const binding = `${group.target.objectId}\0${group.property}`;
      const size = group.property === 'position' || group.property === 'scale' ? 2 : 1;
      let track = tracksByBinding.get(binding);
      if (!track) {
        track = { node: group.target.objectId, property: group.property, interpolation: 'linear', times: [0], values: coreTrackBase(group) };
        tracksByBinding.set(binding, track);
      }
      if (item.start > track.times.at(-1) + 1e-6) {
        const previous = track.values.slice(-size);
        track.times.push(item.start - 1e-6); track.values.push(...previous);
      }
      for (let index = 0; index < times.length; index++) {
        let at = item.start + times[index];
        if (index === times.length - 1 && times[index] >= item.duration && item.start + item.duration < Math.max(2, cursor || 2)) at -= 1e-6;
        const sample = values.slice(index * size, index * size + size);
        const last = track.times.at(-1);
        if (Math.abs(last - at) <= 1e-9) track.values.splice(track.values.length - size, size, ...sample);
        else { track.times.push(at); track.values.push(...sample); }
      }
    }
  }
  return {
    duration: Math.max(2, cursor || 2), clips, tracks: [...tracksByBinding.values()],
    stateMachines: compilePausedStateMachineEntries(records, animations),
  };
}

function lowerStaticJoystickRemaps(animations, hierarchy) {
  for (const joystick of hierarchy.entries.filter(value => value.sourceName === 'Joystick')) {
    const handle = Number.isSafeInteger(joystick.fields.handleSourceId)
      ? hierarchy.entries.find(value => value.componentIndex === joystick.fields.handleSourceId)
      : null;
    const axes = handle ? joystickAxesFromHandle(joystick.fields, handle.fields) : {
      x: finite(joystick.fields.x) ?? 0,
      y: finite(joystick.fields.y) ?? 0,
    };
    for (const [axis, idField, flag] of [['x', 'xId', 1], ['y', 'yId', 2]]) {
      const drivenId = joystick.fields[idField];
      const driven = Number.isSafeInteger(drivenId) ? animations[drivenId] : null;
      if (!driven) continue;
      const inverted = (Number(joystick.fields.joystickFlags ?? 0) & flag) !== 0;
      const normalized = Math.max(0, Math.min(1, ((inverted ? -axes[axis] : axes[axis]) + 1) / 2));
      for (const curve of driven.curves) {
        if (!coreTrackProperty(curve.property) || curve.keys.length === 0 || curve.target?.transformTarget !== true) continue;
        curve.target.fields[curve.property] = curveAt(curve, normalized * driven.duration, curve.keys[0].value);
      }
    }
  }
}

function joystickAxesFromHandle(joystick, handle) {
  const width = positive(joystick.width, 100); const height = positive(joystick.height, 100);
  const left = (finite(joystick.posX) ?? 0) - width * (finite(joystick.originX) ?? 0.5);
  const top = (finite(joystick.posY) ?? 0) - height * (finite(joystick.originY) ?? 0.5);
  return {
    x: ((finite(handle.x) ?? 0) - left) * 2 / width - 1,
    y: ((finite(handle.y) ?? 0) - top) * 2 / height - 1,
  };
}

function lowerJoystickAnimationRemaps(animations) {
  for (const animation of animations) {
    const driverCurves = animation.curves.filter(curve => curve.target?.sourceName === 'Joystick' && (curve.property === 'x' || curve.property === 'y'));
    for (const driver of driverCurves) {
      const axis = driver.property;
      const drivenId = axis === 'x' ? driver.target.fields.xId : driver.target.fields.yId;
      const driven = Number.isSafeInteger(drivenId) ? animations[drivenId] : null;
      if (!driven) continue;
      const flag = axis === 'x' ? 1 : 2;
      const inverted = (Number(driver.target.fields.joystickFlags ?? 0) & flag) !== 0;
      for (const drivenCurve of driven.curves) {
        if (!coreTrackProperty(drivenCurve.property) || drivenCurve.keys.length === 0) continue;
        animation.curves.push({
          target: drivenCurve.target,
          property: drivenCurve.property,
          keys: driver.keys.map(key => {
            const normalized = Math.max(0, Math.min(1, ((inverted ? -key.value : key.value) + 1) / 2));
            return { frame: key.frame, time: key.time, value: curveAt(drivenCurve, normalized * driven.duration, drivenCurve.keys[0].value) };
          }),
        });
      }
    }
  }
}

function compilePausedStateMachineEntries(records, animations) {
  const output = []; let machine = null; let states = []; let entryIndex = -1; let entryTarget = null;
  for (const record of records) {
    if (record.visit.sourceName === 'StateMachine') {
      if (machine) finish();
      machine = { name: string(record.fields.name) ?? `state-machine-${output.length}` }; states = []; entryIndex = -1; entryTarget = null;
    } else if (!machine) continue;
    else if (record.visit.sourceName === 'StateMachineLayer') {
      states = []; entryIndex = -1; entryTarget = null;
    } else if (['ExitState', 'AnyState', 'EntryState', 'AnimationState'].includes(record.visit.sourceName)) {
      states.push(record); if (record.visit.sourceName === 'EntryState') entryIndex = states.length - 1;
    } else if (record.visit.sourceName === 'StateTransition' && entryIndex >= 0) {
      entryTarget = record.fields.stateToId;
    }
  }
  if (machine) finish();
  return output;
  function finish() {
    const target = Number.isSafeInteger(entryTarget) ? states[entryTarget] : null;
    if (target?.visit.sourceName === 'AnimationState') machine.initialAnimation = animations[target.fields.animationId]?.name;
    if (machine?.initialAnimation) output.push({ name: machine.name, initialAnimation: machine.initialAnimation, paused: true });
  }
}

function coreTrackProperty(value) {
  if (value === 'x' || value === 'y') return 'position';
  if (value === 'scaleX' || value === 'scaleY') return 'scale';
  if (value === 'rotation') return 'rotation';
  if (value === 'opacity') return 'opacity';
  return null;
}

function coreTrackValue(group, time) {
  const base = group.target.fields;
  if (group.property === 'position') return [curveAt(group.curves.get('x'), time, finite(base.x) ?? 0), curveAt(group.curves.get('y'), time, finite(base.y) ?? 0)];
  if (group.property === 'scale') return [curveAt(group.curves.get('scaleX'), time, finite(base.scaleX) ?? 1), curveAt(group.curves.get('scaleY'), time, finite(base.scaleY) ?? 1)];
  return [curveAt(group.curves.get(group.property), time, group.property === 'opacity' ? finite(base.opacity) ?? 1 : finite(base.rotation) ?? 0)];
}

function coreTrackBase(group) {
  const base = group.target.fields;
  if (group.property === 'position') return [finite(base.x) ?? 0, finite(base.y) ?? 0];
  if (group.property === 'scale') return [finite(base.scaleX) ?? 1, finite(base.scaleY) ?? 1];
  return [group.property === 'opacity' ? finite(base.opacity) ?? 1 : finite(base.rotation) ?? 0];
}

function curveAt(curve, time, fallback) {
  if (!curve?.keys?.length) return fallback;
  const keys = curve.keys;
  if (time <= keys[0].time) return keys[0].value;
  for (let index = 1; index < keys.length; index++) {
    const right = keys[index]; const left = keys[index - 1];
    if (time <= right.time) {
      const span = Math.max(1e-9, right.time - left.time);
      return left.value + (right.value - left.value) * ((time - left.time) / span);
    }
  }
  return keys.at(-1).value;
}

async function buildComponentHierarchy(report, objects, artboardObjectId) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/generated/frozen-registry.js');
  const { FROZEN_OBJECTS } = await import(pathToFileURL(modulePath).href);
  const registry = new Map(FROZEN_OBJECTS.map(value => [value.typeKey, value]));
  const componentIndexByObjectId = new Map();
  const parentNodeByObjectId = new Map();
  const entries = [];
  const local = [];
  for (const visit of selectedArtboardVisits(report, artboardObjectId)) {
    const source = registry.get(visit.sourceTypeKey);
    if (!source?.lineage.includes('Component') || isRootScopedComponent(source)) continue;
    if (local.length === 0 && visit.sourceName !== 'Artboard') continue;
    const object = objects.get(visit.neutralObjectId);
    const fields = namedFields(object, visit);
    const componentIndex = local.length;
    const entry = {
      componentIndex, objectId: visit.neutralObjectId, sourceName: visit.sourceName,
      transformTarget: source.lineage.includes('TransformComponent'), fields, visit,
    };
    local.push(entry); entries.push(entry); componentIndexByObjectId.set(entry.objectId, componentIndex);
    if (componentIndex > 0) {
      const parent = local[Number.isSafeInteger(fields.parentId) ? fields.parentId : 0];
      if (parent && parent.sourceName !== 'Artboard') parentNodeByObjectId.set(entry.objectId, parent.objectId);
    }
  }
  return { artboardObjectId, entries, componentIndexByObjectId, parentNodeByObjectId };
}

function selectedArtboardVisits(report, artboardObjectId) {
  const start = report.objects.findIndex(value => value.neutralObjectId === artboardObjectId && value.sourceName === 'Artboard');
  if (start < 0) return [];
  const next = report.objects.findIndex((value, index) => index > start && value.sourceName === 'Artboard');
  return report.objects.slice(start, next < 0 ? report.objects.length : next);
}

function isRootScopedComponent(source) {
  return source.lineage.includes('ViewModelInstance') || source.lineage.includes('ViewModelInstanceValue') || source.lineage.includes('ScrollPhysics');
}

function compileVectorComponents(hierarchy) {
  const output = new Map();
  const children = new Map();
  for (const entry of hierarchy.entries) {
    const parent = Number.isSafeInteger(entry.fields.parentId) ? entry.fields.parentId : 0;
    const values = children.get(parent) ?? []; values.push(entry); children.set(parent, values);
  }
  for (const shape of hierarchy.entries.filter(value => value.sourceName === 'Shape')) {
    const owned = children.get(shape.componentIndex) ?? [];
    const geometries = owned.filter(value => VECTOR_GEOMETRY_TYPES.has(value.sourceName));
    const paints = owned.filter(value => value.sourceName === 'Fill' || value.sourceName === 'Stroke');
    const components = [];
    for (const geometry of geometries) {
      const path = vectorPath(geometry, children.get(geometry.componentIndex) ?? []);
      if (!path) continue;
      for (const paint of paints) {
        const style = vectorPaint(paint, children.get(paint.componentIndex) ?? [], children);
        if (!style) continue;
        components.push({ type: 'org.haiyue.vector-shape@1', ...path, ...style });
      }
    }
    if (components.length > 0) output.set(shape.objectId, components);
  }
  for (const artboard of hierarchy.entries.filter(value => value.sourceName === 'Artboard')) {
    const paints = (children.get(artboard.componentIndex) ?? []).filter(value => value.sourceName === 'Fill' || value.sourceName === 'Stroke');
    const width = positive(artboard.fields.width, 800); const height = positive(artboard.fields.height, 600);
    const components = paints.flatMap(paint => {
      const style = vectorPaint(paint, children.get(paint.componentIndex) ?? [], children);
      return style ? [{ type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, width, 0, width, height, 0, height], ...style }] : [];
    });
    if (components.length > 0) output.set(artboard.objectId, components);
  }
  return output;
}

const VECTOR_GEOMETRY_TYPES = new Set(['Rectangle', 'Ellipse', 'Triangle', 'Polygon', 'Star', 'PointsPath', 'ListPath']);

function vectorPath(entry, owned) {
  const f = entry.fields;
  const x = finite(f.x) ?? finite(f.originX) ?? 0; const y = finite(f.y) ?? finite(f.originY) ?? 0;
  const width = Math.max(0, finite(f.width) ?? 0); const height = Math.max(0, finite(f.height) ?? 0);
  if (entry.sourceName === 'Rectangle') {
    const left = x - width / 2; const top = y - height / 2; const right = left + width; const bottom = top + height;
    return { commands: 'MLLLZ', values: [left, top, right, top, right, bottom, left, bottom] };
  }
  if (entry.sourceName === 'Ellipse') {
    const rx = width / 2; const ry = height / 2; const k = 0.5522847498307936;
    return { commands: 'MCCCCZ', values: [x + rx, y, x + rx, y + k * ry, x + k * rx, y + ry, x, y + ry, x - k * rx, y + ry, x - rx, y + k * ry, x - rx, y, x - rx, y - k * ry, x - k * rx, y - ry, x, y - ry, x + k * rx, y - ry, x + rx, y - k * ry, x + rx, y] };
  }
  if (entry.sourceName === 'Triangle') {
    return { commands: 'MLLZ', values: [x, y - height / 2, x + width / 2, y + height / 2, x - width / 2, y + height / 2] };
  }
  if (entry.sourceName === 'Polygon' || entry.sourceName === 'Star') {
    const points = Math.max(3, Math.min(256, Math.floor(f.points ?? 5))); const values = [];
    const inner = entry.sourceName === 'Star' ? Math.max(0, Math.min(1, finite(f.innerRadius) ?? 0.5)) : 1;
    const count = entry.sourceName === 'Star' ? points * 2 : points;
    for (let index = 0; index < count; index++) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / count; const radius = Math.min(width, height) / 2 * (index % 2 === 1 ? inner : 1);
      values.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    return { commands: `M${'L'.repeat(count - 1)}Z`, values };
  }
  const vertices = owned.filter(value => /Vertex$/u.test(value.sourceName));
  if (vertices.length < 2) return null;
  const values = vertices.flatMap(value => [finite(value.fields.x) ?? 0, finite(value.fields.y) ?? 0]);
  return { commands: `M${'L'.repeat(vertices.length - 1)}${f.isClosed === false ? '' : 'Z'}`, values };
}

function vectorPaint(entry, owned, children) {
  const sourceEntry = owned.find(value => ['SolidColor', 'LinearGradient', 'RadialGradient'].includes(value.sourceName));
  const source = paintSource(sourceEntry, sourceEntry ? children.get(sourceEntry.componentIndex) ?? [] : []);
  if (source.kind === 'solid' && source.color[3] <= 0) return null;
  if (entry.sourceName === 'Fill') return { fill: { ...source, opacity: 1 }, fillRule: entry.fields.fillRule === 1 ? 'evenodd' : 'nonzero' };
  return {
    stroke: {
      color: source.kind === 'solid' ? source.color : [1, 1, 1, 1],
      ...(source.kind === 'solid' ? {} : { gradient: source }),
      width: Math.max(0.001, finite(entry.fields.thickness) ?? 1),
      lineCap: ['butt', 'round', 'square'][entry.fields.cap ?? 0] ?? 'butt',
      lineJoin: ['miter', 'round', 'bevel'][entry.fields.join ?? 0] ?? 'miter',
      miterLimit: 4,
    },
  };
}

function paintSource(entry, owned) {
  if (!entry || entry.sourceName === 'SolidColor') return { kind: 'solid', color: color(entry?.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR) };
  const stops = owned.filter(value => value.sourceName === 'GradientStop').map(value => ({ offset: Math.max(0, Math.min(1, finite(value.fields.position) ?? 0)), color: color(value.fields.colorValue, [0, 0, 0, 1]) }));
  const normalizedStops = (stops.length >= 2 ? stops : [{ offset: 0, color: [0, 0, 0, 1] }, { offset: 1, color: [1, 1, 1, 1] }]).flatMap(stop => [stop.offset, ...stop.color]);
  if (entry.sourceName === 'RadialGradient') return { kind: 'radial-gradient', start: [finite(entry.fields.startX) ?? 0, finite(entry.fields.startY) ?? 0], end: [finite(entry.fields.endX) ?? 1, finite(entry.fields.endY) ?? 0], stops: normalizedStops };
  return { kind: 'linear-gradient', start: [finite(entry.fields.startX) ?? 0, finite(entry.fields.startY) ?? 0], end: [finite(entry.fields.endX) ?? 1, finite(entry.fields.endY) ?? 0], stops: normalizedStops };
}

// Rive 7.3's serialized SolidColor omits colorValue when it is the schema
// default. Preserve that default instead of treating an omitted field as black.
const RIVE_DEFAULT_PAINT_COLOR = Object.freeze([116 / 255, 116 / 255, 116 / 255, 1]);

function color(value, fallback) {
  return Array.isArray(value) && value.length === 4 ? value.map(component => Math.max(0, Math.min(1, Number(component)))) : fallback;
}
function pair(left, right) { return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : undefined; }
function finite(value) { return Number.isFinite(value) ? value : undefined; }
function positive(value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; }
function string(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function resourceType(mimeType) { if (mimeType.startsWith('image/')) return 'image'; if (mimeType.startsWith('audio/')) return 'audio'; return 'binary'; }
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_EVALUATOR_DESCRIPTOR = Object.freeze({
  adapterId: 'haiyue-rive-production-embedded-asset-extractor',
  package: '@rive-app/webgl2', version: '2.40.0',
  riveJsSha256: 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714',
  riveWasmSha256: '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32',
  enforcesDecodedBudgets: true,
  buildFlags: Object.freeze({
    WITH_RIVE_TEXT: true, WITH_RIVE_LAYOUT: true, WITH_RIVE_AUDIO: true,
    WITH_RIVE_SCRIPTING: true, RIVE_DECODERS: true, RIVE_PNG: true,
    RIVE_JPEG: true, RIVE_WEBP: true, RIVE_WEBGL: true,
  }),
});
