import { ParameterizedRigDiagnostic } from './diagnostics.js';
import { DEFAULT_PARAMETERIZED_RIG_LIMITS } from './limits.js';
import {
  PARAMETERIZED_RIG_EXTENSION_ID,
  PARAMETERIZED_RIG_FORMAT,
  PARAMETERIZED_RIG_VERSION,
  type ParameterizedRigDocument,
  type ParameterizedRigParseOptions,
  type RigConstraint,
  type RigLimits,
  type RigNumericArray,
} from './types.js';

interface Totals { bones: number; meshes: number; drawables: number; vertices: number; indices: number; influences: number; constraints: number; paths: number; pathPoints: number; drivers: number; }

export function parseParameterizedRigDocument(value: unknown, options: ParameterizedRigParseOptions = {}): ParameterizedRigDocument {
  const limits = Object.freeze({ ...DEFAULT_PARAMETERIZED_RIG_LIMITS, ...options.limits });
  validateLimits(limits);
  const root = object(value, '$');
  keys(root, ['format', 'version', 'extension', 'width', 'height', 'duration', 'parameters', 'rigs', 'instances'], '$');
  literal(root.format, PARAMETERIZED_RIG_FORMAT, '$.format');
  literal(root.version, PARAMETERIZED_RIG_VERSION, '$.version');
  literal(root.extension, PARAMETERIZED_RIG_EXTENSION_ID, '$.extension');
  positive(root.width, '$.width'); positive(root.height, '$.height'); optionalNonNegative(root.duration, '$.duration');
  const parameters = array(root.parameters, '$.parameters');
  const rigs = array(root.rigs, '$.rigs');
  const instances = array(root.instances, '$.instances');
  limit(parameters.length, limits.maxParameters, '$.parameters'); limit(rigs.length, limits.maxRigs, '$.rigs'); limit(instances.length, limits.maxInstances, '$.instances');
  const parameterIds = new Set<string>();
  parameters.forEach((value, index) => validateParameter(value, `$.parameters[${index}]`, parameterIds));
  const rigIds = new Set<string>();
  const totals: Totals = { bones: 0, meshes: 0, drawables: 0, vertices: 0, indices: 0, influences: 0, constraints: 0, paths: 0, pathPoints: 0, drivers: 0 };
  rigs.forEach((value, index) => validateRig(value, `$.rigs[${index}]`, rigIds, parameterIds, limits, totals));
  validateTotals(totals, limits);
  validateInstances(instances, rigs, rigIds, parameterIds, limits);
  return deepFreeze(structuredClone(root) as unknown as ParameterizedRigDocument);
}

function validateLimits(limits: RigLimits): void { for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('E_RIG_LIMIT', `limits.${name}`, 'limit must be a positive safe integer'); }

function validateParameter(value: unknown, path: string, ids: Set<string>): void {
  const parameter = object(value, path); keys(parameter, ['id', 'default', 'min', 'max'], path);
  const id = identifier(parameter.id, `${path}.id`); unique(ids, id, `${path}.id`);
  const minimum = finite(parameter.min, `${path}.min`), maximum = finite(parameter.max, `${path}.max`), defaultValue = finite(parameter.default, `${path}.default`);
  if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) fail('E_RIG_NUMBER', path, 'parameter requires min <= default <= max');
}

