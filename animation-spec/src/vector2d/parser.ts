import { VectorVisualDiagnostic } from './diagnostics.js';
import { DEFAULT_VECTOR_VISUAL_LIMITS } from './limits.js';
import type {
  ParsedVectorVisualDocument,
  VectorClipNode,
  VectorGeometry,
  VectorImageResource,
  VectorPaintSource,
  VectorVisualLimits,
  VectorVisualNode,
} from './types.js';

export interface ParseVectorVisualOptions {
  readonly limits?: Partial<VectorVisualLimits>;
}

interface Counters {
  commands: number;
  values: number;
  keyframes: number;
  vertices: number;
  indices: number;
  offscreenPixels: number;
}

const COMMAND_ARITY: Readonly<Record<string, number>> = Object.freeze({ M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0 });
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add', 'subtract'] as const;

export function parseVectorVisualDocument(value: unknown, options: ParseVectorVisualOptions = {}): ParsedVectorVisualDocument {
  const limits = Object.freeze({ ...DEFAULT_VECTOR_VISUAL_LIMITS, ...options.limits });
  validateLimits(limits);
  const root = object(value, '$');
  keys(root, ['format', 'version', 'width', 'height', 'duration', 'resources', 'nodes', 'clips'], '$');
  literal(root.format, 'haiyue-vector-visual', '$.format');
  literal(root.version, 1, '$.version');
  const width = positive(root.width, '$.width');
  const height = positive(root.height, '$.height');
  optionalFinite(root.duration, '$.duration', 0);
  const resources = optionalArray(root.resources, '$.resources');
  const nodes = array(root.nodes, '$.nodes');
  const clips = optionalArray(root.clips, '$.clips');
  limit(nodes.length, limits.maxNodes, '$.nodes');
  limit(clips.length, limits.maxClipNodes, '$.clips');

  const counters: Counters = { commands: 0, values: 0, keyframes: 0, vertices: 0, indices: 0, offscreenPixels: 0 };
  const resourceIds = new Set<string>();
  resources.forEach((resource, index) => validateImageResource(resource, `$.resources[${index}]`, resourceIds, limits));
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => validateNode(node, `$.nodes[${index}]`, nodeIds, resourceIds, limits, counters));
  const clipIds = new Set<string>();
  clips.forEach((clip, index) => validateClip(clip, `$.clips[${index}]`, clipIds));
  validateReferences(nodes as unknown as VectorVisualNode[], clips as unknown as VectorClipNode[], nodeIds, clipIds, resourceIds, limits);

  let effectGroupCount = 0;
  for (const node of nodes) {
    const candidate = object(node, '$.nodes[]');
    effectGroupCount += optionalArray(candidate.effectGroups, '$.nodes[].effectGroups').length;
  }
  counters.offscreenPixels = width * height * (effectGroupCount + clips.length);
  limit(counters.commands, limits.maxCommands, '$.nodes.*.geometries.commands');
  limit(counters.values, limits.maxValues, '$.nodes.*.geometries.values');
  limit(counters.keyframes, limits.maxKeyframes, '$.nodes.*.geometries.frames');
  limit(counters.vertices, limits.maxVertices, '$.nodes.*.geometries.mesh.positions');
  limit(counters.indices, limits.maxIndices, '$.nodes.*.geometries.mesh.indices');
  limit(counters.offscreenPixels, limits.maxOffscreenPixels, '$.nodes.*.effectGroups');

  const cloned = structuredClone(root) as unknown as ParsedVectorVisualDocument;
  const normalized: ParsedVectorVisualDocument = {
    ...cloned,
    resources: cloned.resources ?? [],
    clips: cloned.clips ?? [],
  };
  return deepFreeze(normalized);
}

function validateLimits(limits: VectorVisualLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail('E_VECTOR_LIMIT', `limits.${name}`, 'limit must be a positive safe integer');
  }
}

