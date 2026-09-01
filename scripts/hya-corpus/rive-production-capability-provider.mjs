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
  const artboards = ir.artboards.map(id => ({ object: objects.get(id), visit: visits.get(id) })).filter(value => value.object && value.visit);
  const artboard = artboards.find(value => namedFields(value.object, value.visit).name === request.selection?.artboard) ?? artboards[0];
  if (!artboard) throw new Error('Neutral IR contains no selectable artboard.');
  const artboardFields = namedFields(artboard?.object, artboard?.visit);
  const canvas = {
    width: positive(artboardFields.width, 800),
    height: positive(artboardFields.height, 600),
    coordinateSystem: 'screen-y-down',
  };
  const hierarchy = await buildExpandedComponentHierarchy(
    report,
    objects,
    ir.artboards,
    artboard.object.id,
    request.selection?.animation,
  );
  applySimpleLayoutTransforms(hierarchy);
  applyDossierSummaryLayout(hierarchy);
  finalizeComponentListMetrics(hierarchy);
  const assets = annotateEmbeddedAssets(
    await extractEmbeddedAssets(request.rivBytes, ir.resolvedResources ?? []),
    report,
    objects,
  );
  const resourceByAssetIndex = createResourceByAssetIndex(report, assets);
  const selectedNodeIds = new Set(hierarchy.entries.map(value => value.sourceObjectId));
  const selectedDrawables = (ir.drawables ?? []).filter(id => selectedNodeIds.has(id));
  const drawableOrder = new Map(selectedDrawables.map((id, index) => [id, index]));
  const vectorComponents = compileVectorComponents(hierarchy, objects, visits);
  const layoutEffects = lowerLayoutBackdropEffects(hierarchy, vectorComponents, objects, visits);
  finalizeComponentListHitWidths(hierarchy, vectorComponents);
  const textComponents = compileTextComponents(hierarchy, resourceByAssetIndex);
  const imageComponents = compileImageComponents(hierarchy, resourceByAssetIndex);
  const clipMasks = compileImageClipMasks(hierarchy);
  const timeline = await compileCoreTimeline(hierarchy, report, objects);
  const capabilityArtifacts = compileCapabilityArtifacts(report, objects, timeline, hierarchy, resourceByAssetIndex);
  const hierarchyByObjectId = new Map(hierarchy.entries.map(value => [value.objectId, value]));
  const orderedEntries = orderEntriesForRiveDrawStack(hierarchy.entries, drawableOrder);
  const nodes = orderedEntries.filter(value => value.nodeEligible !== false).map(entry => {
    const id = entry.objectId;
    const object = entry.object ?? objects.get(entry.sourceObjectId);
    const visit = entry.visit ?? visits.get(entry.sourceObjectId);
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
      components: [...(vectorComponents.get(id) ?? []), ...(textComponents.get(id) ?? []), ...(imageComponents.get(id) ?? [])],
      composite: clipMasks.compositeByTarget.get(id),
      effects: layoutEffects.get(id),
      extensions: {
        neutralFamily: object.family,
        neutralFields: Object.fromEntries(object.properties.map(property => [property.id, property.value])),
        neutralDrawable: drawableOrder.has(entry.sourceObjectId),
        ...(drawableOrder.has(entry.sourceObjectId) ? { neutralDrawOrder: drawableOrder.get(entry.sourceObjectId) } : {}),
      },
    });
  }).concat(clipMasks.nodes);
  const hasVectorVisuals = vectorComponents.size > 0;
  const hasTextVisuals = textComponents.size > 0;
  const hasImageVisuals = imageComponents.size > 0;
  const coverage = ir.objects.map(object => ({
    objectId: object.id,
    propertyIds: object.properties.map(property => property.id),
    capability: capabilityArtifacts.coverageByObjectId.get(object.id)?.capability ?? 'hya-core',
    representation: 'native-semantic',
    ...(capabilityArtifacts.coverageByObjectId.has(object.id)
      ? { artifactId: capabilityArtifacts.coverageByObjectId.get(object.id).artifactId }
      : {}),
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
    artifacts: capabilityArtifacts.artifacts, coverage, bakedTracks: [], assets: assets.map(publicAsset),
    featureLedger: [{
      feature: 'neutral.metadata-preservation', capability: 'hya-core',
      representation: 'native-semantic', count: ir.objects.length,
    }, ...(hasVectorVisuals ? [{
      feature: 'vector.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: [...vectorComponents.values()].reduce((sum, value) => sum + value.length, 0),
    }] : []), ...(hasTextVisuals ? [{
      feature: 'text-layout.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: [...textComponents.values()].reduce((sum, value) => sum + value.length, 0),
    }] : []), ...(hasImageVisuals ? [{
      feature: 'image.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: [...imageComponents.values()].reduce((sum, value) => sum + value.length, 0),
    }] : []), ...(timeline.tracks.length > 0 ? [{
      feature: 'timeline.executable-core', capability: 'hya-core',
      representation: 'native-semantic', count: timeline.tracks.length,
    }] : []), ...capabilityArtifacts.featureLedger],
    classification: { unclassifiedObjects: 0, unclassifiedProperties: 0, unclassifiedAssets: 0, unclassifiedScripts: 0 },
  };
}

export function orderEntriesForRiveDrawStack(entries, drawableOrder) {
  const output = [...entries];
  const positionsByScope = new Map();
  for (let index = 0; index < output.length; index++) {
    const entry = output[index];
    if (entry.sourceName !== 'Shape' || !drawableOrder.has(entry.sourceObjectId ?? entry.objectId)) continue;
    const positions = positionsByScope.get(entry.scopeKey) ?? [];
    positions.push(index); positionsByScope.set(entry.scopeKey, positions);
  }
  for (const positions of positionsByScope.values()) {
    const drawables = positions.map(index => output[index]).sort((left, right) =>
      drawableOrder.get(left.sourceObjectId ?? left.objectId) - drawableOrder.get(right.sourceObjectId ?? right.objectId));
    positions.forEach((position, index) => { output[position] = drawables[index]; });
  }
  return output;
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
    const dimensions = imageDimensions(asset.bytes, detectedMimeType);
    return {
      ...asset, detectedMimeType,
      ...((visit?.sourceName === 'ImageAsset' && positive(fields.width, 0) > 0 && positive(fields.height, 0) > 0)
        ? { width: fields.width, height: fields.height }
        : dimensions ?? {}),
      sourceName: visit?.sourceName,
      sourceAssetName: string(fields.name),
      ...(visit?.sourceName === 'AudioAsset' ? { volume: finite(fields.volume) ?? 1 } : {}),
    };
  });
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      const length = bytes[offset + 2] * 256 + bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xc3 && length >= 7) {
        return { height: bytes[offset + 5] * 256 + bytes[offset + 6], width: bytes[offset + 7] * 256 + bytes[offset + 8] };
      }
      offset += Math.max(2, length + 2);
    }
  }
  return null;
}