function validateRig(value: unknown, path: string, rigIds: Set<string>, parameterIds: Set<string>, limits: RigLimits, totals: Totals): void {
  const rig = object(value, path); keys(rig, ['id', 'bones', 'meshes', 'drawables', 'constraints', 'paths', 'drivers', 'joysticks'], path);
  const id = identifier(rig.id, `${path}.id`); unique(rigIds, id, `${path}.id`);
  const bones = array(rig.bones, `${path}.bones`), meshes = array(rig.meshes, `${path}.meshes`), drawables = array(rig.drawables, `${path}.drawables`), constraints = optionalArray(rig.constraints, `${path}.constraints`), paths = optionalArray(rig.paths, `${path}.paths`), drivers = optionalArray(rig.drivers, `${path}.drivers`), joysticks = optionalArray(rig.joysticks, `${path}.joysticks`);
  totals.bones += bones.length; totals.meshes += meshes.length; totals.drawables += drawables.length; totals.constraints += constraints.length; totals.paths += paths.length; totals.drivers += drivers.length;
  const boneIds = new Set<string>(); bones.forEach((bone, index) => validateBone(bone, `${path}.bones[${index}]`, boneIds)); validateBoneGraph(bones, boneIds, path, limits.maxNestingDepth);
  const meshIds = new Set<string>(); meshes.forEach((mesh, index) => validateMesh(mesh, `${path}.meshes[${index}]`, meshIds, bones.length, limits, totals));
  const drawableIds = new Set<string>(); drawables.forEach((drawable, index) => validateDrawable(drawable, `${path}.drawables[${index}]`, drawableIds, meshIds)); validateMaskGraph(drawables, drawableIds, path, limits.maxNestingDepth);
  const pathIds = new Set<string>(); paths.forEach((candidate, index) => validatePath(candidate, `${path}.paths[${index}]`, pathIds, totals));
  const constraintIds = new Set<string>(), constraintKinds = new Map<string, RigConstraint['kind']>();
  constraints.forEach((constraint, index) => {
    const constraintPath = `${path}.constraints[${index}]`, candidate = object(constraint, constraintPath), constraintId = identifier(candidate.id, `${constraintPath}.id`);
    unique(constraintIds, constraintId, `${constraintPath}.id`);
    constraintKinds.set(constraintId, enumeration(candidate.kind, ['ik', 'distance', 'transform', 'translation', 'scale', 'rotation', 'follow-path', 'scroll', 'scrollbar'], `${constraintPath}.kind`));
  });
  constraints.forEach((constraint, index) => validateConstraint(constraint, `${path}.constraints[${index}]`, constraintKinds, boneIds, pathIds, parameterIds, limits));
  const driverIds = new Set<string>(); drivers.forEach((driver, index) => validateDriver(driver, `${path}.drivers[${index}]`, driverIds, parameterIds, boneIds, constraintKinds, drawableIds));
  const joystickIds = new Set<string>(); joysticks.forEach((joystick, index) => validateJoystick(joystick, `${path}.joysticks[${index}]`, joystickIds, parameterIds, drawableIds));
}

function validateBone(value: unknown, path: string, ids: Set<string>): void {
  const bone = object(value, path); keys(bone, ['id', 'parent', 'length', 'bind', 'inverseBind'], path);
  const id = identifier(bone.id, `${path}.id`); unique(ids, id, `${path}.id`); optionalIdentifier(bone.parent, `${path}.parent`); nonNegative(bone.length, `${path}.length`); validateTransform(bone.bind, `${path}.bind`); tuple(bone.inverseBind, 6, `${path}.inverseBind`);
}

function validateBoneGraph(values: unknown[], ids: Set<string>, path: string, maxDepth: number): void {
  const parentById = new Map<string, string | undefined>();
  values.forEach((value, index) => { const bone = object(value, `${path}.bones[${index}]`); const id = bone.id as string, parent = bone.parent as string | undefined; if (parent !== undefined && !ids.has(parent)) fail('E_RIG_REFERENCE', `${path}.bones[${index}].parent`, `unknown bone ${parent}`); parentById.set(id, parent); });
  const states = new Map<string, 1 | 2>();
  const visit = (id: string, depth: number): void => { if (depth > maxDepth) fail('E_RIG_LIMIT', `${path}.bones`, `bone depth exceeds ${maxDepth}`); if (states.get(id) === 1) fail('E_RIG_CYCLE', `${path}.bones`, `bone cycle includes ${id}`); if (states.get(id) === 2) return; states.set(id, 1); const parent = parentById.get(id); if (parent) visit(parent, depth + 1); states.set(id, 2); };
  for (const id of ids) visit(id, 1);
}