function validateImageResource(value: unknown, path: string, ids: Set<string>, limits: VectorVisualLimits): asserts value is VectorImageResource {
  const resource = object(value, path);
  keys(resource, ['id', 'kind', 'width', 'height', 'source', 'colorSpace', 'filter', 'wrapX', 'wrapY'], path);
  const id = identifier(resource.id, `${path}.id`);
  unique(ids, id, `${path}.id`);
  literal(resource.kind, 'image', `${path}.kind`);
  const width = positive(resource.width, `${path}.width`);
  const height = positive(resource.height, `${path}.height`);
  limit(width * height, limits.maxImagePixels, path);
  optionalEnum(resource.colorSpace, ['srgb', 'display-p3', 'linear-srgb'], `${path}.colorSpace`);
  optionalEnum(resource.filter, ['nearest', 'linear'], `${path}.filter`);
  optionalEnum(resource.wrapX, ['clamp', 'repeat', 'mirror-repeat'], `${path}.wrapX`);
  optionalEnum(resource.wrapY, ['clamp', 'repeat', 'mirror-repeat'], `${path}.wrapY`);
  const source = object(resource.source, `${path}.source`);
  const kind = enumeration(source.kind, ['embedded', 'referenced', 'hosted-replacement'], `${path}.source.kind`);
  if (kind === 'hosted-replacement') {
    keys(source, ['kind', 'slot', 'fallback'], `${path}.source`);
    identifier(source.slot, `${path}.source.slot`);
    optionalIdentifier(source.fallback, `${path}.source.fallback`);
  } else {
    keys(source, ['kind', 'resource'], `${path}.source`);
    identifier(source.resource, `${path}.source.resource`);
  }
}

function validateNode(value: unknown, path: string, ids: Set<string>, resourceIds: Set<string>, limits: VectorVisualLimits, counters: Counters): asserts value is VectorVisualNode {
  const node = object(value, path);
  keys(node, ['id', 'name', 'visible', 'solo', 'drawOrder', 'opacity', 'transform', 'geometries', 'paints', 'effectGroups', 'clips'], path);
  const id = identifier(node.id, `${path}.id`);
  unique(ids, id, `${path}.id`);
  optionalString(node.name, `${path}.name`);
  optionalBoolean(node.visible, `${path}.visible`);
  optionalBoolean(node.solo, `${path}.solo`);
  finite(node.drawOrder, `${path}.drawOrder`);
  optionalRange(node.opacity, 0, 1, `${path}.opacity`);
  optionalTuple(node.transform, 6, `${path}.transform`);
  const geometries = array(node.geometries, `${path}.geometries`);
  const paints = array(node.paints, `${path}.paints`);
  const groups = optionalArray(node.effectGroups, `${path}.effectGroups`);
  const clipRefs = optionalArray(node.clips, `${path}.clips`);
  limit(geometries.length, limits.maxPathsPerNode, `${path}.geometries`);
  limit(paints.length, limits.maxPaintsPerNode, `${path}.paints`);
  limit(groups.length, limits.maxEffectGroupsPerNode, `${path}.effectGroups`);
  geometries.forEach((geometry, index) => validateGeometry(geometry, `${path}.geometries[${index}]`, resourceIds, limits, counters));
  paints.forEach((paint, index) => validatePaint(paint, `${path}.paints[${index}]`, limits));
  const groupIds = new Set<string>();
  groups.forEach((group, index) => validateEffectGroup(group, `${path}.effectGroups[${index}]`, limits, groupIds));
  clipRefs.forEach((ref, index) => identifier(ref, `${path}.clips[${index}]`));
}