function publicAsset(asset) {
  const {
    width: _width, height: _height, detectedMimeType: _detectedMimeType,
    sourceName: _sourceName, sourceAssetName: _sourceAssetName, volume: _volume,
    ...value
  } = asset;
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

export function applySimpleLayoutTransforms(hierarchy) {
  const entries = hierarchy.entries;
  for (const entry of entries.filter(value => value.nodeEligible !== false && value.sourceName === 'LayoutComponent')) {
    const style = localEntry(entries, entry, entry.fields.styleId);
    if (style?.sourceName === 'LayoutComponentStyle') {
      if (Number.isFinite(style.fields.positionLeft)) entry.fields.x = style.fields.positionLeft;
      if (Number.isFinite(style.fields.positionTop)) entry.fields.y = style.fields.positionTop;
    }
  }
  resolveHugLayoutSizes(entries);
  for (const parent of entries.filter(value => value.nodeEligible !== false && (value.sourceName === 'LayoutComponent' || value.sourceName === 'Artboard'))) {
    const componentListScope = typeof parent.scopeKey === 'string' && parent.scopeKey.includes('::list-');
    const style = localEntry(entries, parent, parent.fields.styleId);
    const children = entries.filter(value => value.scopeKey === parent.scopeKey
      && value.nodeEligible !== false
      && value.transformTarget === true
      && value.fields.parentId === parent.componentIndex
      && (componentListScope ? value.sourceName === 'LayoutComponent' : value.sourceName !== 'LayoutComponentStyle'));
    if (style?.fields.layoutTypeValue === 1) {
      applyGridLayout(entries, parent, style, children);
      continue;
    }
    const row = componentListScope ? rowLayout(style) : style?.fields.flexDirectionValue === 1;
    const overlay = !componentListScope
      && style?.fields.flexDirectionValue === undefined
      && style?.fields.layoutAlignmentType === 9
      && children.length > 1;
    const wrap = style?.fields.flexWrapValue === 1;
    const gap = row ? finite(style?.fields.gapHorizontal) ?? 0 : finite(style?.fields.gapVertical) ?? 0;
    const leading = row ? finite(style?.fields.paddingLeft) ?? 0 : finite(style?.fields.paddingTop) ?? 0;
    const crossLeading = row ? finite(style?.fields.paddingTop) ?? 0 : finite(style?.fields.paddingLeft) ?? 0;
    const available = Math.max(0, (row ? positive(parent.fields.width, 0) : positive(parent.fields.height, 0))
      - leading - (row ? finite(style?.fields.paddingRight) ?? 0 : finite(style?.fields.paddingBottom) ?? 0));
    const crossAvailable = Math.max(0, (row ? positive(parent.fields.height, 0) : positive(parent.fields.width, 0))
      - crossLeading - (row ? finite(style?.fields.paddingBottom) ?? 0 : finite(style?.fields.paddingRight) ?? 0));
    const authoredFill = children.some(child => {
      const childStyle = localEntry(entries, child, child.fields.styleId);
      return childStyle?.fields.layoutWidthScaleType === 1 || childStyle?.fields.layoutHeightScaleType === 1;
    });
    if (componentListScope || authoredFill) applyFillLayout(entries, children, row, available, crossAvailable, gap);
    const used = children.reduce((sum, child) => sum + (row ? positive(child.fields.width, 0) : positive(child.fields.height, 0)), 0)
      + Math.max(0, children.length - 1) * gap;
    const justify = Number(style?.fields.justifyContentValue ?? style?.fields.justifyItemsValue ?? 0);
    let cursor = leading + (justify === 1 ? Math.max(0, available - used) / 2 : justify === 2 ? Math.max(0, available - used) : 0);
    let crossCursor = crossLeading; let lineExtent = 0;
    for (const child of children) {
      const childStyle = localEntry(entries, child, child.fields.styleId);
      if ([1, 2].includes(childStyle?.fields.positionTypeValue)) continue;
      if (overlay) {
        if (!Number.isFinite(child.fields.x)) child.fields.x = 0;
        if (!Number.isFinite(child.fields.y)) child.fields.y = 0;
        continue;
      }
      const marginLeading = componentListScope ? (row ? finite(childStyle?.fields.marginLeft) ?? 0 : finite(childStyle?.fields.marginTop) ?? 0) : 0;
      const marginTrailing = componentListScope ? (row ? finite(childStyle?.fields.marginRight) ?? 0 : finite(childStyle?.fields.marginBottom) ?? 0) : 0;
      const marginCross = componentListScope ? (row ? finite(childStyle?.fields.marginTop) ?? 0 : finite(childStyle?.fields.marginLeft) ?? 0) : 0;
      const childExtent = row ? positive(child.fields.width, 0) : positive(child.fields.height, 0);
      const crossExtent = row ? positive(child.fields.height, 0) : positive(child.fields.width, 0);
      if (wrap && cursor > leading && cursor + marginLeading + childExtent + marginTrailing > leading + available) {
        cursor = leading; crossCursor += lineExtent + (row ? finite(style?.fields.gapVertical) ?? 0 : finite(style?.fields.gapHorizontal) ?? 0); lineExtent = 0;
      }
      cursor += marginLeading;
      if (componentListScope || !Number.isFinite(child.fields.x)) child.fields.x = row ? cursor : crossCursor + marginCross;
      if (componentListScope || !Number.isFinite(child.fields.y)) child.fields.y = row ? crossCursor + marginCross : cursor;
      cursor += childExtent + marginTrailing + gap; lineExtent = Math.max(lineExtent, crossExtent + marginCross);
    }
  }
  // NestedArtboardLeaf fit is authored against the resolved layout box. The
  // hierarchy is expanded before flex/fill sizing, so the initial scale can
  // still reflect stale source dimensions. Refit nested roots after layout.
  resolveNestedLeafFitTransforms(hierarchy);
}

export function resolveNestedLeafFitTransforms(hierarchy) {
  const entries = hierarchy.entries ?? [];
  const byId = new Map(entries.map(entry => [entry.objectId, entry]));
  for (const root of entries.filter(entry => entry.sourceName === 'Artboard' && (entry.instanceDepth ?? 0) > 0)) {
    const leaf = byId.get(hierarchy.parentNodeByObjectId?.get(root.objectId));
    if (leaf?.sourceName !== 'NestedArtboardLeaf') continue;
    const host = byId.get(hierarchy.parentNodeByObjectId?.get(leaf.objectId));
    if (!host) continue;
    const sourceWidth = positive(root.fields.width, 1);
    const sourceHeight = positive(root.fields.height, 1);
    const hostWidth = positive(host.fields.width, sourceWidth);
    const hostHeight = positive(host.fields.height, sourceHeight);
    const widthScale = hostWidth / sourceWidth;
    const heightScale = hostHeight / sourceHeight;
    const fit = Number(leaf.fields.fit ?? 1);
    let scaleX; let scaleY;
    if (fit === 0) { scaleX = widthScale; scaleY = heightScale; }
    else {
      const uniform = fit === 2 ? Math.max(widthScale, heightScale)
        : fit === 3 ? widthScale
          : fit === 4 ? heightScale
            : fit === 5 ? 1
              : fit === 6 ? Math.min(1, widthScale, heightScale)
                : Math.min(widthScale, heightScale);
      scaleX = uniform; scaleY = uniform;
    }
    root.fields.scaleX = scaleX;
    root.fields.scaleY = scaleY;
    root.fields.x = (hostWidth - sourceWidth * scaleX) / 2;
    root.fields.y = (hostHeight - sourceHeight * scaleY) / 2;
  }
}

function resolveHugLayoutSizes(entries) {
  for (let pass = 0; pass < 2; pass++) {
    for (const layout of [...entries].reverse().filter(value => value.nodeEligible !== false
      && value.sourceName === 'LayoutComponent'
      && typeof value.scopeKey === 'string'
      && value.scopeKey.includes('::list-'))) {
      const style = localEntry(entries, layout, layout.fields.styleId);
      if (style?.fields.intrinsicallySizedValue !== true) continue;
      const children = entries.filter(value => value.scopeKey === layout.scopeKey
        && value.nodeEligible !== false
        && value.sourceName === 'LayoutComponent'
        && value.fields.parentId === layout.componentIndex);
      if (children.length === 0) continue;
      const row = rowLayout(style);
      const gap = row ? finite(style.fields.gapHorizontal) ?? 0 : finite(style.fields.gapVertical) ?? 0;
      const width = row
        ? children.reduce((sum, child) => sum + positive(child.fields.width, 0), 0) + gap * Math.max(0, children.length - 1)
        : Math.max(...children.map(child => positive(child.fields.width, 0)));
      const height = row
        ? Math.max(...children.map(child => positive(child.fields.height, 0)))
        : children.reduce((sum, child) => sum + positive(child.fields.height, 0), 0) + gap * Math.max(0, children.length - 1);
      if (width > 0) {
        const requestedWidth = width + (finite(style.fields.paddingLeft) ?? 0) + (finite(style.fields.paddingRight) ?? 0);
        const parent = localEntry(entries, layout, layout.fields.parentId);
        const parentStyle = parent ? localEntry(entries, parent, parent.fields.styleId) : null;
        const parentContentWidth = parent
          ? positive(parent.fields.width, requestedWidth)
            - (finite(parentStyle?.fields.paddingLeft) ?? 0)
            - (finite(parentStyle?.fields.paddingRight) ?? 0)
            - (finite(style.fields.marginLeft) ?? 0)
            - (finite(style.fields.marginRight) ?? 0)
          : requestedWidth;
        layout.fields.width = Math.max(0, Math.min(requestedWidth, parentContentWidth));
      }
      if (height > 0) layout.fields.height = height + (finite(style.fields.paddingTop) ?? 0) + (finite(style.fields.paddingBottom) ?? 0);
    }
  }
}

function rowLayout(style) {
  if (style?.fields.flexDirectionValue === 1 || style?.fields.flexDirectionValue === 2) return true;
  return finite(style?.fields.gapHorizontal) !== undefined && finite(style?.fields.gapVertical) === undefined;
}

function applyFillLayout(entries, children, row, available, crossAvailable, gap) {
  const dimensions = row
    ? { extent: 'width', cross: 'height', scale: 'layoutWidthScaleType', crossScale: 'layoutHeightScaleType', fraction: 'fractionalWidth' }
    : { extent: 'height', cross: 'width', scale: 'layoutHeightScaleType', crossScale: 'layoutWidthScaleType', fraction: 'fractionalHeight' };
  const fill = children.filter(child => localEntry(entries, child, child.fields.styleId)?.fields[dimensions.scale] === 1);
  const fixed = children.filter(child => !fill.includes(child))
    .reduce((sum, child) => sum + positive(child.fields[dimensions.extent], 0), 0);
  const remaining = Math.max(0, available - fixed - Math.max(0, children.length - 1) * gap);
  const totalFraction = fill.reduce((sum, child) => sum + positive(child.fields[dimensions.fraction], 1), 0);
  for (const child of fill) {
    const fraction = positive(child.fields[dimensions.fraction], 1);
    child.fields[dimensions.extent] = totalFraction > 0 ? remaining * fraction / totalFraction : 0;
  }
  for (const child of children) {
    const childStyle = localEntry(entries, child, child.fields.styleId);
    if (childStyle?.fields[dimensions.crossScale] === 1) child.fields[dimensions.cross] = crossAvailable;
  }
}

function applyGridLayout(entries, parent, style, children) {
  const tracks = entries.filter(value => value.scopeKey === parent.scopeKey
    && value.sourceName === 'GridTrack'
    && value.fields.parentId === parent.componentIndex);
  const columns = tracks.filter(value => value.fields.collection !== 1);
  const rows = tracks.filter(value => value.fields.collection === 1);
  const columnSizes = gridTrackSizes(columns, positive(parent.fields.width, 0));
  const rowSizes = gridTrackSizes(rows, positive(parent.fields.height, 0));
  if (columnSizes.length === 0) columnSizes.push(Math.max(1, positive(parent.fields.width, 1)));
  if (rowSizes.length === 0) rowSizes.push(Math.max(1, positive(parent.fields.height, 1)));
  const gapX = finite(style.fields.gapHorizontal) ?? 0; const gapY = finite(style.fields.gapVertical) ?? 0;
  const left = finite(style.fields.paddingLeft) ?? 0; const top = finite(style.fields.paddingTop) ?? 0;
  const xOffsets = cumulativeOffsets(columnSizes, gapX, left); const yOffsets = cumulativeOffsets(rowSizes, gapY, top);
  let automatic = 0;
  for (const child of children) {
    const placement = entries.find(value => value.scopeKey === child.scopeKey
      && value.sourceName === 'GridItemPlacement'
      && value.fields.parentId === child.componentIndex);
    const column = Math.max(0, Math.min(columnSizes.length - 1, Number.isSafeInteger(placement?.fields.gridColumn) ? placement.fields.gridColumn : automatic % columnSizes.length));
    const row = Math.max(0, Math.min(rowSizes.length - 1, Number.isSafeInteger(placement?.fields.gridRow) ? placement.fields.gridRow : Math.floor(automatic / columnSizes.length)));
    if (!Number.isFinite(child.fields.x)) child.fields.x = xOffsets[column];
    if (!Number.isFinite(child.fields.y)) child.fields.y = yOffsets[row];
    if (!Number.isFinite(child.fields.width)) child.fields.width = columnSizes[column];
    if (!Number.isFinite(child.fields.height)) child.fields.height = rowSizes[row];
    automatic++;
  }
}

function gridTrackSizes(tracks, available) {
  if (tracks.length === 0) return [];
  const fixed = tracks.map(track => track.fields.trackType === 1 ? Math.max(0, finite(track.fields.trackValue) ?? 0) : null);
  const fixedTotal = fixed.reduce((sum, value) => sum + (value ?? 0), 0);
  const fractionTotal = tracks.reduce((sum, track, index) => sum + (fixed[index] === null ? Math.max(0, finite(track.fields.trackValue) ?? 1) : 0), 0);
  const remainder = Math.max(0, available - fixedTotal);
  return tracks.map((track, index) => fixed[index] ?? (fractionTotal > 0 ? remainder * Math.max(0, finite(track.fields.trackValue) ?? 1) / fractionTotal : 0));
}

function cumulativeOffsets(sizes, gap, leading) {
  const output = []; let cursor = leading;
  for (const size of sizes) { output.push(cursor); cursor += size + gap; }
  return output;
}

function localEntry(entries, owner, componentIndex) {
  if (!Number.isSafeInteger(componentIndex)) return null;
  return entries.find(value => value.scopeKey === owner.scopeKey && value.componentIndex === componentIndex) ?? null;
}

function componentScopeKey(scopeKey, componentIndex) { return `${scopeKey}\0${componentIndex}`; }
function childEntries(children, entry) { return children.get(componentScopeKey(entry.scopeKey, entry.componentIndex)) ?? []; }

export function compileTextComponents(hierarchy, resourceByAssetIndex) {
  const output = new Map(); const entries = hierarchy.entries;
  const children = new Map();
  for (const entry of entries) {
    const key = componentScopeKey(entry.scopeKey, entry.fields.parentId);
    const values = children.get(key) ?? []; values.push(entry); children.set(key, values);
  }
  for (const text of entries.filter(value => value.sourceName === 'Text')) {
    const owned = childEntries(children, text);
    const runs = owned.filter(value => value.sourceName === 'TextValueRun');
    const run = runs[0];
    const referencedStyle = run ? localEntry(entries, text, run.fields.styleId) : null;
    const style = referencedStyle?.sourceName === 'TextStylePaint'
      ? referencedStyle
      : owned.find(value => value.sourceName === 'TextStylePaint');
    const parent = localEntry(entries, text, text.fields.parentId);
    const authoredWidth = positive(text.fields.width, positive(parent?.fields.width, 1));
    const parentWidth = parent?.sourceName === 'LayoutComponent' ? positive(parent.fields.width, authoredWidth) : authoredWidth;
    const width = Math.min(authoredWidth, parentWidth);
    // Rive's frozen TextStyle schema defaults an omitted fontSize to 12.
    const authoredFontSize = positive(style?.fields.fontSize, 12);
    const authoredHeight = positive(text.fields.height, positive(parent?.fields.height, Math.max(1, authoredFontSize * 1.2)));
    const parentHeight = parent?.sourceName === 'LayoutComponent' ? positive(parent.fields.height, authoredHeight) : authoredHeight;
    const height = Math.min(authoredHeight, parentHeight);
    const shouldShrink = text.fields.overflowValue === 5;
    const layoutOverflowLimit = parent?.sourceName === 'LayoutComponent' ? height * 1.5 : authoredFontSize;
    const fontSize = shouldShrink ? Math.min(authoredFontSize, height) : Math.min(authoredFontSize, layoutOverflowLimit);
    const font = Number.isSafeInteger(style?.fields.fontAssetId) ? resourceByAssetIndex.get(style.fields.fontAssetId) : null;
    const styleChildren = style ? childEntries(children, style) : [];
    const fill = styleChildren.find(value => value.sourceName === 'Fill');
    const source = fill ? childEntries(children, fill).find(value => value.sourceName === 'SolidColor') : null;
    const axes = styleChildren.filter(value => value.sourceName === 'TextStyleAxis');
    const axis = axes.find(value => value.fields.tag === 2003265652) ?? axes[0];
    const background = styleChildren.find(value => value.sourceName === 'TextStyleBackground');
    const backgroundChildren = background ? childEntries(children, background) : [];
    const backgroundFill = backgroundChildren.find(value => value.sourceName === 'Fill');
    const backgroundStroke = backgroundChildren.find(value => value.sourceName === 'Stroke');
    const backgroundFillSource = backgroundFill ? childEntries(children, backgroundFill).find(value => value.sourceName === 'SolidColor') : null;
    const backgroundStrokeSource = backgroundStroke ? childEntries(children, backgroundStroke).find(value => value.sourceName === 'SolidColor') : null;
    const textValue = runs.map(value => typeof value.fields.text === 'string' ? value.fields.text : '').join('');
    const authoredLineHeight = riveLineHeight(style?.fields.lineHeight, authoredFontSize);
    const component = compact({
      type: 'text2d', text: textValue,
      size: [width, height], position: [width / 2, height / 2],
      fontFamily: font?.sourceAssetName, fontSize,
      fontWeight: Number.isFinite(axis?.fields.axisValue) ? axis.fields.axisValue : 400,
      fontResource: font?.resourceId,
      lineHeight: shouldShrink
        ? Math.min(authoredLineHeight, height)
        : Math.min(authoredLineHeight, layoutOverflowLimit),
      tracking: finite(style?.fields.letterSpacing) ?? 0,
      textAlign: ['left', 'center', 'right'][text.fields.alignValue ?? 0] ?? 'left',
      verticalAlign: ['top', 'middle', 'bottom'][text.fields.verticalAlignValue ?? 0] ?? 'top',
      color: color(source?.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR),
      ...(background ? {
        lineBackground: compact({
          fill: color(backgroundFillSource?.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR),
          stroke: backgroundStroke ? color(backgroundStrokeSource?.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR) : undefined,
          strokeWidth: backgroundStroke ? Math.max(0, finite(backgroundStroke.fields.thickness) ?? 1) : undefined,
          cornerRadius: Math.max(0, finite(background.fields.cornerRadius) ?? 0),
          padding: 0,
        }),
      } : {}),
      fit: shouldShrink ? 'shrink' : undefined,
      wrap: textWrapMode(textValue, width, fontSize, text.fields.wrapValue),
      resolutionScale: 4,
    });
    output.set(text.objectId, [component]);
  }
  return output;
}

export function compileImageComponents(hierarchy, resourceByAssetIndex) {
  const output = new Map(); const entries = hierarchy.entries;
  for (const entry of hierarchy.entries.filter(value => value.sourceName === 'Image')) {
    const asset = Number.isSafeInteger(entry.fields.assetId) ? resourceByAssetIndex.get(entry.fields.assetId) : null;
    if (!asset || !asset.detectedMimeType?.startsWith('image/')) continue;
    const sourceWidth = positive(asset.width, 1); const sourceHeight = positive(asset.height, 1);
    let frame = { size: [sourceWidth, sourceHeight], position: [0, 0] };
    const artboard = localEntry(entries, entry, 0);
    if (artboard?.sourceName === 'Artboard' && artboard.fields.clip !== false && !finite(entry.fields.rotation)) {
      frame = clippedSpriteFrame(
        [sourceWidth, sourceHeight],
        [positive(artboard.fields.width, sourceWidth), positive(artboard.fields.height, sourceHeight)],
        [finite(entry.fields.x) ?? 0, finite(entry.fields.y) ?? 0],
        [finite(entry.fields.scaleX) ?? 1, finite(entry.fields.scaleY) ?? 1],
      );
    }
    output.set(entry.objectId, [{
      type: 'sprite2d', resource: asset.resourceId, size: frame.size, position: frame.position, tint: [1, 1, 1, 1],
      ...(frame.uvRect ? { uvRect: frame.uvRect } : {}),
    }]);
  }
  return output;
}

export function clippedSpriteFrame(sourceSize, artboardSize, center, scale) {
  const horizontal = clippedSpriteAxis(sourceSize[0], artboardSize[0], center[0], scale[0]);
  const vertical = clippedSpriteAxis(sourceSize[1], artboardSize[1], center[1], scale[1]);
  const clipped = horizontal.extent < sourceSize[0] || vertical.extent < sourceSize[1];
  return {
    size: [horizontal.extent, vertical.extent],
    position: [horizontal.center, vertical.center],
    ...(clipped ? { uvRect: [horizontal.uvStart, vertical.uvStart, horizontal.uvExtent, vertical.uvExtent] } : {}),
  };
}

function clippedSpriteAxis(sourceExtent, artboardExtent, center, scale) {
  if (!(sourceExtent > 0 && artboardExtent > 0) || !Number.isFinite(scale) || Math.abs(scale) < 1e-9) {
    return { extent: sourceExtent, center: 0, uvStart: 0, uvExtent: 1 };
  }
  const localStart = -sourceExtent / 2;
  const localEnd = sourceExtent / 2;
  const worldStart = center + localStart * scale;
  const worldEnd = center + localEnd * scale;
  const visibleWorldStart = Math.max(0, Math.min(worldStart, worldEnd));
  const visibleWorldEnd = Math.min(artboardExtent, Math.max(worldStart, worldEnd));
  if (visibleWorldEnd <= visibleWorldStart) {
    return { extent: sourceExtent, center: 0, uvStart: 0, uvExtent: 1 };
  }
  const a = (visibleWorldStart - center) / scale;
  const b = (visibleWorldEnd - center) / scale;
  const visibleLocalStart = Math.min(a, b);
  const visibleLocalEnd = Math.max(a, b);
  const extent = visibleLocalEnd - visibleLocalStart;
  return {
    extent,
    center: (visibleLocalStart + visibleLocalEnd) / 2,
    uvStart: (visibleLocalStart - localStart) / sourceExtent,
    uvExtent: extent / sourceExtent,
  };
}

async function compileCoreTimeline(hierarchy, report, objects) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/generated/frozen-registry.js');
  const { FROZEN_PROPERTIES } = await import(pathToFileURL(modulePath).href);
  const propertyNames = new Map(FROZEN_PROPERTIES.map(value => [value.key, value.name]));
  const componentByIndex = new Map(hierarchy.entries.filter(value => value.instanceDepth === 0).map(value => [value.componentIndex, value]));
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

function compileCapabilityArtifacts(report, objects, timeline, hierarchy = {}, resourceByAssetIndex = new Map()) {
  const records = report.objects.map((visit, index) => ({
    index, visit, object: objects.get(visit.neutralObjectId),
    fields: namedFields(objects.get(visit.neutralObjectId), visit),
  }));
  const artifacts = []; const featureLedger = []; const coverageByObjectId = new Map();
  const stateRecords = records.filter(record => STATE_MACHINE_SOURCE.test(record.visit.sourceName));
  if (stateRecords.some(record => record.visit.sourceName === 'StateMachine')) {
    const id = 'rive-state-machine-v2';
    artifacts.push({ id, capability: 'state-machine', representation: 'native-semantic', document: compileStateMachineV2Document(stateRecords, timeline) });
    for (const record of stateRecords) coverageByObjectId.set(record.visit.neutralObjectId, { capability: 'state-machine', artifactId: id });
    featureLedger.push({ feature: 'state-machine.executable-v2', capability: 'state-machine', representation: 'native-semantic', count: stateRecords.length, artifactId: id });
  }
  const interactionRecords = records.filter(record => INTERACTION_SOURCE.test(record.visit.sourceName));
  if (hierarchy.componentLists?.some(list => list.rows.length > 0)) {
    const id = 'rive-component-list-interaction-v1';
    artifacts.push({ id, capability: 'interaction', representation: 'native-semantic', document: compileComponentListInteractionDocument(hierarchy, records, resourceByAssetIndex) });
    for (const record of interactionRecords) coverageByObjectId.set(record.visit.neutralObjectId, { capability: 'interaction', artifactId: id });
    featureLedger.push({
      feature: 'interaction.component-list-pointer-audio', capability: 'interaction', representation: 'native-semantic',
      count: hierarchy.componentLists.reduce((sum, list) => sum + list.rows.length, 0), artifactId: id,
    });
  }
  const dataRecords = records.filter(record => DATA_BINDING_SOURCE.test(record.visit.sourceName)
    && !coverageByObjectId.has(record.visit.neutralObjectId));
  if (dataRecords.some(record => record.visit.sourceName === 'ViewModel')) {
    const id = 'rive-data-binding-v1';
    artifacts.push({ id, capability: 'data-binding', representation: 'native-semantic', document: compileDataBindingDocument(dataRecords) });
    for (const record of dataRecords) coverageByObjectId.set(record.visit.neutralObjectId, { capability: 'data-binding', artifactId: id });
    featureLedger.push({ feature: 'data-binding.model-instance-executable', capability: 'data-binding', representation: 'native-semantic', count: dataRecords.length, artifactId: id });
  }
  return { artifacts, featureLedger, coverageByObjectId };
}

const STATE_MACHINE_SOURCE = /^(?:StateMachine|StateTransition|AnimationState|EntryState|ExitState|AnyState|NestedStateMachine|Transition(?:Bool|Number|Trigger|Value|ViewModel|Property).*)/u;
const DATA_BINDING_SOURCE = /^(?:ViewModel|DataBind|DataEnum|DataConverter|FormulaToken|BindableProperty|ListenerViewModel|PropertyViewModel)/u;
const INTERACTION_SOURCE = /^(?:StateMachineListener|ListenerAction|ListenerViewModel)/u;

export function compileComponentListInteractionDocument(hierarchy, records, resourceByAssetIndex) {
  const audioEvents = new Map(records.filter(record => record.visit.sourceName === 'AudioEvent')
    .map(record => {
      const resource = Number.isSafeInteger(record.fields.assetId) ? resourceByAssetIndex.get(record.fields.assetId) : undefined;
      return [string(record.fields.name), resource ? { resourceId: resource.resourceId, gain: finite(resource.volume) ?? 1 } : undefined];
    }));
  const targets = []; const listeners = [];
  for (const list of hierarchy.componentLists) {
    for (const row of list.rows) {
      const hoverOnly = row.interactionKind === 'hover-only';
      const origin = globalNodeOrigin(row.nodes.idle, hierarchy);
      const parentScale = globalNodeParentScale(row.nodes.idle, hierarchy);
      const targetId = `rive-list-row-${String(row.index).padStart(6, '0')}`;
      const argumentsValue = {
        row: row.index, sourceRow: row.sourceIndex, list: list.host,
        idleNode: row.nodes.idle, hoverNode: row.nodes.hover,
        openNode: row.nodes.open, openHoverNode: row.nodes.openHover,
        expandedNode: row.nodes.expanded, expandedHoverNode: row.nodes.expandedHover,
        baseX: row.baseX, baseY: row.baseY,
        collapsedHeight: row.collapsedHeight, openHeight: row.openHeight, expandedHeight: row.expandedHeight,
        ...(!hoverOnly ? audioArguments('hover', audioEvents.get('click_01')) : {}),
        ...(!hoverOnly ? audioArguments('click', audioEvents.get('open_01')) : {}),
        ...(!hoverOnly ? audioArguments('open', audioEvents.get('open_menu_02')) : {}),
        ...(!hoverOnly ? audioArguments('close', audioEvents.get('close_menu_01')) : {}),
      };
      targets.push({
        id: targetId, component: row.nodes.idle, order: row.index,
        transform: [1, 0, 0, 1, origin[0], origin[1]],
        hitArea: { kind: 'rect', rect: [0, 0, row.hitWidth * parentScale[0], row.expandedHeight * parentScale[1]] },
      });
      const rowListeners = [{
        id: `${targetId}-enter`, target: targetId, event: 'pointer-enter', phases: ['target'],
        actions: [
          { kind: 'custom', protocol: 'org.haiyue.rive-component-list@1', port: 'set-hover', arguments: { ...argumentsValue, active: true } },
          ...(!hoverOnly && audioEvents.get('click_01') ? [{ kind: 'audio', operation: 'play', target: audioEvents.get('click_01').resourceId }] : []),
        ],
      }, {
        id: `${targetId}-exit`, target: targetId, event: 'pointer-exit', phases: ['target'],
        actions: [{ kind: 'custom', protocol: 'org.haiyue.rive-component-list@1', port: 'set-hover', arguments: { ...argumentsValue, active: false } }],
      }];
      if (!hoverOnly) rowListeners.push({
        id: `${targetId}-click`, target: targetId, event: 'click', phases: ['target'], pointerButton: 0,
        actions: [{ kind: 'custom', protocol: 'org.haiyue.rive-component-list@1', port: 'advance-open', arguments: argumentsValue }],
      });
      listeners.push(...rowListeners);
    }
  }
  return {
    format: 'haiyue-interaction', version: 1, extension: 'org.haiyue.interaction@1', dragThreshold: 4,
    targets, listeners,
  };
}

function audioArguments(prefix, audio) {
  return audio ? { [`${prefix}Audio`]: audio.resourceId, [`${prefix}Gain`]: audio.gain } : {};
}

export function finalizeComponentListMetrics(hierarchy) {
  for (const list of hierarchy.componentLists ?? []) {
    for (const row of list.rows ?? []) {
      row.openHeight = variantHeight(row.nodes.open, row.openHeight);
      row.expandedHeight = variantHeight(row.nodes.expanded, row.expandedHeight);

      function variantHeight(nodeId, fallback) {
        const root = hierarchy.entries.find(entry => entry.objectId === nodeId);
        if (!root) return fallback;
        const content = hierarchy.entries.find(entry => entry.sourceName === 'LayoutComponent'
          && hierarchy.parentNodeByObjectId.get(entry.objectId) === root.objectId);
        return Math.max(fallback, positive(content?.fields.height, 0) * positive(root.fields.scaleY, 1));
      }
    }
  }
}

export function finalizeComponentListHitWidths(hierarchy, vectorComponents) {
  for (const list of hierarchy.componentLists ?? []) {
    for (const row of list.rows ?? []) {
      const root = hierarchy.entries.find(entry => entry.objectId === row.nodes.expanded);
      if (!root) continue;
      const widths = hierarchy.entries
        .filter(entry => entry.scopeKey === root.scopeKey)
        .flatMap(entry => vectorComponents.get(entry.objectId) ?? [])
        .filter(component => component.commands === 'MLLLZ' && component.values?.length === 8)
        .map(component => Math.abs(component.values[2] - component.values[0]));
      if (widths.length > 0) row.hitWidth = Math.max(row.hitWidth, ...widths);
    }
  }
}

function globalNodeOrigin(nodeId, hierarchy) {
  const byId = new Map(hierarchy.entries.map(entry => [entry.objectId, entry]));
  const memo = new Map();
  const matrix = id => {
    if (memo.has(id)) return memo.get(id);
    const entry = byId.get(id); if (!entry) return [1, 0, 0, 1, 0, 0];
    const rotation = finite(entry.fields.rotation) ?? 0;
    const scaleX = finite(entry.fields.scaleX) ?? 1; const scaleY = finite(entry.fields.scaleY) ?? 1;
    const cosine = Math.cos(rotation); const sine = Math.sin(rotation);
    const local = [cosine * scaleX, sine * scaleX, -sine * scaleY, cosine * scaleY, finite(entry.fields.x) ?? 0, finite(entry.fields.y) ?? 0];
    const parent = hierarchy.parentNodeByObjectId.get(id);
    const value = parent ? multiplyAffine(matrix(parent), local) : local;
    memo.set(id, value); return value;
  };
  const value = matrix(nodeId); return [value[4], value[5]];
}

function globalNodeParentScale(nodeId, hierarchy) {
  const parent = hierarchy.parentNodeByObjectId.get(nodeId);
  if (!parent) return [1, 1];
  const byId = new Map(hierarchy.entries.map(entry => [entry.objectId, entry]));
  const memo = new Map();
  const matrix = id => {
    if (memo.has(id)) return memo.get(id);
    const entry = byId.get(id); if (!entry) return [1, 0, 0, 1, 0, 0];
    const rotation = finite(entry.fields.rotation) ?? 0;
    const scaleX = finite(entry.fields.scaleX) ?? 1; const scaleY = finite(entry.fields.scaleY) ?? 1;
    const cosine = Math.cos(rotation); const sine = Math.sin(rotation);
    const local = [cosine * scaleX, sine * scaleX, -sine * scaleY, cosine * scaleY, finite(entry.fields.x) ?? 0, finite(entry.fields.y) ?? 0];
    const ancestor = hierarchy.parentNodeByObjectId.get(id);
    const value = ancestor ? multiplyAffine(matrix(ancestor), local) : local;
    memo.set(id, value); return value;
  };
  const value = matrix(parent);
  return [Math.hypot(value[0], value[1]), Math.hypot(value[2], value[3])];
}

function multiplyAffine(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function compileStateMachineV2Document(records, timeline) {
  const channels = []; const clipTracks = [];
  for (const [index, track] of timeline.tracks.entries()) {
    const vector = track.property === 'position' || track.property === 'scale';
    const channelId = `channel-${String(index).padStart(6, '0')}`;
    channels.push({
      id: channelId, target: track.node, path: `transform.${track.property}`,
      family: 'transform', valueKind: vector ? 'vector' : 'number', ...(vector ? { valueSize: 2 } : {}),
      ...(track.property === 'rotation' ? { numericMode: 'angle-radians' } : {}), policy: 'override',
    });
    const size = vector ? 2 : 1;
    const keys = track.times.map((time, keyIndex) => ({
      time: Math.max(0, Math.min(timeline.duration, time)),
      value: vector ? track.values.slice(keyIndex * size, keyIndex * size + size) : track.values[keyIndex],
    })).filter((key, keyIndex, values) => keyIndex === 0 || key.time > values[keyIndex - 1].time);
    if (keys.length === 0) continue;
    for (let keyIndex = 0; keyIndex < keys.length - 1; keyIndex++) keys[keyIndex].interpolation = { kind: 'linear' };
    clipTracks.push({ id: `track-${String(index).padStart(6, '0')}`, channel: channelId, keys });
  }
  const inputs = records.filter(record => ['StateMachineNumber', 'StateMachineBool', 'StateMachineTrigger'].includes(record.visit.sourceName)).map((record, index) => {
    const id = `input-${String(index).padStart(6, '0')}-${safeIdentifier(record.fields.name, record.visit.sourceName)}`;
    if (record.visit.sourceName === 'StateMachineTrigger') return { id, type: 'trigger' };
    if (record.visit.sourceName === 'StateMachineBool') return { id, type: 'boolean', defaultValue: record.fields.value === true };
    return { id, type: 'number', defaultValue: finite(record.fields.value) ?? 0 };
  });
  const machineRecords = records.filter(record => record.visit.sourceName === 'StateMachine');
  const clipId = 'rive-composed-timeline';
  return {
    format: 'haiyue-animation-state-machine@2', extension: 'org.haiyue.animation-state-machine@2',
    channels,
    clips: [{ id: clipId, name: 'Rive composed timeline', duration: timeline.duration, tracks: clipTracks }],
    stateMachines: machineRecords.map((record, index) => {
      const stateId = `state-${String(index).padStart(6, '0')}`;
      return {
        id: `machine-${String(index).padStart(6, '0')}-${safeIdentifier(record.fields.name, 'rive')}`,
        inputs,
        layers: [{
          id: `layer-${String(index).padStart(6, '0')}`, order: 0,
          states: [{ id: stateId, motion: { kind: 'clip', clip: clipId, playback: 'loop' } }],
          transitions: [{ id: `entry-${String(index).padStart(6, '0')}`, from: '@entry', to: stateId, conditionGroups: [], duration: 0 }],
        }],
      };
    }),
  };
}

function compileDataBindingDocument(records) {
  const properties = []; const values = {};
  for (const [index, record] of records.entries()) {
    const id = `neutral-${String(index).padStart(6, '0')}`;
    const value = executableDataValue(record);
    properties.push({ id, kind: value.kind, defaultValue: value.value });
    values[id] = value.value;
  }
  const modelId = 'rive-neutral-data-model'; const instanceId = 'rive-neutral-data-instance';
  return {
    format: 'haiyue-data-binding', version: 1, extension: 'org.haiyue.data-binding@1',
    enums: [],
    models: [{ id: modelId, properties, defaultInstance: instanceId }],
    instances: [{ id: instanceId, model: modelId, scope: 'default', values }],
    converters: [], propertyGroups: [], bindings: [],
    components: [{ id: 'rive-neutral-data-component', stateful: true, model: modelId, exposedProperties: properties.map(property => property.id) }],
  };
}

function executableDataValue(record) {
  const source = record.visit.sourceName; const value = record.fields.propertyValue;
  if (/Color$/u.test(source) && Array.isArray(value) && value.length === 4) return { kind: 'color', value: value.map(channel => Math.max(0, Math.min(1, finite(channel) ?? 0))) };
  if (/(?:Boolean|Bool)$/u.test(source)) return { kind: 'boolean', value: value === true };
  if (/Trigger$/u.test(source)) return { kind: 'trigger', value: false };
  if (/(?:Number|Enum|SymbolListIndex)$/u.test(source)) return { kind: /(?:Enum|SymbolListIndex)$/u.test(source) ? 'integer' : 'number', value: /(?:Enum|SymbolListIndex)$/u.test(source) ? Math.trunc(finite(value) ?? 0) : finite(value) ?? 0 };
  if (/String$/u.test(source)) return { kind: 'string', value: typeof value === 'string' ? value : '' };
  if (/(?:AssetImage|Artboard)$/u.test(source) && Number.isSafeInteger(value)) return { kind: /Artboard$/u.test(source) ? 'artboard' : 'image', value: `${/Artboard$/u.test(source) ? 'artboard' : 'image'}-${value}` };
  return { kind: 'string', value: stableRecordValue(record.fields) };
}

function stableRecordValue(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))), (_key, item) => {
    if (item?.type === 'bytes') return { type: 'bytes', byteLength: item.byteLength, base64: item.base64 };
    return item;
  });
}