function validateMesh(value: unknown, path: string, ids: Set<string>, boneCount: number, limits: RigLimits, totals: Totals): void {
  const mesh = object(value, path); keys(mesh, ['id', 'positions', 'uvs', 'indices', 'influenceOffsets', 'jointIndices', 'weights'], path); const id = identifier(mesh.id, `${path}.id`); unique(ids, id, `${path}.id`);
  const positions = numericArray(mesh.positions, `${path}.positions`), uvs = numericArray(mesh.uvs, `${path}.uvs`), indices = indexArray(mesh.indices, `${path}.indices`), offsets = indexArray(mesh.influenceOffsets, `${path}.influenceOffsets`), joints = indexArray(mesh.jointIndices, `${path}.jointIndices`), weights = numericArray(mesh.weights, `${path}.weights`);
  if (positions.length < 6 || positions.length % 2 !== 0 || uvs.length !== positions.length) fail('E_RIG_FORMAT', path, 'positions and uvs must contain equal xy pairs for at least one triangle');
  const vertexCount = positions.length / 2; if (indices.length < 3 || indices.length % 3 !== 0) fail('E_RIG_FORMAT', `${path}.indices`, 'indices must contain triangle triplets');
  for (let index = 0; index < indices.length; index++) if (indices[index]! >= vertexCount) fail('E_RIG_REFERENCE', `${path}.indices[${index}]`, 'index exceeds vertex count');
  if (offsets.length !== vertexCount + 1 || offsets[0] !== 0 || offsets[offsets.length - 1] !== joints.length || joints.length !== weights.length) fail('E_RIG_WEIGHT', path, 'CSR influence offsets/joints/weights are inconsistent');
  let prior = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const start = offsets[vertex]!, end = offsets[vertex + 1]!;
    if (start < prior || end < start || end - start > limits.maxInfluencesPerVertex) fail('E_RIG_WEIGHT', `${path}.influenceOffsets[${vertex}]`, 'invalid or excessive per-vertex influence range');
    prior = end; let sum = 0;
    for (let influence = start; influence < end; influence++) { if (joints[influence]! >= boneCount) fail('E_RIG_REFERENCE', `${path}.jointIndices[${influence}]`, 'joint index exceeds bone count'); const weight = weights[influence]!; if (weight < 0) fail('E_RIG_WEIGHT', `${path}.weights[${influence}]`, 'weight must be non-negative'); sum += weight; }
    if (end > start && Math.abs(sum - 1) > 1e-5) fail('E_RIG_WEIGHT', `${path}.weights`, `vertex ${vertex} weights sum to ${sum}, expected 1`);
  }
  totals.vertices += vertexCount; totals.indices += indices.length; totals.influences += joints.length;
}

function validateDrawable(value: unknown, path: string, ids: Set<string>, meshIds: Set<string>): void {
  const drawable = object(value, path); keys(drawable, ['id', 'mesh', 'texture', 'visible', 'solo', 'drawOrder', 'opacity', 'blendMode', 'culling', 'multiplyColor', 'screenColor', 'masks', 'maskMode'], path); const id = identifier(drawable.id, `${path}.id`); unique(ids, id, `${path}.id`); const mesh = identifier(drawable.mesh, `${path}.mesh`); if (!meshIds.has(mesh)) fail('E_RIG_REFERENCE', `${path}.mesh`, `unknown mesh ${mesh}`); optionalIdentifier(drawable.texture, `${path}.texture`); optionalBoolean(drawable.visible, `${path}.visible`); optionalBoolean(drawable.solo, `${path}.solo`); finite(drawable.drawOrder, `${path}.drawOrder`); optionalRange(drawable.opacity, 0, 1, `${path}.opacity`); optionalEnum(drawable.blendMode, ['normal', 'additive', 'multiplicative'], `${path}.blendMode`); optionalBoolean(drawable.culling, `${path}.culling`); optionalColor(drawable.multiplyColor, `${path}.multiplyColor`); optionalColor(drawable.screenColor, `${path}.screenColor`); optionalArray(drawable.masks, `${path}.masks`).forEach((mask, index) => identifier(mask, `${path}.masks[${index}]`)); optionalEnum(drawable.maskMode, ['alpha', 'alpha-inverted'], `${path}.maskMode`);
}

function validateMaskGraph(values: unknown[], ids: Set<string>, path: string, maxDepth: number): void {
  const masks = new Map<string, string[]>(); values.forEach((value, index) => { const drawable = object(value, `${path}.drawables[${index}]`); const refs = optionalArray(drawable.masks, `${path}.drawables[${index}].masks`) as string[]; for (const ref of refs) if (!ids.has(ref) || ref === drawable.id) fail('E_RIG_REFERENCE', `${path}.drawables[${index}].masks`, `invalid mask ${ref}`); if (new Set(refs).size !== refs.length) fail('E_RIG_REFERENCE', `${path}.drawables[${index}].masks`, 'mask references must be unique'); masks.set(drawable.id as string, refs); });
  const states = new Map<string, 1 | 2>(); const visit = (id: string, depth: number): void => { if (depth > maxDepth) fail('E_RIG_LIMIT', `${path}.drawables`, `mask depth exceeds ${maxDepth}`); if (states.get(id) === 1) fail('E_RIG_CYCLE', `${path}.drawables`, `mask cycle includes ${id}`); if (states.get(id) === 2) return; states.set(id, 1); for (const child of masks.get(id) ?? []) visit(child, depth + 1); states.set(id, 2); }; for (const id of ids) visit(id, 1);
}