function validateGeometry(value: unknown, path: string, resourceIds: Set<string>, limits: VectorVisualLimits, counters: Counters): asserts value is VectorGeometry {
  const geometry = object(value, path);
  const kind = enumeration(geometry.kind, ['path', 'ellipse', 'rectangle', 'polygon', 'star', 'triangle', 'image', 'n-slice'], `${path}.kind`);
  if (kind === 'path') {
    keys(geometry, ['kind', 'commands', 'values', 'fillRule', 'isHole', 'topologyPolicy', 'frames'], path);
    const commands = commandString(geometry.commands, `${path}.commands`);
    validateCommandSequence(commands, `${path}.commands`);
    const values = finiteArray(geometry.values, `${path}.values`);
    validateCommandValues(commands, values.length, path);
    counters.commands += commands.length;
    counters.values += values.length;
    optionalEnum(geometry.fillRule, ['nonzero', 'evenodd'], `${path}.fillRule`);
    optionalBoolean(geometry.isHole, `${path}.isHole`);
    const topologyPolicy = optionalEnum(geometry.topologyPolicy, ['stable', 'discrete'], `${path}.topologyPolicy`) ?? 'stable';
    const frames = optionalArray(geometry.frames, `${path}.frames`);
    counters.keyframes += frames.length;
    let priorTime = -Infinity;
    frames.forEach((frameValue, index) => {
      const framePath = `${path}.frames[${index}]`;
      const frame = object(frameValue, framePath);
      keys(frame, ['time', 'commands', 'values'], framePath);
      const time = finite(frame.time, `${framePath}.time`);
      if (time <= priorTime) fail('E_VECTOR_TOPOLOGY', `${framePath}.time`, 'frame times must be strictly increasing');
      priorTime = time;
      const frameCommands = commandString(frame.commands, `${framePath}.commands`);
      validateCommandSequence(frameCommands, `${framePath}.commands`);
      const frameValues = finiteArray(frame.values, `${framePath}.values`);
      validateCommandValues(frameCommands, frameValues.length, framePath);
      if (topologyPolicy === 'stable' && frameCommands !== commands) fail('E_VECTOR_TOPOLOGY', `${framePath}.commands`, 'stable topology requires identical commands');
      counters.commands += frameCommands.length;
      counters.values += frameValues.length;
    });
    return;
  }
  if (kind === 'ellipse') {
    keys(geometry, ['kind', 'cx', 'cy', 'rx', 'ry'], path);
    finite(geometry.cx, `${path}.cx`); finite(geometry.cy, `${path}.cy`); nonNegative(geometry.rx, `${path}.rx`); nonNegative(geometry.ry, `${path}.ry`);
    return;
  }
  if (kind === 'rectangle') {
    keys(geometry, ['kind', 'x', 'y', 'width', 'height', 'radii'], path);
    finite(geometry.x, `${path}.x`); finite(geometry.y, `${path}.y`); nonNegative(geometry.width, `${path}.width`); nonNegative(geometry.height, `${path}.height`);
    optionalTuple(geometry.radii, 4, `${path}.radii`, 0);
    return;
  }
  if (kind === 'polygon' || kind === 'star') {
    const allowed = kind === 'star' ? ['kind', 'cx', 'cy', 'outerRadius', 'innerRadius', 'points', 'rotation', 'cornerRadius'] : ['kind', 'cx', 'cy', 'radius', 'points', 'rotation', 'cornerRadius'];
    keys(geometry, allowed, path);
    finite(geometry.cx, `${path}.cx`); finite(geometry.cy, `${path}.cy`);
    integerRange(geometry.points, 3, 65_535, `${path}.points`);
    if (kind === 'star') { nonNegative(geometry.outerRadius, `${path}.outerRadius`); nonNegative(geometry.innerRadius, `${path}.innerRadius`); }
    else nonNegative(geometry.radius, `${path}.radius`);
    optionalFinite(geometry.rotation, `${path}.rotation`); optionalFinite(geometry.cornerRadius, `${path}.cornerRadius`, 0);
    return;
  }
  if (kind === 'triangle') {
    keys(geometry, ['kind', 'points', 'cornerRadius'], path);
    tuple(geometry.points, 6, `${path}.points`); optionalFinite(geometry.cornerRadius, `${path}.cornerRadius`, 0);
    return;
  }
  if (kind === 'image') {
    keys(geometry, ['kind', 'resource', 'x', 'y', 'width', 'height', 'crop', 'fit', 'alignment', 'mesh'], path);
    const resource = identifier(geometry.resource, `${path}.resource`);
    if (!resourceIds.has(resource)) fail('E_VECTOR_REFERENCE', `${path}.resource`, `unknown image resource ${resource}`);
    finite(geometry.x, `${path}.x`); finite(geometry.y, `${path}.y`); nonNegative(geometry.width, `${path}.width`); nonNegative(geometry.height, `${path}.height`);
    optionalTuple(geometry.crop, 4, `${path}.crop`, 0);
    optionalEnum(geometry.fit, ['fill', 'contain', 'cover', 'none', 'scale-down'], `${path}.fit`);
    optionalTuple(geometry.alignment, 2, `${path}.alignment`, -1, 1);
    if (geometry.mesh !== undefined) validateMesh(geometry.mesh, `${path}.mesh`, limits, counters);
    return;
  }
  keys(geometry, ['kind', 'source', 'x', 'y', 'width', 'height', 'sourceSize', 'xCuts', 'yCuts'], path);
  const source = object(geometry.source, `${path}.source`);
  const sourceKind = enumeration(source.kind, ['image', 'node'], `${path}.source.kind`);
  keys(source, sourceKind === 'image' ? ['kind', 'resource'] : ['kind', 'node'], `${path}.source`);
  if (sourceKind === 'image') {
    const resource = identifier(source.resource, `${path}.source.resource`);
    if (!resourceIds.has(resource)) fail('E_VECTOR_REFERENCE', `${path}.source.resource`, `unknown image resource ${resource}`);
  } else identifier(source.node, `${path}.source.node`);
  finite(geometry.x, `${path}.x`); finite(geometry.y, `${path}.y`); nonNegative(geometry.width, `${path}.width`); nonNegative(geometry.height, `${path}.height`);
  const sourceSize = tuple(geometry.sourceSize, 2, `${path}.sourceSize`, 0);
  const xCuts = sortedCuts(geometry.xCuts, sourceSize[0]!, `${path}.xCuts`);
  const yCuts = sortedCuts(geometry.yCuts, sourceSize[1]!, `${path}.yCuts`);
  if (xCuts.length % 2 !== 0 || yCuts.length % 2 !== 0) fail('E_VECTOR_FORMAT', path, 'N-slice cuts must contain stretch-region pairs');
}