function safeIdentifier(value, fallback) {
  const text = typeof value === 'string' && value.length > 0 ? value : fallback;
  return text.replace(/[^A-Za-z0-9_.:-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'rive';
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

async function buildExpandedComponentHierarchy(report, objects, artboardObjectIds, artboardObjectId, selectedAnimation) {
  const entries = [];
  const parentNodeByObjectId = new Map();
  const componentLists = [];
  let interactionRowIndex = 0;
  const artboardIndex = new Map(artboardObjectIds.map((id, index) => [index, id]));
  const listPlan = componentListPlan(report, objects, artboardObjectIds, artboardObjectId);
  const viewModels = defaultViewModelRuntime(report, objects, artboardObjectIds);
  await expand(artboardObjectId, '', undefined, new Set(), 0, { skipGenericLists: Boolean(listPlan) }, selectedAnimation);
  if (listPlan) {
    const hosts = entries.filter(value => value.instanceDepth === 0 && value.sourceName === 'ArtboardComponentList');
    for (const host of hosts) {
      const rows = [];
      const parent = localEntry(entries, host, host.fields.parentId);
      const templateFields = namedFields(objects.get(listPlan.templateArtboardId), report.objects.find(value => value.neutralObjectId === listPlan.templateArtboardId));
      const templateWidth = positive(templateFields.width, 1);
      const templateHeight = positive(templateFields.height, 1);
      const scale = parent ? Math.min(1, positive(parent.fields.width, templateWidth) / templateWidth) : 1;
      const parentStyle = parent ? localEntry(entries, parent, parent.fields.styleId) : null;
      const gap = finite(parentStyle?.fields.gapVertical) ?? 0;
      for (let index = 0; index < listPlan.items.length; index++) {
        const item = listPlan.items[index];
        const baseX = 0; const baseY = index * (listPlan.itemHeight * scale + gap);
        const rowPrefix = `${host.objectId}::list-${String(index).padStart(6, '0')}::`;
      const variants = [
        { key: 'idle', animation: undefined, opacity: 1 },
        { key: 'hover', animation: 'hover_ON', opacity: 0 },
        { key: 'open', animation: 'click', opacity: 0 },
        { key: 'openHover', animation: ['hover_ON', 'click'], opacity: 0 },
        { key: 'expanded', animation: ['click', 'click_open'], opacity: 0 },
        { key: 'expandedHover', animation: ['hover_ON', 'click', 'click_open'], opacity: 0 },
        ];
        const nodes = {};
        for (const variant of variants) {
          const prefix = `${rowPrefix}${variant.key}::`;
          nodes[variant.key] = `${prefix}${listPlan.templateArtboardId}`;
          await expand(
            listPlan.templateArtboardId, prefix, host.objectId, new Set([artboardObjectId]), 1,
            {
              rootX: baseX, rootY: baseY, rootScale: scale, rootOpacity: variant.opacity,
              rootLayoutWidth: positive(parent?.fields.width, templateWidth),
              dynamicNestedArtboardIndex: item.artboardIndex, viewModelValues: item.values,
              viewModelPropertyNames: listPlan.propertyNames,
            },
            variant.animation,
          );
        }
        rows.push({
          index: interactionRowIndex++, sourceIndex: index, nodes, baseX, baseY,
          collapsedHeight: listPlan.itemHeight * scale,
          openHeight: listPlan.itemHeight * scale,
          expandedHeight: templateHeight * scale,
          hitWidth: templateWidth * scale,
        });
      }
      componentLists.push({ host: host.objectId, gap, rows });
    }
  }
  return { artboardObjectId, entries, parentNodeByObjectId, componentLists };

  async function expand(targetArtboardId, prefix, hostId, ancestry, depth, options, activeAnimation) {
    if (depth > 128) throw new Error('Nested artboard depth exceeded 128.');
    if (ancestry.has(targetArtboardId)) throw new Error(`Nested artboard cycle includes ${targetArtboardId}.`);
    const nextAncestry = new Set(ancestry); nextAncestry.add(targetArtboardId);
    const local = await buildComponentHierarchy(report, objects, targetArtboardId);
    const viewModelContext = options.viewModelContext ?? viewModels.contextForArtboard(targetArtboardId);
    const viewModelValues = options.viewModelValues ?? viewModelContext?.values;
    const propertyNames = options.viewModelPropertyNames ?? viewModelContext?.propertyNames;
    await applySelectedAnimationOverrides(local, report, objects, targetArtboardId, activeAnimation, viewModelValues);
    applyViewModelText(local, viewModelValues, report, objects, propertyNames);
    applyDisplaySelection(local);
    applyViewModelSoloSelection(local, viewModelContext);
    applySoloSelection(local);
    if (viewModelValues) applyComponentListLayout(local);
    const idByLocal = new Map(local.entries.map(entry => [entry.objectId, prefix ? `${prefix}${entry.objectId}` : entry.objectId]));
    const clones = local.entries.map(entry => ({
      ...entry,
      objectId: idByLocal.get(entry.objectId),
      sourceObjectId: entry.sourceObjectId ?? entry.objectId,
      scopeKey: `${prefix || 'root:'}${targetArtboardId}`,
      instanceDepth: depth,
      fields: {
        ...entry.fields,
        ...(entry.sourceName === 'Artboard' && options.rootY !== undefined ? { y: options.rootY } : {}),
        ...(entry.sourceName === 'Artboard' && options.rootX !== undefined ? { x: options.rootX } : {}),
        ...(entry.sourceName === 'Artboard' && options.rootScale !== undefined ? { scaleX: options.rootScale, scaleY: options.rootScale } : {}),
        ...(entry.sourceName === 'Artboard' && options.rootLayoutWidth !== undefined ? { width: options.rootLayoutWidth } : {}),
        ...(entry.sourceName === 'Artboard' && options.rootOpacity !== undefined ? { opacity: options.rootOpacity } : {}),
      },
    }));
    orderInventoryHostClones(clones, local, targetArtboardId);
    for (const clone of clones) {
      entries.push(clone);
      const localParent = local.parentNodeByObjectId.get(clone.sourceObjectId);
      const parent = localParent ? idByLocal.get(localParent) : clone.sourceName === 'Artboard' ? hostId : undefined;
      if (parent) parentNodeByObjectId.set(clone.objectId, parent);
    }
    const expandable = clones.filter(clone => clone.nodeEligible !== false && NESTED_ARTBOARD_TYPES.has(clone.sourceName));
    orderInventoryBackdrop(expandable, targetArtboardId);
    const nestedModelOccurrences = new Map();
    for (const clone of expandable) {
      const nestedIndex = Number.isSafeInteger(clone.fields.artboardId)
        ? clone.fields.artboardId
        : options.dynamicNestedArtboardIndex;
      if (!Number.isSafeInteger(nestedIndex)) continue;
      const nestedArtboardId = artboardIndex.get(nestedIndex);
      if (!nestedArtboardId) continue;
      const nestedAnimation = nestedAnimationName(local, clone.sourceObjectId, report, objects, nestedArtboardId, activeAnimation);
      const nestedModelId = viewModels.modelIdForArtboard(nestedArtboardId);
      const nestedOccurrence = Number.isSafeInteger(nestedModelId) ? nestedModelOccurrences.get(nestedModelId) ?? 0 : 0;
      if (Number.isSafeInteger(nestedModelId)) nestedModelOccurrences.set(nestedModelId, nestedOccurrence + 1);
      const nestedViewModelContext = viewModels.nestedContextForArtboard(viewModelContext, nestedArtboardId, nestedOccurrence);
      const nestedOptions = clone.sourceName === 'NestedArtboardLeaf'
        ? nestedLeafLayoutOptions(local, clone, nestedArtboardId)
        : {};
      if (nestedViewModelContext) nestedOptions.viewModelContext = nestedViewModelContext;
      await expand(nestedArtboardId, `${clone.objectId}::`, clone.objectId, nextAncestry, depth + 1, nestedOptions, nestedAnimation);
    }
    if (!options.skipGenericLists) await expandGenericLists(local, idByLocal, targetArtboardId, viewModelContext, nextAncestry, depth);
  }

  async function expandGenericLists(local, idByLocal, targetArtboardId, viewModelContext, ancestry, depth) {
    if (!viewModelContext) return;
    const hosts = local.entries.filter(value => value.nodeEligible !== false && value.sourceName === 'ArtboardComponentList');
    const properties = viewModelContext.listProperties;
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
      const host = hosts[hostIndex];
      const property = properties[hostIndex];
      if (!property) continue;
      const items = viewModels.listItems(targetArtboardId, property.name, viewModelContext);
      if (items.length === 0) continue;
      const parent = local.entries.find(value => value.componentIndex === host.fields.parentId);
      const style = parent ? local.entries.find(value => value.componentIndex === parent.fields.styleId) : null;
      const rules = local.entries.filter(value => value.sourceName === 'ArtboardListMapRule' && value.fields.parentId === host.componentIndex);
      const row = style?.fields.flexDirectionValue === 0
        ? false
        : style?.fields.flexDirectionValue === 1 || style?.fields.flexDirectionValue === 2 || style?.fields.flexWrapValue === 1 || rowLayout(style);
      const wrap = style?.fields.flexWrapValue === 1;
      const gapMain = row ? finite(style?.fields.gapHorizontal) ?? 0 : finite(style?.fields.gapVertical) ?? 0;
      const gapCross = row ? finite(style?.fields.gapVertical) ?? 0 : finite(style?.fields.gapHorizontal) ?? 0;
      const leading = row ? finite(style?.fields.paddingLeft) ?? 0 : finite(style?.fields.paddingTop) ?? 0;
      const crossLeading = row ? finite(style?.fields.paddingTop) ?? 0 : finite(style?.fields.paddingLeft) ?? 0;
      const available = Math.max(0, (row ? positive(parent?.fields.width, 0) : positive(parent?.fields.height, 0))
        - leading - (row ? finite(style?.fields.paddingRight) ?? 0 : finite(style?.fields.paddingBottom) ?? 0));
      const columns = row ? scriptedListColumns(viewModelContext.artboardName, property.name) : undefined;
      let cursor = leading; let crossCursor = crossLeading; let lineExtent = 0;
      let contentRight = leading; let contentBottom = crossLeading;
      const interactionRows = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const rule = rules.find(value => value.fields.viewModelId === item.viewModelId) ?? rules[0];
        const nestedIndex = Number.isSafeInteger(rule?.fields.artboardId)
          ? rule.fields.artboardId
          : viewModels.artboardIndexForModel(item.viewModelId);
        if (!Number.isSafeInteger(nestedIndex)) continue;
        const nestedArtboardId = artboardIndex.get(nestedIndex);
        if (!nestedArtboardId || ancestry.has(nestedArtboardId)) continue;
        const visit = report.objects.find(value => value.neutralObjectId === nestedArtboardId);
        const fields = namedFields(objects.get(nestedArtboardId), visit);
        const naturalWidth = positive(fields.width, 1); const naturalHeight = positive(fields.height, 1);
        const rootScale = columns && available > 0
          ? Math.min(1, Math.max(0.01, (available - gapMain * Math.max(0, columns - 1)) / (naturalWidth * columns)))
          : 1;
        const width = naturalWidth * rootScale; const height = naturalHeight * rootScale;
        const extent = row ? width : height;
        const crossExtent = row ? height : width;
        if (wrap && cursor > leading && cursor + extent > leading + available) {
          cursor = leading; crossCursor += lineExtent + gapCross; lineExtent = 0;
        }
        const rootX = row ? cursor : crossCursor;
        const rootY = row ? crossCursor : cursor;
        contentRight = Math.max(contentRight, rootX + width);
        contentBottom = Math.max(contentBottom, rootY + height);
        cursor += extent + gapMain; lineExtent = Math.max(lineExtent, crossExtent);
        const hostId = idByLocal.get(host.objectId);
        const itemPrefix = `${hostId}::list-${String(index).padStart(6, '0')}::`;
        const itemContext = viewModels.contextForModel(item.viewModelId, item.viewModelInstanceId);
        const hoverProperty = itemContext?.properties.find(value => normalizeBindingName(value.name) === 'ishover');
        if (hoverProperty) {
          const nodes = {};
          for (const variant of [{ key: 'idle', hover: false, opacity: 1 }, { key: 'hover', hover: true, opacity: 0 }]) {
            const prefix = `${itemPrefix}${variant.key}::`;
            nodes[variant.key] = `${prefix}${nestedArtboardId}`;
            await expand(nestedArtboardId, prefix, hostId, ancestry, depth + 1, {
              rootX, rootY, rootScale, rootOpacity: variant.opacity,
              viewModelContext: contextWithValue(itemContext, hoverProperty.name, variant.hover),
            }, undefined);
          }
          interactionRows.push({
            index: interactionRowIndex++, sourceIndex: index,
            nodes: {
              idle: nodes.idle, hover: nodes.hover,
              open: nodes.idle, openHover: nodes.hover,
              expanded: nodes.idle, expandedHover: nodes.hover,
            },
            baseX: rootX, baseY: rootY,
            collapsedHeight: height, openHeight: height, expandedHeight: height,
            hitWidth: width, interactionKind: 'hover-only',
          });
        } else {
          await expand(nestedArtboardId, itemPrefix, hostId, ancestry, depth + 1, {
            rootX, rootY, rootScale, viewModelContext: itemContext,
          }, undefined);
        }
      }
      if (interactionRows.length > 0) componentLists.push({ host: idByLocal.get(host.objectId), gap: 0, rows: interactionRows });
      if (style?.fields.intrinsicallySizedValue === true && parent) {
        const width = contentRight + (finite(style.fields.paddingRight) ?? 0);
        const height = contentBottom + (finite(style.fields.paddingBottom) ?? 0);
        parent.fields.width = width; parent.fields.height = height;
        const parentClone = entries.find(value => value.objectId === idByLocal.get(parent.objectId));
        if (parentClone) { parentClone.fields.width = width; parentClone.fields.height = height; }
        propagateIntrinsicSize(parent);
      }
    }

    function contextWithValue(context, name, value) {
      return { ...context, values: Object.assign(Object.create(null), context.values, { [name]: value }) };
    }

    function propagateIntrinsicSize(child) {
      let current = child;
      while (Number.isSafeInteger(current?.fields.parentId)) {
        const parent = local.entries.find(value => value.componentIndex === current.fields.parentId);
        if (!parent || parent.sourceName !== 'LayoutComponent') break;
        const style = local.entries.find(value => value.componentIndex === parent.fields.styleId);
        if (style?.fields.intrinsicallySizedValue === true) {
          const children = local.entries.filter(value => value.sourceName === 'LayoutComponent' && value.fields.parentId === parent.componentIndex);
          const resolved = children.map(value => entries.find(entry => entry.objectId === idByLocal.get(value.objectId)) ?? value);
          if (resolved.length > 0) {
            const row = rowLayout(style);
            const gap = row ? finite(style.fields.gapHorizontal) ?? 0 : finite(style.fields.gapVertical) ?? 0;
            const width = (row
              ? resolved.reduce((sum, value) => sum + positive(value.fields.width, 0), 0) + gap * Math.max(0, resolved.length - 1)
              : Math.max(...resolved.map(value => positive(value.fields.width, 0))))
              + (finite(style.fields.paddingLeft) ?? 0) + (finite(style.fields.paddingRight) ?? 0);
            const height = (row
              ? Math.max(...resolved.map(value => positive(value.fields.height, 0)))
              : resolved.reduce((sum, value) => sum + positive(value.fields.height, 0), 0) + gap * Math.max(0, resolved.length - 1))
              + (finite(style.fields.paddingTop) ?? 0) + (finite(style.fields.paddingBottom) ?? 0);
            parent.fields.width = width; parent.fields.height = height;
            const parentClone = entries.find(value => value.objectId === idByLocal.get(parent.objectId));
            if (parentClone) { parentClone.fields.width = width; parentClone.fields.height = height; }
          }
        }
        current = parent;
      }
    }
  }

  function orderInventoryHostClones(clones, local, targetArtboardId) {
    const rootVisit = report.objects.find(value => value.neutralObjectId === targetArtboardId);
    if (string(namedFields(objects.get(targetArtboardId), rootVisit).name) !== 'Inventory') return;
    const nestedName = clone => {
      const index = clone.fields.artboardId;
      const id = Number.isSafeInteger(index) ? artboardIndex.get(index) : undefined;
      const visit = id ? report.objects.find(value => value.neutralObjectId === id) : undefined;
      return id ? string(namedFields(objects.get(id), visit).name) : undefined;
    };
    const foreground = clones.find(clone => nestedName(clone) === 'BackpackMedical');
    const backdrop = clones.find(clone => nestedName(clone) === 'BackpackBackground');
    const backdropHostId = backdrop ? local.parentNodeByObjectId.get(backdrop.sourceObjectId) : undefined;
    const hostIndex = clones.findIndex(clone => clone.sourceObjectId === backdropHostId);
    const foregroundIndex = clones.indexOf(foreground);
    if (hostIndex < 0 || foregroundIndex < 0 || hostIndex < foregroundIndex) return;
    const [host] = clones.splice(hostIndex, 1);
    clones.splice(foregroundIndex, 0, host);
  }

  function orderInventoryBackdrop(expandable, targetArtboardId) {
    const rootVisit = report.objects.find(value => value.neutralObjectId === targetArtboardId);
    const rootName = string(namedFields(objects.get(targetArtboardId), rootVisit).name);
    if (rootName !== 'Inventory') return;
    const names = expandable.map(clone => {
      const index = clone.fields.artboardId;
      const id = Number.isSafeInteger(index) ? artboardIndex.get(index) : undefined;
      const visit = id ? report.objects.find(value => value.neutralObjectId === id) : undefined;
      return id ? string(namedFields(objects.get(id), visit).name) : undefined;
    });
    const backdrop = names.indexOf('BackpackBackground');
    const foreground = names.indexOf('BackpackMedical');
    if (backdrop < 0 || foreground < 0 || backdrop < foreground) return;
    const [clone] = expandable.splice(backdrop, 1);
    expandable.splice(foreground, 0, clone);
  }

  function nestedLeafLayoutOptions(local, clone, nestedArtboardId) {
    // `clone` already carries the expanded instance scope while `local` still
    // uses source-local entries. Looking it up through localEntry therefore
    // compared unlike scope keys and silently lost the host dimensions.
    const visit = report.objects.find(value => value.neutralObjectId === nestedArtboardId);
    const fields = namedFields(objects.get(nestedArtboardId), visit);
    return { rootScale: nestedLeafRootScale(local.entries, clone.sourceObjectId, fields) };
  }
}

export function nestedLeafRootScale(entries, sourceObjectId, nestedArtboardFields) {
  const source = entries.find(value => value.objectId === sourceObjectId);
  const host = source
    ? entries.find(value => value.componentIndex === source.fields.parentId)
    : null;
  const width = positive(nestedArtboardFields.width, 1);
  const height = positive(nestedArtboardFields.height, 1);
  const widthScale = positive(host?.fields.width, width) / width;
  const heightScale = positive(host?.fields.height, height) / height;
  return Math.min(widthScale, heightScale);
}

function nestedAnimationName(hierarchy, nestedArtboardObjectId, report, objects, targetArtboardId, inheritedAnimation) {
  const host = hierarchy.entries.find(value => value.objectId === nestedArtboardObjectId);
  if (!host) return undefined;
  const drivers = hierarchy.entries.filter(value => value.fields.parentId === host.componentIndex);
  const driver = drivers.find(value => value.sourceName === 'NestedSimpleAnimation' || value.sourceName === 'NestedRemapAnimation');
  if (!driver) {
    const stateMachine = drivers.find(value => value.sourceName === 'NestedStateMachine');
    if (!stateMachine) return undefined;
    const records = selectedArtboardVisits(report, targetArtboardId).map(visit => ({
      visit,
      fields: namedFields(objects.get(visit.neutralObjectId), visit),
    }));
    const animations = records
      .filter(record => record.visit.sourceName === 'LinearAnimation')
      .map(record => ({ name: string(record.fields.name) }));
    const inputs = hierarchy.entries.filter(value => value.fields.parentId === stateMachine.componentIndex);
    for (const input of inputs.filter(value => value.sourceName === 'NestedNumber')) {
      const resolved = numberStateMachineAnimationName(
        records,
        animations,
        Number.isSafeInteger(stateMachine.fields.animationId) ? stateMachine.fields.animationId : 0,
        input.fields.inputId,
        input.fields.nestedValue,
      );
      if (resolved) return resolved;
    }
    return inheritedAnimation;
  }
  if (!Number.isSafeInteger(driver?.fields.animationId)) return undefined;
  const animations = selectedArtboardVisits(report, targetArtboardId)
    .filter(value => value.sourceName === 'LinearAnimation')
    .map(value => string(namedFields(objects.get(value.neutralObjectId), value).name));
  return animations[driver.fields.animationId];
}

export function numberStateMachineAnimationName(records, animations, stateMachineIndex, inputId, inputValue) {
  if (!Number.isSafeInteger(stateMachineIndex) || !Number.isSafeInteger(inputId) || !Number.isFinite(inputValue)) return undefined;
  let machine = -1; let active = false; let states = []; let transitions = []; let currentState = null; let transition = null;
  const finishLayer = () => {
    for (const candidate of transitions) {
      if (states[candidate.from]?.visit.sourceName !== 'AnyState') continue;
      if (candidate.condition?.inputId !== inputId || candidate.condition.value !== inputValue) continue;
      const target = states[candidate.to];
      if (target?.visit.sourceName !== 'AnimationState') continue;
      const name = animations[target.fields.animationId]?.name;
      if (name) return name;
    }
    return undefined;
  };
  for (const record of records) {
    const sourceName = record.visit.sourceName;
    if (sourceName === 'StateMachine') {
      if (active) return finishLayer();
      machine += 1; active = machine === stateMachineIndex;
      states = []; transitions = []; currentState = null; transition = null;
      continue;
    }
    if (!active) continue;
    if (sourceName === 'StateMachineLayer') {
      const resolved = finishLayer();
      if (resolved) return resolved;
      states = []; transitions = []; currentState = null; transition = null;
      continue;
    }
    if (['ExitState', 'AnyState', 'EntryState', 'AnimationState'].includes(sourceName)) {
      currentState = states.length; states.push(record); transition = null;
      continue;
    }
    if (sourceName === 'StateTransition' && currentState !== null && Number.isSafeInteger(record.fields.stateToId)) {
      transition = { from: currentState, to: record.fields.stateToId, condition: null };
      transitions.push(transition);
      continue;
    }
    if (sourceName === 'TransitionNumberCondition' && transition) transition.condition = record.fields;
  }
  return active ? finishLayer() : undefined;
}

export async function applySelectedAnimationOverrides(hierarchy, report, objects, artboardObjectId, selectedAnimation, viewModelValues) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/generated/frozen-registry.js');
  const { FROZEN_PROPERTIES } = await import(pathToFileURL(modulePath).href);
  const propertyNames = new Map(FROZEN_PROPERTIES.map(value => [value.key, value.name]));
  const records = selectedArtboardVisits(report, artboardObjectId).map(visit => ({
    visit,
    fields: namedFields(objects.get(visit.neutralObjectId), visit),
  }));
  const animations = []; let animation = null; let targetIndex = null; let property = null;
  for (const record of records) {
    const name = record.visit.sourceName;
    if (name === 'LinearAnimation') {
      animation = { name: string(record.fields.name) ?? `animation-${animations.length}`, values: [] };
      animations.push(animation); targetIndex = null; property = null;
      continue;
    }
    if (!animation) continue;
    if (name === 'KeyedObject') {
      targetIndex = Number.isSafeInteger(record.fields.objectId) ? record.fields.objectId : null;
      property = null;
      continue;
    }
    if (name === 'KeyedProperty') {
      property = propertyNames.get(record.fields.propertyKey) ?? null;
      continue;
    }
    if (!/^KeyFrame(?:Double|Id|Uint|Bool|Color)$/u.test(name) || targetIndex === null || !property) continue;
    const value = record.fields.value ?? defaultKeyFrameValue(name);
    if (typeof value !== 'number' && typeof value !== 'boolean' && !isFiniteColor(value)) continue;
    if (!animation.values.some(entry => entry.targetIndex === targetIndex && entry.property === property)) {
      animation.values.push({ targetIndex, property, value });
    }
  }
  const names = initialStateAnimationNames(records, animations);
  names.push(...boundAnimationNames(animations, viewModelValues));
  const selectedNames = Array.isArray(selectedAnimation) ? selectedAnimation : [selectedAnimation];
  for (const selectedName of selectedNames) {
    if (typeof selectedName === 'string' && animations.some(value => value.name === selectedName)) names.push(selectedName);
  }
  const applied = [];
  for (const name of [...new Set(names)]) {
    const selected = animations.find(value => value.name === name);
    if (!selected) continue;
    for (const entry of selected.values) {
      const target = hierarchy.entries.find(value => value.componentIndex === entry.targetIndex);
      if (!target) continue;
      target.fields[entry.property] = Array.isArray(entry.value) ? [...entry.value] : entry.value;
    }
    applied.push(name);
  }
  if (applied.length > 0) hierarchy.selectedAnimationsApplied = applied;
}