function validatePath(value: unknown, path: string, ids: Set<string>, totals: Totals): void { const candidate = object(value, path); keys(candidate, ['id', 'points', 'closed'], path); const id = identifier(candidate.id, `${path}.id`); unique(ids, id, `${path}.id`); const points = numericArray(candidate.points, `${path}.points`); if (points.length < 4 || points.length % 2 !== 0) fail('E_RIG_DEGENERATE', `${path}.points`, 'path requires at least two xy points'); let length = 0; for (let index = 2; index < points.length; index += 2) length += Math.hypot(points[index]! - points[index - 2]!, points[index + 1]! - points[index - 1]!); if (length <= 1e-8) fail('E_RIG_DEGENERATE', `${path}.points`, 'path has zero length'); optionalBoolean(candidate.closed, `${path}.closed`); totals.pathPoints += points.length / 2; }

function validateConstraint(value: unknown, path: string, constraintKinds: ReadonlyMap<string, RigConstraint['kind']>, boneIds: Set<string>, pathIds: Set<string>, parameterIds: Set<string>, limits: RigLimits): void {
  const constraint = object(value, path); const kind = enumeration(constraint.kind, ['ik', 'distance', 'transform', 'translation', 'scale', 'rotation', 'follow-path', 'scroll', 'scrollbar'], `${path}.kind`); const common = ['id', 'kind', 'order', 'enabled', 'strength', 'constrained', 'sourceSpace', 'destinationSpace'];
  const extras: Record<typeof kind, readonly string[]> = { ik: ['target', 'chainLength', 'invertDirection', 'iterations', 'tolerance', 'nonConvergence'], distance: ['target', 'distance', 'mode'], transform: ['target', 'copyFactor', 'copyFactorY', 'offset', 'min', 'max'], translation: ['target', 'copyFactor', 'copyFactorY', 'offsetX', 'offsetY', 'minX', 'maxX', 'minY', 'maxY', 'limitSpace'], scale: ['target', 'copyFactor', 'copyFactorY', 'offsetX', 'offsetY', 'minX', 'maxX', 'minY', 'maxY'], rotation: ['target', 'copyFactor', 'offset', 'min', 'max'], 'follow-path': ['path', 'distance', 'distanceEnd', 'offset', 'orient'], scroll: ['axis', 'offsetParameterX', 'offsetParameterY', 'percentParameterX', 'percentParameterY', 'indexParameter', 'velocityParameterX', 'velocityParameterY', 'activeParameter', 'viewport', 'content', 'infinite', 'virtualize', 'virtualizeBuffer', 'interactive', 'threshold', 'dragMultiplier', 'snap', 'physics'], scrollbar: ['scrollConstraint', 'autoSize'] };
  keys(constraint, [...common, ...extras[kind]], path); identifier(constraint.id, `${path}.id`); finite(constraint.order, `${path}.order`); optionalBoolean(constraint.enabled, `${path}.enabled`); range(constraint.strength, 0, 1, `${path}.strength`); const constrained = identifier(constraint.constrained, `${path}.constrained`); if (!boneIds.has(constrained)) fail('E_RIG_REFERENCE', `${path}.constrained`, `unknown bone ${constrained}`); optionalEnum(constraint.sourceSpace, ['local', 'world'], `${path}.sourceSpace`); optionalEnum(constraint.destinationSpace, ['local', 'world'], `${path}.destinationSpace`);
  if (kind === 'ik') { targetBone(constraint.target, `${path}.target`, boneIds); integerRange(constraint.chainLength, 1, boneIds.size, `${path}.chainLength`); optionalBoolean(constraint.invertDirection, `${path}.invertDirection`); const iterations = optionalInteger(constraint.iterations, 1, limits.maxConstraintIterations, `${path}.iterations`); void iterations; optionalPositive(constraint.tolerance, `${path}.tolerance`); optionalEnum(constraint.nonConvergence, ['error', 'clamp'], `${path}.nonConvergence`); }
  else if (kind === 'distance') { targetBone(constraint.target, `${path}.target`, boneIds); nonNegative(constraint.distance, `${path}.distance`); optionalEnum(constraint.mode, ['exact', 'minimum', 'maximum'], `${path}.mode`); }
  else if (kind === 'transform') { targetBone(constraint.target, `${path}.target`, boneIds); optionalFinite(constraint.copyFactor, `${path}.copyFactor`); optionalFinite(constraint.copyFactorY, `${path}.copyFactorY`); optionalTransform(constraint.offset, `${path}.offset`); optionalTransform(constraint.min, `${path}.min`); optionalTransform(constraint.max, `${path}.max`); }
  else if (kind === 'translation' || kind === 'scale') { targetBone(constraint.target, `${path}.target`, boneIds); for (const name of ['copyFactor', 'copyFactorY', 'offsetX', 'offsetY', 'minX', 'maxX', 'minY', 'maxY']) optionalFinite(constraint[name], `${path}.${name}`); if (kind === 'translation') optionalEnum(constraint.limitSpace, ['local', 'world'], `${path}.limitSpace`); }
  else if (kind === 'rotation') { targetBone(constraint.target, `${path}.target`, boneIds); for (const name of ['copyFactor', 'offset', 'min', 'max']) optionalFinite(constraint[name], `${path}.${name}`); }
  else if (kind === 'follow-path') { const pathId = identifier(constraint.path, `${path}.path`); if (!pathIds.has(pathId)) fail('E_RIG_REFERENCE', `${path}.path`, `unknown path ${pathId}`); finite(constraint.distance, `${path}.distance`); optionalFinite(constraint.distanceEnd, `${path}.distanceEnd`); optionalFinite(constraint.offset, `${path}.offset`); optionalBoolean(constraint.orient, `${path}.orient`); }
  else if (kind === 'scroll') validateScroll(constraint, path, parameterIds);
  else { const scroll = identifier(constraint.scrollConstraint, `${path}.scrollConstraint`); if (constraintKinds.get(scroll) !== 'scroll') fail('E_RIG_REFERENCE', `${path}.scrollConstraint`, `expected scroll constraint, received ${scroll}`); optionalBoolean(constraint.autoSize, `${path}.autoSize`); }
}