function validateMesh(value: unknown, path: string, limits: VectorVisualLimits, counters: Counters): void {
  const mesh = object(value, path);
  keys(mesh, ['positions', 'uvs', 'indices'], path);
  const positions = finiteArray(mesh.positions, `${path}.positions`);
  const uvs = finiteArray(mesh.uvs, `${path}.uvs`);
  const indices = array(mesh.indices, `${path}.indices`);
  if (positions.length % 2 !== 0 || positions.length !== uvs.length) fail('E_VECTOR_FORMAT', path, 'positions and uvs must be equal-length xy pairs');
  const vertexCount = positions.length / 2;
  indices.forEach((index, offset) => integerRange(index, 0, Math.max(0, vertexCount - 1), `${path}.indices[${offset}]`));
  if (indices.length % 3 !== 0) fail('E_VECTOR_FORMAT', `${path}.indices`, 'indices must be triangles');
  limit(vertexCount, limits.maxVertices, `${path}.positions`); limit(indices.length, limits.maxIndices, `${path}.indices`);
  counters.vertices += vertexCount; counters.indices += indices.length;
}

function validatePaint(value: unknown, path: string, limits: VectorVisualLimits): void {
  const paint = object(value, path);
  const kind = enumeration(paint.kind, ['fill', 'stroke'], `${path}.kind`);
  const common = ['kind', 'source', 'opacity', 'blendMode', 'visible'];
  keys(paint, kind === 'fill' ? [...common, 'fillRule'] : [...common, 'width', 'cap', 'join', 'miterLimit', 'dash', 'dashOffset', 'dashUnits', 'trim', 'transformMode'], path);
  validatePaintSource(paint.source, `${path}.source`, limits);
  optionalRange(paint.opacity, 0, 1, `${path}.opacity`); optionalEnum(paint.blendMode, BLEND_MODES, `${path}.blendMode`); optionalBoolean(paint.visible, `${path}.visible`);
  if (kind === 'fill') { optionalEnum(paint.fillRule, ['nonzero', 'evenodd'], `${path}.fillRule`); return; }
  nonNegative(paint.width, `${path}.width`); optionalEnum(paint.cap, ['butt', 'round', 'square'], `${path}.cap`); optionalEnum(paint.join, ['miter', 'round', 'bevel'], `${path}.join`);
  optionalFinite(paint.miterLimit, `${path}.miterLimit`, 1); optionalFinite(paint.dashOffset, `${path}.dashOffset`); optionalEnum(paint.dashUnits, ['absolute', 'path-percent'], `${path}.dashUnits`); optionalEnum(paint.transformMode, ['scale', 'fixed'], `${path}.transformMode`);
  const dash = optionalArray(paint.dash, `${path}.dash`); limit(dash.length, limits.maxDashEntries, `${path}.dash`); dash.forEach((entry, index) => positive(entry, `${path}.dash[${index}]`));
  if (paint.trim !== undefined) {
    const trim = object(paint.trim, `${path}.trim`); keys(trim, ['start', 'end', 'offset', 'mode'], `${path}.trim`);
    range(trim.start, 0, 1, `${path}.trim.start`); range(trim.end, 0, 1, `${path}.trim.end`); optionalFinite(trim.offset, `${path}.trim.offset`); optionalEnum(trim.mode, ['simultaneous', 'individual'], `${path}.trim.mode`);
  }
}