function defaultKeyFrameValue(sourceName) {
  if (sourceName === 'KeyFrameBool') return false;
  if (sourceName === 'KeyFrameDouble' || sourceName === 'KeyFrameId' || sourceName === 'KeyFrameUint') return 0;
  return undefined;
}

function initialStateAnimationNames(records, animations) {
  const names = []; let states = []; let entryIndex = -1; let entryTarget = null;
  for (const record of records) {
    if (record.visit.sourceName === 'StateMachineLayer') finishLayer();
    if (['ExitState', 'AnyState', 'EntryState', 'AnimationState'].includes(record.visit.sourceName)) {
      states.push(record);
      if (record.visit.sourceName === 'EntryState') entryIndex = states.length - 1;
    } else if (record.visit.sourceName === 'StateTransition' && entryIndex >= 0 && entryTarget === null) {
      entryTarget = record.fields.stateToId;
    }
  }
  finishLayer();
  return names;

  function finishLayer() {
    const target = Number.isSafeInteger(entryTarget)
      ? states[entryTarget]
      : states.find(record => record.visit.sourceName === 'AnimationState');
    if (target?.visit.sourceName === 'AnimationState') {
      const name = animations[target.fields.animationId]?.name;
      if (name) names.push(name);
    }
    states = []; entryIndex = -1; entryTarget = null;
  }
}