function validateScroll(constraint: Record<string, unknown>, path: string, parameterIds: Set<string>): void { enumeration(constraint.axis, ['x', 'y', 'both'], `${path}.axis`); for (const name of ['offsetParameterX', 'offsetParameterY', 'percentParameterX', 'percentParameterY', 'indexParameter', 'velocityParameterX', 'velocityParameterY', 'activeParameter']) { const parameter = optionalIdentifier(constraint[name], `${path}.${name}`); if (parameter !== undefined && !parameterIds.has(parameter)) fail('E_RIG_REFERENCE', `${path}.${name}`, `unknown parameter ${parameter}`); } tuple(constraint.viewport, 2, `${path}.viewport`, 0); tuple(constraint.content, 2, `${path}.content`, 0); optionalBoolean(constraint.infinite, `${path}.infinite`); optionalBoolean(constraint.virtualize, `${path}.virtualize`); optionalNonNegative(constraint.virtualizeBuffer, `${path}.virtualizeBuffer`); optionalBoolean(constraint.interactive, `${path}.interactive`); optionalNonNegative(constraint.threshold, `${path}.threshold`); optionalNonNegative(constraint.dragMultiplier, `${path}.dragMultiplier`); optionalPositive(constraint.snap, `${path}.snap`); if (constraint.physics !== undefined) { const physics = object(constraint.physics, `${path}.physics`); keys(physics, ['kind', 'friction', 'speedMultiplier', 'elasticFactor', 'threshold'], `${path}.physics`); const kind = enumeration(physics.kind, ['clamped', 'elastic'], `${path}.physics.kind`); nonNegative(physics.friction, `${path}.physics.friction`); nonNegative(physics.speedMultiplier, `${path}.physics.speedMultiplier`); if (kind === 'elastic') optionalNonNegative(physics.elasticFactor, `${path}.physics.elasticFactor`); optionalNonNegative(physics.threshold, `${path}.physics.threshold`); } }