function validatePaintSource(value: unknown, path: string, limits: VectorVisualLimits): asserts value is VectorPaintSource {
  const source = object(value, path);
  const kind = enumeration(source.kind, ['solid', 'linear-gradient', 'radial-gradient'], `${path}.kind`);
  if (kind === 'solid') { keys(source, ['kind', 'color'], path); color(source.color, `${path}.color`); return; }
  keys(source, kind === 'linear-gradient' ? ['kind', 'start', 'end', 'stops', 'colorSpace'] : ['kind', 'center', 'radius', 'focal', 'stops', 'colorSpace'], path);
  if (kind === 'linear-gradient') { tuple(source.start, 2, `${path}.start`); tuple(source.end, 2, `${path}.end`); }
  else { tuple(source.center, 2, `${path}.center`); positive(source.radius, `${path}.radius`); optionalTuple(source.focal, 2, `${path}.focal`); }
  optionalEnum(source.colorSpace, ['srgb', 'display-p3', 'linear-srgb'], `${path}.colorSpace`);
  const stops = array(source.stops, `${path}.stops`); if (stops.length < 2) fail('E_VECTOR_FORMAT', `${path}.stops`, 'a gradient needs at least two stops'); limit(stops.length, limits.maxGradientStops, `${path}.stops`);
  let prior = -Infinity;
  stops.forEach((stopValue, index) => { const stopPath = `${path}.stops[${index}]`; const stop = object(stopValue, stopPath); keys(stop, ['offset', 'color'], stopPath); const offset = range(stop.offset, 0, 1, `${stopPath}.offset`); if (offset < prior) fail('E_VECTOR_FORMAT', `${stopPath}.offset`, 'gradient stops must be sorted'); prior = offset; color(stop.color, `${stopPath}.color`); });
}