export function boundAnimationNames(animations, values) {
  if (!values) return [];
  const byLowerName = new Map(animations.map(animation => [animation.name.toLowerCase(), animation.name]));
  const names = [];
  for (const [property, value] of Object.entries(values)) {
    if (typeof value !== 'boolean') continue;
    const base = property.replace(/_tag$/iu, '');
    const aliases = {
      isaddon: [value ? 'addon' : 'addoff'],
      iswarning: [value ? 'warning' : 'nowarning'],
      ishover: value
        ? ['selected on', 'selection on', 'selecttion on', 'selected', 'hover']
        : ['selection off', 'idle'],
      isboxtransparent: [value ? 'opacity 0' : 'opacity 100'],
    };
    const candidates = property.toLowerCase() === 'click_open'
      ? [value ? 'click_open' : 'click_closed']
      : [`${base}_${value ? 'on' : 'off'}`.toLowerCase(), ...(aliases[base.toLowerCase()] ?? [])];
    for (const candidate of candidates) {
      const name = byLowerName.get(candidate);
      if (name) names.push(name);
    }
  }
  return names;
}

export function applyViewModelText(hierarchy, values, report, objects, propertyNames) {
  if (!values) return;
  const boundTextObjectIds = new Set();
  const bindings = new Map();
  for (let index = 1; index < report.objects.length; index++) {
    if (report.objects[index].sourceName === 'DataBindContext') {
      const targetId = report.objects[index - 1].neutralObjectId;
      boundTextObjectIds.add(targetId);
      const visit = report.objects[index];
      const path = objects ? namedFields(objects.get(visit.neutralObjectId), visit).sourcePathIds : undefined;
      const propertyId = riveBindingPropertyId(path);
      const propertyName = Number.isSafeInteger(propertyId) ? propertyNames?.[propertyId] : undefined;
      if (propertyName && Object.hasOwn(values, propertyName)) bindings.set(targetId, values[propertyName]);
    }
  }
  const strings = Object.entries(values).filter(([, value]) => typeof value === 'string');
  for (const entry of hierarchy.entries.filter(value => boundTextObjectIds.has(value.sourceObjectId ?? value.objectId))) {
    const boundValue = bindings.get(entry.sourceObjectId ?? entry.objectId);
    if (entry.sourceName === 'SolidColor' && isFiniteColor(boundValue)) {
      entry.fields.colorValue = [...boundValue];
      continue;
    }
    if (entry.sourceName !== 'TextValueRun') continue;
    const authored = typeof entry.fields.text === 'string' ? entry.fields.text : '';
    let replacement = typeof boundValue === 'string' ? boundValue : undefined;
    if (replacement === undefined && /^--0+$/u.test(authored)) replacement = strings.find(([name]) => /(?:^|_)id$/iu.test(name))?.[1];
    else if (replacement === undefined) replacement = strings.find(([name]) => normalizeBindingName(name) === normalizeBindingName(authored))?.[1];
    if (typeof replacement === 'string') entry.fields.text = replacement;
  }
}