function validateDriver(value: unknown, path: string, ids: Set<string>, parameterIds: Set<string>, boneIds: Set<string>, constraintKinds: ReadonlyMap<string, RigConstraint['kind']>, drawableIds: Set<string>): void {
  const driver = object(value, path); keys(driver, ['id', 'parameter', 'input', 'output', 'clamp', 'mode', 'target'], path); const id = identifier(driver.id, `${path}.id`); unique(ids, id, `${path}.id`); const parameter = identifier(driver.parameter, `${path}.parameter`); if (!parameterIds.has(parameter)) fail('E_RIG_REFERENCE', `${path}.parameter`, `unknown parameter ${parameter}`); const input = tuple(driver.input, 2, `${path}.input`); tuple(driver.output, 2, `${path}.output`); if (input[0] === input[1]) fail('E_RIG_DEGENERATE', `${path}.input`, 'driver input range must be non-zero'); optionalBoolean(driver.clamp, `${path}.clamp`); optionalEnum(driver.mode, ['replace', 'add'], `${path}.mode`);
  const target = object(driver.target, `${path}.target`); const kind = enumeration(target.kind, ['bone', 'constraint', 'drawable'], `${path}.target.kind`); keys(target, ['kind', 'id', 'property'], `${path}.target`); const targetId = identifier(target.id, `${path}.target.id`);
  if (kind === 'bone') { if (!boneIds.has(targetId)) fail('E_RIG_REFERENCE', `${path}.target.id`, `unknown bone ${targetId}`); enumeration(target.property, ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'skew'], `${path}.target.property`); }
  else if (kind === 'drawable') { if (!drawableIds.has(targetId)) fail('E_RIG_REFERENCE', `${path}.target.id`, `unknown drawable ${targetId}`); enumeration(target.property, ['opacity', 'drawOrder', 'visibility'], `${path}.target.property`); }
  else {
    const constraintKind = constraintKinds.get(targetId); if (!constraintKind) fail('E_RIG_REFERENCE', `${path}.target.id`, `unknown constraint ${targetId}`);
    const allowed = constraintKind === 'distance' ? ['strength', 'distance'] : constraintKind === 'follow-path' || constraintKind === 'rotation' ? ['strength', 'offset'] : ['strength'];
    enumeration(target.property, allowed, `${path}.target.property`);
  }
}

function validateJoystick(value: unknown, path: string, ids: Set<string>, parameterIds: Set<string>, drawableIds: Set<string>): void { const joystick = object(value, path); keys(joystick, ['id', 'xParameter', 'yParameter', 'center', 'size', 'origin', 'handleDrawable', 'invertX', 'invertY'], path); const id = identifier(joystick.id, `${path}.id`); unique(ids, id, `${path}.id`); for (const name of ['xParameter', 'yParameter']) { const parameter = optionalIdentifier(joystick[name], `${path}.${name}`); if (parameter !== undefined && !parameterIds.has(parameter)) fail('E_RIG_REFERENCE', `${path}.${name}`, `unknown parameter ${parameter}`); } tuple(joystick.center, 2, `${path}.center`); tuple(joystick.size, 2, `${path}.size`, Number.EPSILON); if (joystick.origin !== undefined) tuple(joystick.origin, 2, `${path}.origin`); const handle = optionalIdentifier(joystick.handleDrawable, `${path}.handleDrawable`); if (handle !== undefined && !drawableIds.has(handle)) fail('E_RIG_REFERENCE', `${path}.handleDrawable`, `unknown drawable ${handle}`); optionalBoolean(joystick.invertX, `${path}.invertX`); optionalBoolean(joystick.invertY, `${path}.invertY`); }