function validateEffectGroup(value: unknown, path: string, limits: VectorVisualLimits, ids: Set<string>): void {
  const group = object(value, path); keys(group, ['id', 'target', 'blendMode', 'effects'], path); const id = identifier(group.id, `${path}.id`); unique(ids, id, `${path}.id`); optionalIdentifier(group.target, `${path}.target`); optionalEnum(group.blendMode, BLEND_MODES, `${path}.blendMode`);
  const effects = array(group.effects, `${path}.effects`); limit(effects.length, limits.maxEffectsPerGroup, `${path}.effects`);
  effects.forEach((effectValue, index) => {
    const effectPath = `${path}.effects[${index}]`; const effect = object(effectValue, effectPath);
    const kind = enumeration(effect.kind, ['feather', 'opacity', 'color-matrix', 'blur', 'drop-shadow', 'custom-path-port'], `${effectPath}.kind`);
    if (kind === 'feather') { keys(effect, ['kind', 'radiusX', 'radiusY', 'offsetX', 'offsetY', 'inner', 'space'], effectPath); range(effect.radiusX, 0, limits.maxFeather, `${effectPath}.radiusX`); range(effect.radiusY, 0, limits.maxFeather, `${effectPath}.radiusY`); optionalFinite(effect.offsetX, `${effectPath}.offsetX`); optionalFinite(effect.offsetY, `${effectPath}.offsetY`); optionalBoolean(effect.inner, `${effectPath}.inner`); optionalEnum(effect.space, ['local', 'world'], `${effectPath}.space`); }
    else if (kind === 'opacity') { keys(effect, ['kind', 'value'], effectPath); range(effect.value, 0, 1, `${effectPath}.value`); }
    else if (kind === 'color-matrix') { keys(effect, ['kind', 'values'], effectPath); tuple(effect.values, 20, `${effectPath}.values`); }
    else if (kind === 'blur') { keys(effect, ['kind', 'radiusX', 'radiusY'], effectPath); range(effect.radiusX, 0, limits.maxFeather, `${effectPath}.radiusX`); range(effect.radiusY, 0, limits.maxFeather, `${effectPath}.radiusY`); }
    else if (kind === 'drop-shadow') { keys(effect, ['kind', 'offsetX', 'offsetY', 'blur', 'color'], effectPath); finite(effect.offsetX, `${effectPath}.offsetX`); finite(effect.offsetY, `${effectPath}.offsetY`); range(effect.blur, 0, limits.maxFeather, `${effectPath}.blur`); color(effect.color, `${effectPath}.color`); }
    else { keys(effect, ['kind', 'port', 'inputs', 'execution'], effectPath); identifier(effect.port, `${effectPath}.port`); literal(effect.execution, 'external-only', `${effectPath}.execution`); const inputs = object(effect.inputs, `${effectPath}.inputs`); for (const [name, input] of Object.entries(inputs)) if (typeof input !== 'string' && typeof input !== 'boolean' && (typeof input !== 'number' || !Number.isFinite(input))) fail('E_VECTOR_NUMBER', `${effectPath}.inputs.${name}`, 'port input must be finite scalar'); }
  });
}

function validateClip(value: unknown, path: string, ids: Set<string>): void {
  const clip = object(value, path); keys(clip, ['id', 'source', 'operation', 'inverted', 'fillRule', 'children'], path); const id = identifier(clip.id, `${path}.id`); unique(ids, id, `${path}.id`); identifier(clip.source, `${path}.source`); optionalEnum(clip.operation, ['add', 'subtract', 'intersect', 'difference'], `${path}.operation`); optionalBoolean(clip.inverted, `${path}.inverted`); optionalEnum(clip.fillRule, ['nonzero', 'evenodd'], `${path}.fillRule`); optionalArray(clip.children, `${path}.children`).forEach((child, index) => identifier(child, `${path}.children[${index}]`));
}