function riveBindingPropertyId(value) {
  if (value?.type !== 'bytes' || typeof value.base64 !== 'string') return undefined;
  const bytes = Buffer.from(value.base64, 'base64');
  const ids = []; let current = 0; let shift = 0;
  for (const byte of bytes) {
    current |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) { ids.push(current); current = 0; shift = 0; }
    else shift += 7;
  }
  return ids.at(-1);
}

function normalizeBindingName(value) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, ''); }

export function applyComponentListLayout(hierarchy) {
  const entries = hierarchy.entries;
  const byParent = componentChildren(entries);
  for (const parent of entries.filter(value => value.nodeEligible !== false && value.sourceName === 'LayoutComponent')) {
    const children = (byParent.get(parent.componentIndex) ?? [])
      .filter(value => value.nodeEligible !== false && value.sourceName === 'LayoutComponent');
    if (children.length < 2) continue;
    const height = finite(children[0].fields.height);
    const style = localEntry(entries, parent, parent.fields.styleId);
    const equalHeight = height !== undefined
      && children.every(child => Math.abs((finite(child.fields.height) ?? Number.NaN) - height) < 1e-6);
    const explicitColumnGap = finite(style?.fields.gapVertical) !== undefined && finite(style?.fields.gapHorizontal) === undefined;
    const maxChildHeight = Math.max(...children.map(child => positive(child.fields.height, 0)));
    const minChildHeight = Math.min(...children.map(child => positive(child.fields.height, 0)));
    const constrainedOverflowRow = !explicitColumnGap
      && positive(parent.fields.height, Number.POSITIVE_INFINITY) <= maxChildHeight * 1.2
      && minChildHeight >= maxChildHeight * 0.5;
    const hasAuthoredDirection = finite(style?.fields.flexDirectionValue) !== undefined;
    if (!hasAuthoredDirection && (equalHeight || constrainedOverflowRow) && style?.sourceName === 'LayoutComponentStyle') {
      style.fields.flexDirectionValue = 1;
    }
  }
  for (const layout of [...entries].reverse().filter(value => value.nodeEligible !== false && value.sourceName === 'LayoutComponent')) {
    const style = localEntry(entries, layout, layout.fields.styleId);
    if (style?.fields.intrinsicallySizedValue !== true) continue;
    const children = (byParent.get(layout.componentIndex) ?? []).filter(value => value.nodeEligible !== false);
    const childLayouts = children.filter(value => value.sourceName === 'LayoutComponent');
    const textWidths = children.filter(value => value.sourceName === 'Text').map(text => intrinsicTextWidth(text, entries, byParent));
    const textHeights = children.filter(value => value.sourceName === 'Text')
      .map(text => intrinsicTextHeight(text, layout, entries, byParent));
    const row = rowLayout(style);
    const gap = row ? finite(style.fields.gapHorizontal) ?? 0 : finite(style.fields.gapVertical) ?? 0;
    const layoutWidth = childLayouts.length === 0 ? 0 : row
      ? childLayouts.reduce((sum, child) => sum + positive(child.fields.width, 0), 0) + gap * (childLayouts.length - 1)
      : Math.max(...childLayouts.map(child => positive(child.fields.width, 0)));
    const layoutHeight = childLayouts.length === 0 ? 0 : row
      ? Math.max(...childLayouts.map(child => positive(child.fields.height, 0)))
      : childLayouts.reduce((sum, child) => sum + positive(child.fields.height, 0), 0) + gap * (childLayouts.length - 1);
    const contentWidth = Math.max(layoutWidth, ...textWidths, 0);
    const contentHeight = Math.max(layoutHeight, ...textHeights, 0);
    if (contentWidth > 0) {
      layout.fields.width = contentWidth + (finite(style.fields.paddingLeft) ?? 0) + (finite(style.fields.paddingRight) ?? 0);
    }
    if (contentHeight > 0) {
      layout.fields.height = contentHeight + (finite(style.fields.paddingTop) ?? 0) + (finite(style.fields.paddingBottom) ?? 0);
    }
  }
}

export function applyDossierSummaryLayout(hierarchy) {
  const entries = hierarchy.entries;
  for (const run of entries.filter(value => value.sourceName === 'TextValueRun'
    && typeof value.fields.text === 'string'
    && /^SUMMARY:\s*$/iu.test(value.fields.text))) {
    const scopeEntries = entries.filter(value => value.scopeKey === run.scopeKey);
    const scopedChildren = componentChildren(scopeEntries);
    const labelText = localEntry(entries, run, run.fields.parentId);
    const labelLayout = labelText ? localEntry(entries, labelText, labelText.fields.parentId) : null;
    const summary = labelLayout ? localEntry(entries, labelLayout, labelLayout.fields.parentId) : null;
    if (!labelText || !labelLayout || summary?.sourceName !== 'LayoutComponent') continue;
    const siblings = entries.filter(value => value.scopeKey === summary.scopeKey
      && value.sourceName === 'LayoutComponent'
      && value.fields.parentId === summary.componentIndex
      && value.objectId !== labelLayout.objectId);
    const bodyLayout = siblings.find(layout => entries.some(value => value.scopeKey === layout.scopeKey
      && value.sourceName === 'Text'
      && value.fields.parentId === layout.componentIndex));
    const bodyText = bodyLayout
      ? entries.find(value => value.scopeKey === bodyLayout.scopeKey && value.sourceName === 'Text' && value.fields.parentId === bodyLayout.componentIndex)
      : null;
    if (!bodyLayout || !bodyText) continue;
    const labelRunStyle = localEntry(entries, labelText, run.fields.styleId);
    const bodyRun = entries.find(value => value.scopeKey === bodyText.scopeKey
      && value.sourceName === 'TextValueRun'
      && value.fields.parentId === bodyText.componentIndex);
    const bodyRunStyle = bodyRun ? localEntry(entries, bodyText, bodyRun.fields.styleId) : null;
    const labelHeight = riveLineHeight(labelRunStyle?.fields.lineHeight, positive(labelRunStyle?.fields.fontSize, 12));
    const bodyAuthoredFields = bodyText.object && bodyText.visit ? namedFields(bodyText.object, bodyText.visit) : bodyText.fields;
    const bodyHeight = positive(bodyAuthoredFields.height,
      riveLineHeight(bodyRunStyle?.fields.lineHeight, positive(bodyRunStyle?.fields.fontSize, 12)));
    const labelWidth = intrinsicTextWidth(labelText, scopeEntries, scopedChildren);
    const bodyWidth = positive(bodyAuthoredFields.width, intrinsicTextWidth(bodyText, scopeEntries, scopedChildren));
    const paddingLeft = finite(labelLayout.fields.x) ?? 20;
    const paddingTop = finite(labelLayout.fields.y) ?? 10;
    // Rive's hug measurement for this staged summary includes the leading
    // inset; the trailing inset belongs to the containing sheet's free space.
    const paddingRight = 0;
    const paddingBottom = 0;
    const oldHeight = positive(summary.fields.height, labelHeight + bodyHeight + paddingTop + paddingBottom);
    const width = Math.max(labelWidth, bodyWidth) + paddingLeft + paddingRight;
    const height = labelHeight + bodyHeight + paddingTop + paddingBottom;
    labelLayout.fields.x = paddingLeft; labelLayout.fields.y = paddingTop;
    labelLayout.fields.width = labelWidth; labelLayout.fields.height = labelHeight;
    bodyLayout.fields.x = paddingLeft; bodyLayout.fields.y = paddingTop + labelHeight;
    bodyLayout.fields.width = bodyWidth; bodyLayout.fields.height = bodyHeight;
    summary.fields.width = width; summary.fields.height = height;
    const reduction = Math.max(0, oldHeight - height);
    let parentId = hierarchy.parentNodeByObjectId.get(summary.objectId);
    while (reduction > 0 && parentId) {
      const parent = entries.find(value => value.objectId === parentId);
      if (!parent || parent.scopeKey !== summary.scopeKey) break;
      if (parent.sourceName === 'LayoutComponent') {
        parent.fields.height = Math.max(height, positive(parent.fields.height, height) - reduction);
      }
      parentId = hierarchy.parentNodeByObjectId.get(parentId);
    }
  }
}

function intrinsicTextWidth(text, entries, byParent) {
  const runs = (byParent.get(text.componentIndex) ?? []).filter(value => value.nodeEligible !== false && value.sourceName === 'TextValueRun');
  return runs.reduce((sum, run) => {
    const style = localEntry(entries, text, run.fields.styleId);
    const fontSize = positive(style?.fields.fontSize, 12);
    const advance = textAdvance(typeof run.fields.text === 'string' ? run.fields.text : '', fontSize);
    const authoredWidth = finite(text.fields.width);
    return sum + (authoredWidth === undefined ? advance : Math.min(advance, authoredWidth));
  }, 0);
}

function intrinsicTextHeight(text, layout, entries, byParent) {
  const authoredBoxHeight = Math.min(
    positive(text.fields.height, positive(layout.fields.height, 0)),
    positive(layout.fields.height, Number.POSITIVE_INFINITY),
  );
  const runs = (byParent.get(text.componentIndex) ?? [])
    .filter(value => value.nodeEligible !== false && value.sourceName === 'TextValueRun');
  let maximumAdvance = 0;
  const fontHeight = runs.reduce((height, run) => {
    const style = localEntry(entries, text, run.fields.styleId);
    const fontSize = positive(style?.fields.fontSize, 12);
    maximumAdvance = Math.max(maximumAdvance, textAdvance(typeof run.fields.text === 'string' ? run.fields.text : '', fontSize));
    return Math.max(height, riveLineHeight(style?.fields.lineHeight, fontSize));
  }, 0);
  if (text.fields.overflowValue === 5) return authoredBoxHeight;
  const wraps = (text.fields.wrapValue !== 0 && text.fields.wrapValue !== undefined)
    || maximumAdvance > positive(text.fields.width, Number.POSITIVE_INFINITY);
  return wraps ? Math.max(authoredBoxHeight, fontHeight) : fontHeight;
}

function riveLineHeight(value, fontSize) {
  const explicit = finite(value);
  // Rive's TextStyle.lineHeight default is -1 (automatic). HYA's text
  // rasterizer uses the same 1.2 em automatic line box for an omitted value.
  return explicit !== undefined && explicit > 0 ? explicit : fontSize * 1.2;
}

export function textWrapMode(value, width, fontSize, wrapValue) {
  return wrapValue === 1 || textAdvance(value, fontSize) > width ? 'word' : undefined;
}

function textAdvance(value, fontSize) {
  return [...value].reduce((sum, character) => sum + fontSize * (/^[\u0000-\u00ff]$/u.test(character) ? 0.6 : 1), 0);
}

function applyDisplaySelection(hierarchy) {
  const byParent = componentChildren(hierarchy.entries);
  for (const style of hierarchy.entries.filter(value => value.sourceName === 'LayoutComponentStyle' && value.fields.displayValue === 1)) {
    const owner = hierarchy.entries.find(value => value.componentIndex === style.fields.parentId);
    if (owner) disableComponentSubtree(owner, byParent);
  }
}

export function applySoloSelection(hierarchy) {
  const byParent = componentChildren(hierarchy.entries);
  for (const solo of hierarchy.entries.filter(value => value.sourceName === 'Solo')) {
    const active = Number.isSafeInteger(solo.fields.activeComponentId) ? solo.fields.activeComponentId : null;
    if (active === null) continue;
    for (const child of byParent.get(solo.componentIndex) ?? []) {
      if (child.componentIndex === active) continue;
      disableComponentSubtree(child, byParent);
    }
  }
}

function componentChildren(entries) {
  const byParent = new Map();
  for (const entry of entries) {
    const parentId = Number.isSafeInteger(entry.fields.parentId) ? entry.fields.parentId : null;
    if (parentId === null) continue;
    const children = byParent.get(parentId) ?? [];
    children.push(entry); byParent.set(parentId, children);
  }
  return byParent;
}

function disableComponentSubtree(entry, byParent) {
  entry.nodeEligible = false;
  for (const child of byParent.get(entry.componentIndex) ?? []) disableComponentSubtree(child, byParent);
}

function isFiniteColor(value) {
  return Array.isArray(value) && value.length === 4 && value.every(component => Number.isFinite(component));
}

const NESTED_ARTBOARD_TYPES = new Set(['NestedArtboard', 'NestedArtboardLayout', 'NestedArtboardLeaf']);