function validateInstances(values: unknown[], rigValues: unknown[], rigIds: Set<string>, parameterIds: Set<string>, limits: RigLimits): void { const ids = new Set<string>(); const instances = values.map((value, index) => { const path = `$.instances[${index}]`, instance = object(value, path); keys(instance, ['id', 'rig', 'parentInstance', 'parentBone', 'transform', 'parameterMap'], path); const id = identifier(instance.id, `${path}.id`); unique(ids, id, `${path}.id`); const rig = identifier(instance.rig, `${path}.rig`); if (!rigIds.has(rig)) fail('E_RIG_REFERENCE', `${path}.rig`, `unknown rig ${rig}`); optionalIdentifier(instance.parentInstance, `${path}.parentInstance`); optionalIdentifier(instance.parentBone, `${path}.parentBone`); optionalTransform(instance.transform, `${path}.transform`); if (instance.parameterMap !== undefined) { const map = object(instance.parameterMap, `${path}.parameterMap`); for (const [local, global] of Object.entries(map)) { identifier(local, `${path}.parameterMap.${local}`); if (!parameterIds.has(local)) fail('E_RIG_REFERENCE', `${path}.parameterMap.${local}`, `unknown local parameter ${local}`); const parameter = identifier(global, `${path}.parameterMap.${local}`); if (!parameterIds.has(parameter)) fail('E_RIG_REFERENCE', `${path}.parameterMap.${local}`, `unknown parameter ${parameter}`); } } return instance; }); const rigBones = new Map<string, Set<string>>(); for (const value of rigValues) { const rig = object(value, '$.rigs[]'); rigBones.set(rig.id as string, new Set(array(rig.bones, '$.rigs[].bones').map(bone => object(bone, '$.rigs[].bones[]').id as string))); } const byId = new Map(instances.map(instance => [instance.id as string, instance])); for (const [index, instance] of instances.entries()) { const parent = instance.parentInstance as string | undefined; if (parent !== undefined && !ids.has(parent)) fail('E_RIG_REFERENCE', `$.instances[${index}].parentInstance`, `unknown instance ${parent}`); const parentBone = instance.parentBone as string | undefined; if (parentBone !== undefined) { if (!parent) fail('E_RIG_REFERENCE', `$.instances[${index}].parentBone`, 'parentBone requires parentInstance'); const parentRig = byId.get(parent)!.rig as string; if (!rigBones.get(parentRig)!.has(parentBone)) fail('E_RIG_REFERENCE', `$.instances[${index}].parentBone`, `unknown parent bone ${parentBone}`); } } const states = new Map<string, 1 | 2>(); const visit = (id: string, depth: number): void => { if (depth > limits.maxNestingDepth) fail('E_RIG_LIMIT', '$.instances', `instance depth exceeds ${limits.maxNestingDepth}`); if (states.get(id) === 1) fail('E_RIG_CYCLE', '$.instances', `instance cycle includes ${id}`); if (states.get(id) === 2) return; states.set(id, 1); const parent = byId.get(id)?.parentInstance as string | undefined; if (parent) visit(parent, depth + 1); states.set(id, 2); }; for (const id of ids) visit(id, 1); }