function validateReferences(nodes: readonly VectorVisualNode[], clips: readonly VectorClipNode[], nodeIds: Set<string>, clipIds: Set<string>, resourceIds: Set<string>, limits: VectorVisualLimits): void {
  for (const [index, node] of nodes.entries()) {
    for (const clip of node.clips ?? []) if (!clipIds.has(clip)) fail('E_VECTOR_REFERENCE', `$.nodes[${index}].clips`, `unknown clip ${clip}`);
    for (const [groupIndex, group] of (node.effectGroups ?? []).entries()) if (group.target !== undefined && !nodeIds.has(group.target)) fail('E_VECTOR_REFERENCE', `$.nodes[${index}].effectGroups[${groupIndex}].target`, `unknown target ${group.target}`);
    for (const [geometryIndex, geometry] of node.geometries.entries()) if (geometry.kind === 'n-slice' && geometry.source.kind === 'node' && !nodeIds.has(geometry.source.node)) fail('E_VECTOR_REFERENCE', `$.nodes[${index}].geometries[${geometryIndex}].source.node`, `unknown node ${geometry.source.node}`);
  }
  const byId = new Map(clips.map(clip => [clip.id, clip]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, depth: number): void => {
    if (depth > limits.maxClipDepth) fail('E_VECTOR_LIMIT', '$.clips', `clip depth exceeds ${limits.maxClipDepth}`);
    if (state.get(id) === 1) fail('E_VECTOR_CYCLE', '$.clips', `clip cycle includes ${id}`);
    if (state.get(id) === 2) return;
    const clip = byId.get(id); if (!clip) fail('E_VECTOR_REFERENCE', '$.clips', `unknown clip ${id}`);
    if (!nodeIds.has(clip.source)) fail('E_VECTOR_REFERENCE', '$.clips', `clip ${id} references unknown source ${clip.source}`);
    state.set(id, 1);
    for (const child of clip.children ?? []) { if (!clipIds.has(child)) fail('E_VECTOR_REFERENCE', '$.clips', `clip ${id} references unknown child ${child}`); visit(child, depth + 1); }
    state.set(id, 2);
  };
  for (const id of clipIds) visit(id, 1);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeState = new Map<string, 1 | 2>();
  const visitNode = (id: string, depth: number): void => {
    if (depth > limits.maxClipDepth) fail('E_VECTOR_LIMIT', '$.nodes', `visual recursion depth exceeds ${limits.maxClipDepth}`);
    if (nodeState.get(id) === 1) fail('E_VECTOR_CYCLE', '$.nodes', `N-slice source cycle includes ${id}`);
    if (nodeState.get(id) === 2) return;
    nodeState.set(id, 1);
    for (const geometry of nodeById.get(id)?.geometries ?? []) if (geometry.kind === 'n-slice' && geometry.source.kind === 'node') visitNode(geometry.source.node, depth + 1);
    nodeState.set(id, 2);
  };
  for (const id of nodeIds) visitNode(id, 1);
  void resourceIds;
}

function validateCommandValues(commands: string, valueCount: number, path: string): void { let expected = 0; for (const command of commands) expected += COMMAND_ARITY[command]!; if (expected !== valueCount) fail('E_VECTOR_FORMAT', `${path}.values`, `commands require ${expected} values, received ${valueCount}`); }
function validateCommandSequence(commands: string, path: string): void { if (commands[0] !== 'M') fail('E_VECTOR_FORMAT', path, 'the first path command must be M'); for (let index = 1; index < commands.length; index++) if (commands[index - 1] === 'Z' && commands[index] !== 'M') fail('E_VECTOR_FORMAT', path, 'a command after Z must begin a new M subpath'); }
function commandString(value: unknown, path: string): string { if (typeof value !== 'string' || value.length === 0 || [...value].some(command => COMMAND_ARITY[command] === undefined)) fail('E_VECTOR_FORMAT', path, 'commands must be a non-empty M/L/H/V/Q/C/Z string'); return value; }
function sortedCuts(value: unknown, maximum: number, path: string): readonly number[] { const cuts = finiteArray(value, path); let prior = 0; cuts.forEach((cut, index) => { if (cut <= prior || cut >= maximum) fail('E_VECTOR_FORMAT', `${path}[${index}]`, 'cuts must be strictly increasing inside source bounds'); prior = cut; }); return cuts; }
function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('E_VECTOR_FORMAT', path, 'expected object'); return value as Record<string, unknown>; }
function array(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) fail('E_VECTOR_FORMAT', path, 'expected array'); return value; }
function optionalArray(value: unknown, path: string): unknown[] { return value === undefined ? [] : array(value, path); }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) fail('E_VECTOR_FORMAT', `${path}.${key}`, 'unknown property'); }
function literal<T extends string | number>(value: unknown, expected: T, path: string): T { if (value !== expected) fail('E_VECTOR_FORMAT', path, `expected ${String(expected)}`); return expected; }
function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) fail('E_VECTOR_FORMAT', path, `expected one of ${allowed.join(', ')}`); return value as T; }
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined { return value === undefined ? undefined : enumeration(value, allowed, path); }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) fail('E_VECTOR_NUMBER', path, 'expected finite number'); return value; }
function positive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) fail('E_VECTOR_NUMBER', path, 'expected positive number'); return result; }
function nonNegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) fail('E_VECTOR_NUMBER', path, 'expected non-negative number'); return result; }
function range(value: unknown, minimum: number, maximum: number, path: string): number { const result = finite(value, path); if (result < minimum || result > maximum) fail('E_VECTOR_NUMBER', path, `expected ${minimum}..${maximum}`); return result; }
function optionalRange(value: unknown, minimum: number, maximum: number, path: string): number | undefined { return value === undefined ? undefined : range(value, minimum, maximum, path); }
function optionalFinite(value: unknown, path: string, minimum = -Infinity): number | undefined { if (value === undefined) return undefined; const result = finite(value, path); if (result < minimum) fail('E_VECTOR_NUMBER', path, `expected >= ${minimum}`); return result; }
function integerRange(value: unknown, minimum: number, maximum: number, path: string): number { const result = finite(value, path); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail('E_VECTOR_NUMBER', path, `expected integer ${minimum}..${maximum}`); return result; }
function finiteArray(value: unknown, path: string): number[] { const result = array(value, path); return result.map((entry, index) => finite(entry, `${path}[${index}]`)); }
function tuple(value: unknown, length: number, path: string, minimum = -Infinity, maximum = Infinity): number[] { const result = finiteArray(value, path); if (result.length !== length) fail('E_VECTOR_FORMAT', path, `expected ${length} entries`); result.forEach((entry, index) => { if (entry < minimum || entry > maximum) fail('E_VECTOR_NUMBER', `${path}[${index}]`, `expected ${minimum}..${maximum}`); }); return result; }
function optionalTuple(value: unknown, length: number, path: string, minimum = -Infinity, maximum = Infinity): number[] | undefined { return value === undefined ? undefined : tuple(value, length, path, minimum, maximum); }
function color(value: unknown, path: string): void { tuple(value, 4, path, 0, 1); }
function identifier(value: unknown, path: string): string { if (typeof value !== 'string' || value.length < 1 || value.length > 256) fail('E_VECTOR_FORMAT', path, 'expected non-empty identifier up to 256 characters'); return value; }
function optionalIdentifier(value: unknown, path: string): string | undefined { return value === undefined ? undefined : identifier(value, path); }
function optionalString(value: unknown, path: string): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || value.length > 4096) fail('E_VECTOR_FORMAT', path, 'expected string up to 4096 characters'); return value; }
function optionalBoolean(value: unknown, path: string): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') fail('E_VECTOR_FORMAT', path, 'expected boolean'); return value; }
function unique(ids: Set<string>, id: string, path: string): void { if (ids.has(id)) fail('E_VECTOR_REFERENCE', path, `duplicate id ${id}`); ids.add(id); }
function limit(value: number, maximum: number, path: string): void { if (!Number.isFinite(value) || value > maximum) fail('E_VECTOR_LIMIT', path, `limit ${maximum} exceeded by ${value}`); }
function fail(code: ConstructorParameters<typeof VectorVisualDiagnostic>[0], path: string, message: string): never { throw new VectorVisualDiagnostic(code, path, message); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