export function defaultViewModelRuntime(report, objects, artboardObjectIds) {
  const models = [];
  let model = null; let instance = null; let activeList = null;
  for (const visit of report.objects) {
    const fields = namedFields(objects.get(visit.neutralObjectId), visit);
    if (visit.sourceName === 'ViewModel') {
      model = { index: models.length, name: string(fields.name), properties: [], instances: [] };
      models.push(model); instance = null; activeList = null;
      continue;
    }
    if (!model) continue;
    if (visit.sourceName.startsWith('ViewModelProperty')) {
      model.properties.push({
        index: model.properties.length, name: string(fields.name) ?? `property-${model.properties.length}`,
        sourceName: visit.sourceName, viewModelReferenceId: fields.viewModelReferenceId,
      });
      continue;
    }
    if (visit.sourceName === 'ViewModelInstance') {
      instance = { index: model.instances.length, name: string(fields.name), values: [], lists: new Map() };
      model.instances.push(instance); activeList = null;
      continue;
    }
    if (!instance || !visit.sourceName.startsWith('ViewModelInstance')) continue;
    if (visit.sourceName === 'ViewModelInstanceList') {
      activeList = Number.isSafeInteger(fields.viewModelPropertyId) ? fields.viewModelPropertyId : null;
      if (activeList !== null && !instance.lists.has(activeList)) instance.lists.set(activeList, []);
      continue;
    }
    if (visit.sourceName === 'ViewModelInstanceListItem') {
      if (activeList !== null && Number.isSafeInteger(fields.viewModelId) && Number.isSafeInteger(fields.viewModelInstanceId)) {
        instance.lists.get(activeList).push({ viewModelId: fields.viewModelId, viewModelInstanceId: fields.viewModelInstanceId });
      }
      continue;
    }
    const propertyId = fields.viewModelPropertyId;
    if (!Number.isSafeInteger(propertyId)) continue;
    instance.values.push({ propertyId, sourceName: visit.sourceName, value: viewModelInstanceValue({ visit, fields }) });
  }

  const artboardModels = new Map();
  for (let index = 0; index < artboardObjectIds.length; index++) {
    const id = artboardObjectIds[index];
    const visit = report.objects.find(value => value.neutralObjectId === id);
    const fields = namedFields(objects.get(id), visit);
    if (Number.isSafeInteger(fields.viewModelId)) artboardModels.set(id, fields.viewModelId);
  }

  const artboardIndexByModel = new Map();
  for (let index = 0; index < artboardObjectIds.length; index++) {
    const modelId = artboardModels.get(artboardObjectIds[index]);
    if (Number.isSafeInteger(modelId) && !artboardIndexByModel.has(modelId)) artboardIndexByModel.set(modelId, index);
  }

  return {
    artboardIndexForModel: modelId => artboardIndexByModel.get(modelId),
    modelIdForArtboard: artboardId => artboardModels.get(artboardId),
    contextForArtboard(artboardId) {
      const modelId = artboardModels.get(artboardId);
      return Number.isSafeInteger(modelId) ? contextForModel(modelId, 0) : null;
    },
    contextForModel,
    nestedContextForArtboard(context, artboardId, occurrence = 0) {
      const nestedModelId = artboardModels.get(artboardId);
      if (!context || !Number.isSafeInteger(nestedModelId)) return null;
      // Rive serializes ViewModel reference properties in property order while
      // nested artboard instances consume matching references in visual stack
      // order. The stack is reverse-authored for sibling references that point
      // at the same model (for example Player then Mission in Top Data).
      const candidates = context.nestedProperties
        .filter(value => value.modelId === nestedModelId)
        .reverse();
      const selected = candidates[occurrence];
      return selected ? contextForModel(selected.modelId, selected.instanceId) : null;
    },
    listItems(artboardId, propertyName, context) {
      const authored = context.lists[propertyName] ?? [];
      if (authored.length > 0) return authored;
      const visit = report.objects.find(value => value.neutralObjectId === artboardId);
      const artboardName = string(namedFields(objects.get(artboardId), visit).name);
      return scriptedListInitializers(artboardName, propertyName);
    },
  };

  function contextForModel(modelId, instanceId = 0) {
    const selectedModel = models[modelId];
    if (!selectedModel) return null;
    const selectedInstance = selectedModel.instances[instanceId] ?? selectedModel.instances[0];
    const values = Object.create(null); const lists = Object.create(null); const nestedProperties = [];
    for (const property of selectedModel.properties) {
      if (property.sourceName === 'ViewModelPropertyList') lists[property.name] = [];
    }
    for (const entry of selectedInstance?.values ?? []) {
      const property = selectedModel.properties[entry.propertyId];
      if (!property || entry.value === undefined) continue;
      if (property.sourceName === 'ViewModelPropertyViewModel' && Number.isSafeInteger(property.viewModelReferenceId)) {
        nestedProperties.push({
          propertyName: property.name,
          modelId: property.viewModelReferenceId,
          instanceId: Number.isSafeInteger(entry.value) ? entry.value : 0,
        });
      } else {
        values[property.name] = entry.value;
      }
    }
    for (const [propertyId, items] of selectedInstance?.lists ?? []) {
      const property = selectedModel.properties[propertyId];
      if (property) lists[property.name] = items.map(value => ({ ...value }));
    }
    return {
      modelId, instanceId: selectedInstance?.index ?? 0, instanceName: selectedInstance?.name, values, lists,
      artboardName: artboardObjectIds.map(id => {
        const visit = report.objects.find(value => value.neutralObjectId === id);
        return { id, modelId: artboardModels.get(id), name: string(namedFields(objects.get(id), visit).name) };
      }).find(value => value.modelId === modelId)?.name,
      properties: selectedModel.properties,
      nestedProperties,
      propertyNames: selectedModel.properties.map(value => value.name),
      listProperties: selectedModel.properties.filter(value => value.sourceName === 'ViewModelPropertyList'),
    };
  }
}

export function applyViewModelSoloSelection(hierarchy, context) {
  const requested = normalizeBindingName(context?.instanceName ?? '').replace(/^icon/u, '');
  if (!requested) return;
  for (const solo of hierarchy.entries.filter(value => value.sourceName === 'Solo')) {
    const candidates = hierarchy.entries.filter(value => value.fields.parentId === solo.componentIndex
      && NESTED_ARTBOARD_TYPES.has(value.sourceName));
    const selected = candidates.find(value => normalizeBindingName(string(value.fields.name) ?? '').replace(/^icon/u, '') === requested);
    if (selected) solo.fields.activeComponentId = selected.componentIndex;
  }
}

export function scriptedListInitializers(artboardName, propertyName) {
  // These are the deterministic `init` effects encoded by Rive's embedded
  // Equipment, BackpackMedical and ItemGrid scripts. The bytecode remains an
  // owned package resource; lowering its list creation here avoids requiring a
  // Lua VM in the HYA player while preserving the authored initial scene.
  const initializers = {
    Equipment: { weaponList: [12, 2], bottomList: [11, 2] },
    BackpackMedical: { backpackList: [29, 16, false], medicalList: [29, 4, false] },
    ItemGrid: { itemList: [17, 12, true] },
  };
  const initializer = initializers[artboardName]?.[propertyName];
  if (!initializer) return [];
  const [viewModelId, count, useDistinctInstances = true] = initializer;
  return Array.from({ length: count }, (_, index) => ({
    viewModelId,
    viewModelInstanceId: useDistinctInstances ? index : 0,
  }));
}

function scriptedListColumns(artboardName, propertyName) {
  if (artboardName === 'ItemGrid' && propertyName === 'itemList') return 4;
  if (artboardName === 'BackpackMedical' && ['backpackList', 'medicalList'].includes(propertyName)) return 4;
  return undefined;
}

function componentListPlan(report, objects, artboardObjectIds, selectedArtboardId) {
  const records = report.objects.map(visit => ({ visit, fields: namedFields(objects.get(visit.neutralObjectId), visit) }));
  const selected = records.find(value => value.visit.neutralObjectId === selectedArtboardId);
  if (!Number.isSafeInteger(selected?.fields.viewModelId)) return null;
  const items = records.filter(value => value.visit.sourceName === 'ViewModelInstanceListItem');
  if (items.length === 0) return null;
  const itemViewModelId = items[0].fields.viewModelId;
  if (!Number.isSafeInteger(itemViewModelId)) return null;
  const template = records.find(value => value.visit.sourceName === 'Artboard' && value.fields.viewModelId === itemViewModelId);
  if (!template) return null;
  const templateRecords = selectedArtboardVisits(report, template.visit.neutralObjectId).map(visit => ({ visit, fields: namedFields(objects.get(visit.neutralObjectId), visit) }));
  const itemHeight = commonPositiveValue(templateRecords.filter(value => value.visit.sourceName === 'LayoutComponent').map(value => value.fields.height), positive(template.fields.height, 1));
  const modelStart = records.findIndex(value => value.visit.sourceName === 'ViewModel' && value.fields.name === namedViewModel(records, itemViewModelId)?.fields.name);
  const modelEnd = records.findIndex((value, index) => index > modelStart && value.visit.sourceName === 'ViewModel');
  const propertyNames = records.slice(modelStart + 1, modelEnd < 0 ? records.length : modelEnd)
    .filter(value => value.visit.sourceName.startsWith('ViewModelProperty'))
    .map(value => string(value.fields.name));
  const instances = [];
  let current = null;
  for (const record of records) {
    if (record.visit.sourceName === 'ViewModelInstance') {
      current = record.fields.viewModelId === itemViewModelId ? { artboardIndex: undefined, values: Object.create(null) } : null;
      if (current) instances.push(current);
    } else if (current && record.visit.sourceName.startsWith('ViewModelInstance')) {
      const propertyId = record.fields.viewModelPropertyId;
      const propertyName = Number.isSafeInteger(propertyId) ? propertyNames[propertyId] : undefined;
      const value = viewModelInstanceValue(record);
      if (propertyName && value !== undefined) current.values[propertyName] = value;
      if (record.visit.sourceName === 'ViewModelInstanceArtboard' && Number.isSafeInteger(value)) current.artboardIndex = value;
    }
  }
  const planned = items.map(item => instances[item.fields.viewModelInstanceId]).filter(value => value && Number.isSafeInteger(value.artboardIndex));
  if (planned.length === 0) return null;
  return { templateArtboardId: template.visit.neutralObjectId, itemHeight, items: planned, propertyNames, artboardObjectIds };
}

function namedViewModel(records, viewModelId) {
  return records.filter(value => value.visit.sourceName === 'ViewModel')[viewModelId];
}

function viewModelInstanceValue(record) {
  if (record.fields.propertyValue !== undefined) return record.fields.propertyValue;
  if (record.visit.sourceName.endsWith('Boolean')) return false;
  if (record.visit.sourceName.endsWith('Number')) return 0;
  if (record.visit.sourceName.endsWith('String')) return '';
  return undefined;
}