function validateTotals(totals: Totals, limits: RigLimits): void { const pairs: Array<[keyof Totals, keyof RigLimits]> = [['bones', 'maxBones'], ['meshes', 'maxMeshes'], ['drawables', 'maxDrawables'], ['vertices', 'maxVertices'], ['indices', 'maxIndices'], ['influences', 'maxInfluences'], ['constraints', 'maxConstraints'], ['paths', 'maxPaths'], ['pathPoints', 'maxPathPoints'], ['drivers', 'maxDrivers']]; for (const [total, maximum] of pairs) limit(totals[total], limits[maximum], `$.${total}`); const gpuBytes = totals.vertices * 16 + totals.indices * 4 + totals.influences * 8 + totals.bones * 24; limit(gpuBytes, limits.maxGpuBytes, '$.gpuBytes'); }
function validateTransform(value: unknown, path: string): void { const transform = object(value, path); keys(transform, ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'skew'], path); finite(transform.x, `${path}.x`); finite(transform.y, `${path}.y`); finite(transform.rotation, `${path}.rotation`); finite(transform.scaleX, `${path}.scaleX`); finite(transform.scaleY, `${path}.scaleY`); optionalFinite(transform.skew, `${path}.skew`); }
function optionalTransform(value: unknown, path: string): void { if (value !== undefined) validateTransform(value, path); }
function targetBone(value: unknown, path: string, ids: Set<string>): string { const id = identifier(value, path); if (!ids.has(id)) fail('E_RIG_REFERENCE', path, `unknown bone ${id}`); return id; }
function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) fail('E_RIG_FORMAT', path, 'expected object'); return value as Record<string, unknown>; }
function array(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) fail('E_RIG_FORMAT', path, 'expected array'); return value; }
function optionalArray(value: unknown, path: string): unknown[] { return value === undefined ? [] : array(value, path); }
function numericArray(value: unknown, path: string): RigNumericArray { if (!Array.isArray(value) && !(value instanceof Float32Array)) fail('E_RIG_FORMAT', path, 'expected numeric array'); for (let index = 0; index < value.length; index++) finite(value[index], `${path}[${index}]`); return value as RigNumericArray; }
function indexArray(value: unknown, path: string): readonly number[] | Uint32Array { if (!Array.isArray(value) && !(value instanceof Uint32Array)) fail('E_RIG_FORMAT', path, 'expected index array'); for (let index = 0; index < value.length; index++) integerRange(value[index], 0, 0xffff_ffff, `${path}[${index}]`); return value as readonly number[] | Uint32Array; }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { const accepted = new Set(allowed); for (const key of Object.keys(value)) if (!accepted.has(key)) fail('E_RIG_FORMAT', `${path}.${key}`, 'unknown property'); }
function literal<T extends string | number>(value: unknown, expected: T, path: string): T { if (value !== expected) fail('E_RIG_FORMAT', path, `expected ${String(expected)}`); return expected; }
function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) fail('E_RIG_FORMAT', path, `expected one of ${allowed.join(', ')}`); return value as T; }
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined { return value === undefined ? undefined : enumeration(value, allowed, path); }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) fail('E_RIG_NUMBER', path, 'expected finite number'); return value; }
function nonNegative(value: unknown, path: string): number { const result = finite(value, path); if (result < 0) fail('E_RIG_NUMBER', path, 'expected non-negative number'); return result; }
function positive(value: unknown, path: string): number { const result = finite(value, path); if (result <= 0) fail('E_RIG_NUMBER', path, 'expected positive number'); return result; }
function range(value: unknown, minimum: number, maximum: number, path: string): number { const result = finite(value, path); if (result < minimum || result > maximum) fail('E_RIG_NUMBER', path, `expected ${minimum}..${maximum}`); return result; }
function optionalFinite(value: unknown, path: string): number | undefined { return value === undefined ? undefined : finite(value, path); }
function optionalNonNegative(value: unknown, path: string): number | undefined { return value === undefined ? undefined : nonNegative(value, path); }
function optionalPositive(value: unknown, path: string): number | undefined { return value === undefined ? undefined : positive(value, path); }
function optionalRange(value: unknown, minimum: number, maximum: number, path: string): number | undefined { return value === undefined ? undefined : range(value, minimum, maximum, path); }
function integerRange(value: unknown, minimum: number, maximum: number, path: string): number { const result = finite(value, path); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail('E_RIG_NUMBER', path, `expected integer ${minimum}..${maximum}`); return result; }
function optionalInteger(value: unknown, minimum: number, maximum: number, path: string): number | undefined { return value === undefined ? undefined : integerRange(value, minimum, maximum, path); }
function tuple(value: unknown, length: number, path: string, minimum = -Infinity, maximum = Infinity): number[] { if (!Array.isArray(value) || value.length !== length) fail('E_RIG_FORMAT', path, `expected ${length}-number tuple`); return value.map((item, index) => range(item, minimum, maximum, `${path}[${index}]`)); }
function optionalColor(value: unknown, path: string): void { if (value !== undefined) tuple(value, 4, path, 0, 1); }
function identifier(value: unknown, path: string): string { if (typeof value !== 'string' || value.length < 1 || value.length > 256) fail('E_RIG_FORMAT', path, 'expected non-empty identifier up to 256 characters'); return value; }
function optionalIdentifier(value: unknown, path: string): string | undefined { return value === undefined ? undefined : identifier(value, path); }
function optionalBoolean(value: unknown, path: string): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') fail('E_RIG_FORMAT', path, 'expected boolean'); return value; }
function unique(ids: Set<string>, id: string, path: string): void { if (ids.has(id)) fail('E_RIG_REFERENCE', path, `duplicate id ${id}`); ids.add(id); }
function limit(value: number, maximum: number, path: string): void { if (!Number.isFinite(value) || value > maximum) fail('E_RIG_LIMIT', path, `limit ${maximum} exceeded by ${value}`); }
function fail(code: ConstructorParameters<typeof ParameterizedRigDiagnostic>[0], path: string, message: string): never { throw new ParameterizedRigDiagnostic(code, path, message); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