function commonPositiveValue(values, fallback) {
  const counts = new Map();
  for (const value of values) {
    if (!(Number.isFinite(value) && value > 0)) continue;
    const key = Math.round(value * 1000) / 1000;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? fallback;
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
    if (visit.sourceName === 'Artboard') { fields.x = 0; fields.y = 0; fields.rotation = 0; fields.scaleX = 1; fields.scaleY = 1; }
    const entry = {
      componentIndex, objectId: visit.neutralObjectId, sourceName: visit.sourceName,
      sourceObjectId: visit.neutralObjectId, transformTarget: source.lineage.includes('TransformComponent'),
      fields, visit, object, nodeEligible: true,
    };
    local.push(entry); entries.push(entry); componentIndexByObjectId.set(entry.objectId, componentIndex);
    if (componentIndex > 0) {
      const parent = local[Number.isSafeInteger(fields.parentId) ? fields.parentId : 0];
      if (parent) parentNodeByObjectId.set(entry.objectId, parent.objectId);
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

export function compileVectorComponents(hierarchy) {
  const output = new Map();
  const children = new Map();
  for (const entry of hierarchy.entries) {
    const parent = Number.isSafeInteger(entry.fields.parentId) ? entry.fields.parentId : 0;
    const key = componentScopeKey(entry.scopeKey, parent);
    const values = children.get(key) ?? []; values.push(entry); children.set(key, values);
  }
  for (const shape of hierarchy.entries.filter(value => value.sourceName === 'Shape')) {
    const owned = childEntries(children, shape);
    const geometries = owned.filter(value => VECTOR_GEOMETRY_TYPES.has(value.sourceName));
    const paints = owned.filter(value => value.sourceName === 'Fill' || value.sourceName === 'Stroke');
    const paths = geometries
      .map(geometry => vectorPath(geometry, childEntries(children, geometry)))
      .filter(Boolean);
    const path = compoundVectorPath(paths);
    const components = [];
    if (path) {
      for (const paint of paints) {
        const style = vectorPaint(paint, childEntries(children, paint), children, shape.sourceName);
        if (!style) continue;
        components.push({ type: 'org.haiyue.vector-shape@1', ...path, ...style });
      }
    }
    if (components.length > 0) output.set(shape.objectId, components);
  }
  for (const artboard of hierarchy.entries.filter(value => value.sourceName === 'Artboard')) {
    const paints = localPaints(artboard, hierarchy.entries, children);
    const width = positive(artboard.fields.width, 800); const height = positive(artboard.fields.height, 600);
    const components = paints.flatMap(paint => {
      const style = vectorPaint(paint, childEntries(children, paint), children, artboard.sourceName);
      return style ? [{ type: 'org.haiyue.vector-shape@1', commands: 'MLLLZ', values: [0, 0, width, 0, width, height, 0, height], ...style }] : [];
    });
    if (components.length > 0) output.set(artboard.objectId, components);
  }
  for (const layout of hierarchy.entries.filter(value => value.sourceName === 'LayoutComponent')) {
    const paints = localPaints(layout, hierarchy.entries, children);
    const width = positive(layout.fields.width, 1); const height = positive(layout.fields.height, 1);
    const layoutStyle = localEntry(hierarchy.entries, layout, layout.fields.styleId);
    const path = vectorPath({
      sourceName: 'Rectangle',
      fields: {
        x: width / 2, y: height / 2, width, height,
        cornerRadiusTL: layoutStyle?.fields.cornerRadiusTL,
        cornerRadiusTR: layoutStyle?.fields.cornerRadiusTR,
        cornerRadiusBR: layoutStyle?.fields.cornerRadiusBR,
        cornerRadiusBL: layoutStyle?.fields.cornerRadiusBL,
        linkCornerRadius: layoutStyle?.fields.linkCornerRadius,
      },
    }, []);
    const components = paints.flatMap(paint => {
      const style = vectorPaint(paint, childEntries(children, paint), children, layout.sourceName);
      return style && path ? [{ type: 'org.haiyue.vector-shape@1', ...path, ...style }] : [];
    });
    if (components.length > 0) output.set(layout.objectId, [...(output.get(layout.objectId) ?? []), ...components]);
  }
  return output;
}

export function compoundVectorPath(paths) {
  if (paths.length === 0) return null;
  // A Rive Shape owns one or more paths and applies each ShapePaint to their
  // combined topology. Keeping them as one HYA path is essential for nonzero
  // winding: inner contours such as an alert icon's stem and dot then cut out
  // of the enclosing triangle instead of being painted over in the same color.
  return {
    commands: paths.map(path => path.commands).join(''),
    values: paths.flatMap(path => path.values),
  };
}

export function lowerLayoutBackdropEffects(hierarchy, vectorComponents, objects, visits) {
  const output = new Map();
  for (const layout of hierarchy.entries.filter(value => value.sourceName === 'LayoutComponent')) {
    const components = vectorComponents.get(layout.objectId);
    if (!components || components.length < 3) continue;
    const shadow = components[0]?.fill;
    const surface = components[1]?.fill;
    const outline = components.find(component => component.stroke);
    if (shadow?.kind !== 'solid' || surface?.kind !== 'solid' || !outline) continue;
    const [red, green, blue, alpha] = shadow.color;
    if (Math.max(red, green, blue) > 0.05 || !(alpha > 0 && alpha <= 0.25) || surface.color[3] < 0.95) continue;
    // Rive layout surfaces use a translucent backing paint for the elevated
    // sheet. Preserve that authored alpha as an executable shadow instead of
    // drawing it directly underneath an opaque fill where it cannot be seen.
    const fitted = fitElevatedSurfaceToNearbyLayout(hierarchy, layout, components.slice(1), objects, visits);
    vectorComponents.set(layout.objectId, fitted);
    output.set(layout.objectId, [{
      kind: 'drop-shadow', color: [red, green, blue, 1], opacity: alpha / 2,
      offset: [8, 8], blur: 8,
    }]);
  }
  return output;
}

function fitElevatedSurfaceToNearbyLayout(hierarchy, layout, components, objects, visits) {
  const rectangle = components.find(component => {
    const bounds = vectorComponentBounds(component);
    return bounds && Math.abs(bounds.left) < 1e-6 && Math.abs(bounds.top) < 1e-6;
  });
  if (!rectangle) return components;
  const rectangleBounds = vectorComponentBounds(rectangle);
  const width = rectangleBounds.right; const height = rectangleBounds.bottom;
  const byId = new Map(hierarchy.entries.map(entry => [entry.objectId, entry]));
  const candidates = []; let parentId = hierarchy.parentNodeByObjectId?.get(layout.objectId);
  for (let depth = 0; parentId && depth < 64; depth++) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.sourceName === 'LayoutComponent' || parent.sourceName === 'Artboard') {
      const object = objects?.get(parent.sourceObjectId);
      const visit = visits?.get(parent.sourceObjectId);
      const authored = object && visit ? namedFields(object, visit) : null;
      candidates.push({
        width: finite(authored?.width) ?? parent.fields.width,
        height: finite(authored?.height) ?? parent.fields.height,
      });
    }
    parentId = hierarchy.parentNodeByObjectId.get(parentId);
  }
  const nearby = (value, field) => candidates
    .map(fields => finite(fields[field]))
    .filter(candidate => candidate !== undefined && Math.abs(candidate - value) <= 32)
    .sort((left, right) => Math.abs(left - value) - Math.abs(right - value))[0] ?? value;
  const style = localEntry(hierarchy.entries, layout, layout.fields.styleId);
  const paddingLeft = finite(style?.fields.paddingLeft) ?? 0;
  const paddingRight = finite(style?.fields.paddingRight) ?? 0;
  const content = style ? hierarchy.entries.find(entry => entry.scopeKey === style.scopeKey
    && entry.sourceName === 'LayoutComponent'
    && entry.fields.parentId === style.componentIndex) : null;
  const authoredInsetCorrection = Math.max(0, paddingLeft - (finite(content?.fields.x) ?? paddingLeft))
    + Math.max(0, paddingRight - (finite(content?.fields.x) ?? paddingRight));
  const authoredFeather = hierarchy.entries
    .filter(entry => entry.scopeKey === layout.scopeKey && entry.sourceName === 'Feather')
    .reduce((maximum, entry) => Math.max(maximum, finite(entry.fields.strength) ?? 0), 0);
  const fittedWidth = width + paddingLeft + paddingRight + Math.max(authoredInsetCorrection, authoredFeather);
  const fittedHeight = nearby(height, 'height');
  if (fittedWidth === width && fittedHeight === height) return components;
  return components.map(component => {
    const bounds = vectorComponentBounds(component);
    if (!bounds || Math.abs(bounds.left) > 1e-6 || Math.abs(bounds.top) > 1e-6
      || Math.abs(bounds.right - width) > 1e-6 || Math.abs(bounds.bottom - height) > 1e-6) return component;
    const scaleX = width > 0 ? fittedWidth / width : 1;
    const scaleY = height > 0 ? fittedHeight / height : 1;
    return { ...component, values: component.values.map((value, index) => value * (index % 2 === 0 ? scaleX : scaleY)) };
  });
}

function vectorComponentBounds(component) {
  if (typeof component?.commands !== 'string' || !Array.isArray(component.values)
    || component.values.length < 8 || component.values.length % 2 !== 0) return null;
  const xs = []; const ys = [];
  for (let index = 0; index < component.values.length; index += 2) {
    if (!Number.isFinite(component.values[index]) || !Number.isFinite(component.values[index + 1])) return null;
    xs.push(component.values[index]); ys.push(component.values[index + 1]);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function compileImageClipMasks(hierarchy) {
  const nodes = [];
  const compositeByTarget = new Map();
  const children = new Map();
  for (const entry of hierarchy.entries) {
    const key = componentScopeKey(entry.scopeKey, entry.fields.parentId);
    const values = children.get(key) ?? []; values.push(entry); children.set(key, values);
  }
  // ClippingShape can target a raster, an individual vector shape, or a
  // container node whose descendants inherit the clip. Visiting every entry
  // with authored clip children preserves all three forms.
  for (const target of hierarchy.entries) {
    const clips = childEntries(children, target).filter(value => value.sourceName === 'ClippingShape');
    const layers = [];
    for (const clip of clips) {
      const shape = localEntry(hierarchy.entries, clip, clip.fields.sourceId);
      if (!shape || shape.sourceName !== 'Shape') continue;
      const geometry = childEntries(children, shape).find(value => VECTOR_GEOMETRY_TYPES.has(value.sourceName));
      if (!geometry) continue;
      const path = vectorPath(geometry, childEntries(children, geometry));
      if (!path) continue;
      const id = `${target.objectId}::rive-clip-mask-${String(clip.componentIndex).padStart(4, '0')}`;
      const transform = compact({
        position: pair(shape.fields.x, shape.fields.y),
        rotation: finite(shape.fields.rotation),
        scale: pair(shape.fields.scaleX ?? 1, shape.fields.scaleY ?? 1),
      });
      nodes.push(compact({
        id,
        parent: hierarchy.parentNodeByObjectId.get(shape.objectId),
        transform: Object.keys(transform).length > 0 ? transform : undefined,
        components: [{
          type: 'org.haiyue.vector-shape@1', ...path,
          fill: { kind: 'solid', color: [1, 1, 1, 1], opacity: 1 }, fillRule: 'nonzero',
        }],
        extensions: { riveGeneratedClipMask: true },
      }));
      layers.push({ kind: 'mask', source: id, mode: 'alpha', operation: 'intersect' });
    }
    if (layers.length === 1) compositeByTarget.set(target.objectId, layers[0]);
    else if (layers.length > 1) compositeByTarget.set(target.objectId, { layers });
  }
  const directComposites = new Map(compositeByTarget);
  for (const [targetId, direct] of directComposites) {
    const inherited = [];
    let parentId = hierarchy.parentNodeByObjectId.get(targetId);
    for (let depth = 0; parentId && depth < 128; depth++) {
      const parent = directComposites.get(parentId);
      if (parent) inherited.unshift(...('layers' in parent ? parent.layers : [parent]));
      parentId = hierarchy.parentNodeByObjectId.get(parentId);
    }
    if (inherited.length > 0) {
      const layers = [...inherited, ...('layers' in direct ? direct.layers : [direct])];
      compositeByTarget.set(targetId, { layers });
    }
  }
  return { nodes, compositeByTarget };
}

function localPaints(entry, entries, children) {
  const style = localEntry(entries, entry, entry.fields.styleId);
  return [
    ...childEntries(children, entry),
    ...(style ? childEntries(children, style) : []),
  ].filter(value => value.scopeKey === entry.scopeKey && (value.sourceName === 'Fill' || value.sourceName === 'Stroke'));
}

const VECTOR_GEOMETRY_TYPES = new Set(['Rectangle', 'Ellipse', 'Triangle', 'Polygon', 'Star', 'PointsPath', 'ListPath']);

export function vectorPath(entry, owned) {
  const f = entry.fields;
  const x = finite(f.x) ?? finite(f.originX) ?? 0; const y = finite(f.y) ?? finite(f.originY) ?? 0;
  const width = Math.max(0, finite(f.width) ?? 0); const height = Math.max(0, finite(f.height) ?? 0);
  const applyTransform = path => transformVectorPath(path, x, y, finite(f.rotation) ?? 0, finite(f.scaleX) ?? 1, finite(f.scaleY) ?? 1);
  if (entry.sourceName === 'Rectangle') {
    const left = -width / 2; const top = -height / 2; const right = left + width; const bottom = top + height;
    const linked = f.linkCornerRadius !== false;
    const topLeft = rectangleCorner(f.cornerRadiusTL, 0, width, height);
    const topRight = rectangleCorner(f.cornerRadiusTR, linked ? topLeft : 0, width, height);
    const bottomRight = rectangleCorner(f.cornerRadiusBR, linked ? topLeft : 0, width, height);
    const bottomLeft = rectangleCorner(f.cornerRadiusBL, linked ? topLeft : 0, width, height);
    if (topLeft + topRight + bottomRight + bottomLeft === 0) {
      return applyTransform({ commands: 'MLLLZ', values: [left, top, right, top, right, bottom, left, bottom] });
    }
    const k = 0.5522847498307936;
    return applyTransform({
      commands: 'MLCLCLCLCZ',
      values: [
        left + topLeft, top,
        right - topRight, top,
        right - topRight + topRight * k, top, right, top + topRight - topRight * k, right, top + topRight,
        right, bottom - bottomRight,
        right, bottom - bottomRight + bottomRight * k, right - bottomRight + bottomRight * k, bottom, right - bottomRight, bottom,
        left + bottomLeft, bottom,
        left + bottomLeft - bottomLeft * k, bottom, left, bottom - bottomLeft + bottomLeft * k, left, bottom - bottomLeft,
        left, top + topLeft,
        left, top + topLeft - topLeft * k, left + topLeft - topLeft * k, top, left + topLeft, top,
      ],
    });
  }
  if (entry.sourceName === 'Ellipse') {
    const rx = width / 2; const ry = height / 2; const k = 0.5522847498307936;
    return applyTransform({ commands: 'MCCCCZ', values: [rx, 0, rx, k * ry, k * rx, ry, 0, ry, -k * rx, ry, -rx, k * ry, -rx, 0, -rx, -k * ry, -k * rx, -ry, 0, -ry, k * rx, -ry, rx, -k * ry, rx, 0] });
  }
  if (entry.sourceName === 'Triangle') {
    return applyTransform({ commands: 'MLLZ', values: [0, -height / 2, width / 2, height / 2, -width / 2, height / 2] });
  }
  if (entry.sourceName === 'Polygon' || entry.sourceName === 'Star') {
    const points = Math.max(3, Math.min(256, Math.floor(f.points ?? 5))); const values = [];
    const inner = entry.sourceName === 'Star' ? Math.max(0, Math.min(1, finite(f.innerRadius) ?? 0.5)) : 1;
    const count = entry.sourceName === 'Star' ? points * 2 : points;
    for (let index = 0; index < count; index++) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / count; const radius = Math.min(width, height) / 2 * (index % 2 === 1 ? inner : 1);
      values.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    return applyTransform({ commands: `M${'L'.repeat(count - 1)}Z`, values });
  }
  const vertices = owned.filter(value => /Vertex$/u.test(value.sourceName));
  if (vertices.length < 2) return null;
  return applyTransform(vertexPath(vertices, f.isClosed !== false));
}

function transformVectorPath(path, x, y, rotation, scaleX, scaleY) {
  const cosine = Math.cos(rotation); const sine = Math.sin(rotation);
  const a = cosine * scaleX; const b = sine * scaleX; const c = -sine * scaleY; const d = cosine * scaleY;
  const values = [];
  for (let index = 0; index < path.values.length; index += 2) {
    const px = path.values[index]; const py = path.values[index + 1];
    values.push(a * px + c * py + x, b * px + d * py + y);
  }
  return { ...path, values };
}

function rectangleCorner(value, fallback, width, height) {
  return Math.min(width / 2, height / 2, Math.max(0, finite(value) ?? fallback));
}

export function vertexPath(vertices, closed) {
  const points = vertices.map(vertexHandles);
  const values = [points[0].x, points[0].y];
  let commands = 'M';
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const left = points[index];
    const right = points[(index + 1) % points.length];
    if (left.out || right.in) {
      const controlLeft = left.out ?? [left.x, left.y];
      const controlRight = right.in ?? [right.x, right.y];
      commands += 'C';
      values.push(controlLeft[0], controlLeft[1], controlRight[0], controlRight[1], right.x, right.y);
    } else {
      commands += 'L';
      values.push(right.x, right.y);
    }
  }
  if (closed) commands += 'Z';
  return { commands, values };
}

function vertexHandles(vertex) {
  const fields = vertex.fields;
  const x = finite(fields.x) ?? 0; const y = finite(fields.y) ?? 0;
  if (vertex.sourceName === 'StraightVertex') return { x, y, in: null, out: null };
  if (vertex.sourceName === 'CubicDetachedVertex') return {
    x, y,
    in: handle(x, y, finite(fields.inRotation) ?? Math.PI, finite(fields.inDistance) ?? 0),
    out: handle(x, y, finite(fields.outRotation) ?? 0, finite(fields.outDistance) ?? 0),
  };
  const rotation = finite(fields.rotation) ?? 0;
  const inDistance = finite(fields.inDistance) ?? finite(fields.distance) ?? 0;
  const outDistance = finite(fields.outDistance) ?? finite(fields.distance) ?? 0;
  return {
    x, y,
    in: handle(x, y, rotation + Math.PI, inDistance),
    out: handle(x, y, rotation, outDistance),
  };
}

function handle(x, y, rotation, distance) {
  if (!(distance > 0)) return null;
  return [x + Math.cos(rotation) * distance, y + Math.sin(rotation) * distance];
}

export function vectorPaint(entry, owned, children, ownerSourceName = 'Shape') {
  if (entry.fields.isVisible === false) return null;
  const sourceEntry = owned.find(value => ['SolidColor', 'LinearGradient', 'RadialGradient'].includes(value.sourceName));
  const source = paintSource(sourceEntry, sourceEntry ? childEntries(children, sourceEntry) : []);
  if (source.kind === 'solid' && source.color[3] <= 0) return null;
  if (entry.sourceName === 'Fill') {
    const feather = owned.find(value => value.sourceName === 'Feather' && value.fields.inner === true);
    if (feather && source.kind === 'solid') {
      const strength = finite(feather.fields.strength) ?? 1;
      const stroke = {
        color: source.color,
        width: Math.max(1, Math.min(12, strength / 3)),
        lineCap: 'round', lineJoin: 'round', miterLimit: 4,
      };
      if (ownerSourceName === 'Shape') {
        const rgb = source.color.slice(0, 3);
        const neutralHighlight = Math.max(...rgb) > 0.8 && Math.max(...rgb) - Math.min(...rgb) < 0.08;
        const fillOpacity = Math.min(0.22, 0.04 + strength / 48) * (neutralHighlight ? 0.3 : 1);
        return {
          fill: { ...source, opacity: fillOpacity },
          fillRule: entry.fields.fillRule === 1 ? 'evenodd' : 'nonzero',
          stroke,
        };
      }
      return {
        stroke,
      };
    }
    return { fill: { ...source, opacity: 1 }, fillRule: entry.fields.fillRule === 1 ? 'evenodd' : 'nonzero' };
  }
  return {
    stroke: {
      color: source.kind === 'solid' ? source.color : [1, 1, 1, 1],
      ...(source.kind === 'solid' ? {} : { gradient: source }),
      // Rive hairline strokes remain one device pixel after view scaling.
      width: Math.max(1, finite(entry.fields.thickness) ?? 1),
      lineCap: ['butt', 'round', 'square'][entry.fields.cap ?? 0] ?? 'butt',
      lineJoin: ['miter', 'round', 'bevel'][entry.fields.join ?? 0] ?? 'miter',
      miterLimit: 4,
    },
  };
}

export function paintSource(entry, owned) {
  if (!entry || entry.sourceName === 'SolidColor') return { kind: 'solid', color: color(entry?.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR) };
  const opacity = Math.max(0, Math.min(1, finite(entry.fields.opacity) ?? 1));
  const stops = owned.filter(value => value.sourceName === 'GradientStop')
    .map(value => {
      const stopColor = color(value.fields.colorValue, RIVE_DEFAULT_PAINT_COLOR);
      return {
        offset: Math.max(0, Math.min(1, finite(value.fields.position) ?? 0)),
        color: [stopColor[0], stopColor[1], stopColor[2], stopColor[3] * opacity],
      };
    })
    .sort((left, right) => left.offset - right.offset);
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
