import { clamp, decomposeMatrix, IDENTITY_MATRIX, invertMatrix, mix, mixAngle, multiplyMatrix, mutableTransform, normalizeAngle, transformMatrix, transformPoint } from './math.js';
import type { EvaluatedRigDocument, EvaluatedRigPose, Matrix2D, MutableTransform, RigBonePose, RigDrawablePose, RigEvaluateOptions, RigMeshPose, RuntimeConstraint, RuntimeDrawable, RuntimeRigDefinition, RuntimeRigDocument, RuntimeRigInstance } from './runtime-types.js';

export type RigRuntimeErrorCode = 'E_RIG_RUNTIME_FORMAT' | 'E_RIG_RUNTIME_REFERENCE' | 'E_RIG_RUNTIME_DEGENERATE' | 'E_RIG_RUNTIME_NON_CONVERGENCE' | 'E_RIG_RUNTIME_DISPOSED';
export class RigRuntimeError extends Error { readonly name = 'RigRuntimeError'; constructor(readonly code: RigRuntimeErrorCode, message: string) { super(message); } }

interface WorkingPose { readonly definition: RuntimeRigDefinition; readonly bones: RigBonePose[]; readonly boneIndex: Map<string, number>; readonly constraints: RuntimeConstraint[]; readonly drawables: RigDrawablePose[]; readonly paths: Map<string, { readonly points: ArrayLike<number>; readonly closed?: boolean }>; readonly parameters: Map<string, number>; readonly instanceMatrix: Matrix2D; }

export class ParameterizedRigSolver {
  private disposed = false;
  constructor(readonly document: RuntimeRigDocument) {
    if (document.format !== 'haiyue-parameterized-rig-2d' || document.version !== 2 || document.extension !== 'org.haiyue.deformable-mesh-2d@2') throw new RigRuntimeError('E_RIG_RUNTIME_FORMAT', 'Unsupported parameterized rig document.');
  }

  evaluate(options: RigEvaluateOptions): EvaluatedRigDocument {
    this.assertLive();
    if (!Number.isFinite(options.time)) throw new RigRuntimeError('E_RIG_RUNTIME_FORMAT', 'Evaluation time must be finite.');
    const time = normalizeTime(options.time, this.document.duration ?? 0, options.loop ?? false);
    const globalParameters = resolveParameters(this.document, options);
    const definitions = new Map(this.document.rigs.map(rig => [rig.id, rig]));
    const instanceById = new Map(this.document.instances.map(instance => [instance.id, instance]));
    const output = new Map<string, EvaluatedRigPose>();
    const instanceMatrices = new Map<string, Matrix2D>();
    const evaluateInstance = (instance: RuntimeRigInstance): EvaluatedRigPose => {
      const existing = output.get(instance.id); if (existing) return existing;
      const definition = definitions.get(instance.rig); if (!definition) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Missing rig ${instance.rig}.`);
      let parentMatrix = IDENTITY_MATRIX;
      if (instance.parentInstance) {
        const parentDefinition = instanceById.get(instance.parentInstance); if (!parentDefinition) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Missing parent instance ${instance.parentInstance}.`);
        const parent = evaluateInstance(parentDefinition);
        if (instance.parentBone) { const bone = parent.bones.find(candidate => candidate.id === instance.parentBone); if (!bone) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Missing parent bone ${instance.parentBone}.`); parentMatrix = asMatrix(bone.world); }
        else parentMatrix = instanceMatrices.get(parent.instanceId) ?? IDENTITY_MATRIX;
      }
      const instanceMatrix = multiplyMatrix(parentMatrix, transformMatrix(instance.transform ?? DEFAULT_TRANSFORM));
      instanceMatrices.set(instance.id, instanceMatrix);
      const parameters = new Map(globalParameters);
      for (const [local, global] of Object.entries(instance.parameterMap ?? {})) parameters.set(local, globalParameters.get(global) ?? 0);
      applyJoysticks(this.document, definition, instance, parameters, options);
      const working = createWorkingPose(definition, parameters, instanceMatrix);
      applyDrivers(working);
      recomputeWorld(working);
      const constraintOrder: string[] = [];
      for (const constraint of [...working.constraints].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
        if (constraint.enabled === false || constraint.strength === 0) continue;
        solveConstraint(working, constraint, time);
        recomputeWorld(working);
        constraintOrder.push(constraint.id);
      }
      for (const bone of working.bones) bone.world.set(multiplyMatrix(instanceMatrix, bone.world));
      const meshes = definition.meshes.map(mesh => skinMesh(mesh, working.bones, instanceMatrix));
      const hasSolo = working.drawables.some(drawable => drawable.visible && definition.drawables.find(item => item.id === drawable.id)?.solo);
      if (hasSolo) for (const drawable of working.drawables) if (!definition.drawables.find(item => item.id === drawable.id)?.solo) drawable.visible = false;
      const pose: EvaluatedRigPose = Object.freeze({ instanceId: instance.id, rigId: definition.id, parameters: new Map(parameters), bones: Object.freeze(working.bones), meshes: Object.freeze(meshes), drawables: Object.freeze(working.drawables.sort((a, b) => a.drawOrder - b.drawOrder || a.id.localeCompare(b.id))), constraintOrder: Object.freeze(constraintOrder) });
      output.set(instance.id, pose); return pose;
    };
    for (const instance of this.document.instances) evaluateInstance(instance);
    return Object.freeze({ time, instances: output });
  }

  dispose(): void { this.disposed = true; }
  private assertLive(): void { if (this.disposed) throw new RigRuntimeError('E_RIG_RUNTIME_DISPOSED', 'Parameterized rig solver is disposed.'); }
}

const DEFAULT_TRANSFORM = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, skew: 0 });

function resolveParameters(document: RuntimeRigDocument, options: RigEvaluateOptions): Map<string, number> {
  const definitions = new Map(document.parameters.map(parameter => [parameter.id, parameter]));
  const values = new Map(document.parameters.map(parameter => [parameter.id, parameter.default]));
  for (const [id, value] of Object.entries(options.parameters ?? {})) { const definition = definitions.get(id); if (!definition || !Number.isFinite(value)) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Invalid parameter ${id}.`); values.set(id, clamp(value, definition.min, definition.max)); }
  const layers = options.layers ?? [];
  const layerIds = new Set<string>();
  for (const layer of layers) {
    if (!layer.id || layerIds.has(layer.id) || !Number.isFinite(layer.weight) || layer.weight < 0 || (layer.mode !== undefined && layer.mode !== 'override' && layer.mode !== 'additive')) throw new RigRuntimeError('E_RIG_RUNTIME_FORMAT', `Invalid parameter layer ${layer.id}.`);
    layerIds.add(layer.id);
    for (const [id, value] of Object.entries(layer.values)) if (!definitions.has(id) || !Number.isFinite(value)) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Invalid layer parameter ${id}.`);
  }
  for (const parameter of document.parameters) {
    const overrides = layers.filter(layer => (layer.mode ?? 'override') === 'override' && layer.values[parameter.id] !== undefined && layer.weight > 0).sort((a, b) => a.id.localeCompare(b.id));
    const additives = layers.filter(layer => layer.mode === 'additive' && layer.values[parameter.id] !== undefined && layer.weight > 0).sort((a, b) => a.id.localeCompare(b.id));
    if (overrides.length > 0) { const total = overrides.reduce((sum, layer) => sum + layer.weight, 0), denominator = Math.max(1, total); let result = values.get(parameter.id)! * Math.max(0, 1 - total); for (const layer of overrides) result += layer.values[parameter.id]! * layer.weight / denominator; values.set(parameter.id, result); }
    for (const layer of additives) values.set(parameter.id, values.get(parameter.id)! + layer.values[parameter.id]! * layer.weight);
    values.set(parameter.id, clamp(values.get(parameter.id)!, parameter.min, parameter.max));
  }
  return values;
}

function applyJoysticks(document: RuntimeRigDocument, rig: RuntimeRigDefinition, instance: RuntimeRigInstance, parameters: Map<string, number>, options: RigEvaluateOptions): void {
  const definitions = new Map(document.parameters.map(parameter => [parameter.id, parameter]));
  for (const joystick of rig.joysticks ?? []) {
    const input = options.joysticks?.[`${instance.id}:${joystick.id}`] ?? options.joysticks?.[joystick.id]; if (!input) continue;
    if (input.length !== 2 || !Number.isFinite(input[0]) || !Number.isFinite(input[1])) throw new RigRuntimeError('E_RIG_RUNTIME_FORMAT', `Invalid joystick input ${joystick.id}.`);
    const apply = (axis: 0 | 1, localId: string | undefined, invert: boolean): void => { if (!localId) return; const id = instance.parameterMap?.[localId] ?? localId, definition = definitions.get(id); if (!definition) return; const normalized = clamp((input[axis] - joystick.center[axis]) / (joystick.size[axis] * 0.5), -1, 1) * (invert ? -1 : 1); parameters.set(localId, definition.min + (normalized + 1) * 0.5 * (definition.max - definition.min)); parameters.set(id, parameters.get(localId)!); };
    apply(0, joystick.xParameter, joystick.invertX ?? false); apply(1, joystick.yParameter, joystick.invertY ?? false);
  }
}

function createWorkingPose(definition: RuntimeRigDefinition, parameters: Map<string, number>, instanceMatrix: Matrix2D): WorkingPose {
  const boneIndex = new Map(definition.bones.map((bone, index) => [bone.id, index]));
  const bones = definition.bones.map(bone => ({ id: bone.id, parent: bone.parent === undefined ? -1 : boneIndex.get(bone.parent) ?? -1, length: bone.length, inverseBind: bone.inverseBind, local: mutableTransform(bone.bind), world: new Float32Array(6) }));
  const constraints = structuredClone(definition.constraints ?? []) as RuntimeConstraint[];
  const drawables = definition.drawables.map(drawable => mutableDrawable(drawable));
  return { definition, bones, boneIndex, constraints, drawables, paths: new Map((definition.paths ?? []).map(path => [path.id, { points: path.points, ...(path.closed === undefined ? {} : { closed: path.closed }) }])), parameters, instanceMatrix };
}

function mutableDrawable(drawable: RuntimeDrawable): RigDrawablePose { return { id: drawable.id, mesh: drawable.mesh, ...(drawable.texture === undefined ? {} : { texture: drawable.texture }), visible: drawable.visible ?? true, drawOrder: drawable.drawOrder, opacity: drawable.opacity ?? 1, blendMode: drawable.blendMode ?? 'normal', culling: drawable.culling ?? false, multiplyColor: drawable.multiplyColor ?? [1, 1, 1, 1], screenColor: drawable.screenColor ?? [0, 0, 0, 0], masks: Object.freeze([...(drawable.masks ?? [])]), maskMode: drawable.maskMode ?? 'alpha' }; }

function applyDrivers(pose: WorkingPose): void {
  for (const driver of [...(pose.definition.drivers ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const parameter = pose.parameters.get(driver.parameter); if (parameter === undefined) continue;
    let amount = (parameter - driver.input[0]) / (driver.input[1] - driver.input[0]); if (driver.clamp ?? true) amount = clamp(amount, 0, 1); const value = mix(driver.output[0], driver.output[1], amount), additive = driver.mode === 'add';
    if (driver.target.kind === 'bone') { const bone = pose.bones[pose.boneIndex.get(driver.target.id)!]!, key = driver.target.property; bone.local[key] = additive ? bone.local[key] + value : value; }
    else if (driver.target.kind === 'constraint') { const constraint = pose.constraints.find(item => item.id === driver.target.id) as unknown as Record<string, unknown> | undefined; if (constraint) { const current = typeof constraint[driver.target.property] === 'number' ? constraint[driver.target.property] as number : 0; constraint[driver.target.property] = additive ? current + value : value; } }
    else { const drawable = pose.drawables.find(item => item.id === driver.target.id); if (drawable) { if (driver.target.property === 'opacity') drawable.opacity = clamp(additive ? drawable.opacity + value : value, 0, 1); else if (driver.target.property === 'drawOrder') drawable.drawOrder = Math.round(additive ? drawable.drawOrder + value : value); else drawable.visible = value >= 0.5; } }
  }
}

function recomputeWorld(pose: WorkingPose): void { const states = new Uint8Array(pose.bones.length); const visit = (index: number): void => { if (states[index] === 2) return; if (states[index] === 1) throw new RigRuntimeError('E_RIG_RUNTIME_FORMAT', 'Bone cycle reached runtime.'); states[index] = 1; const bone = pose.bones[index]!, local = transformMatrix(bone.local); if (bone.parent >= 0) { visit(bone.parent); bone.world.set(multiplyMatrix(pose.bones[bone.parent]!.world, local)); } else bone.world.set(local); states[index] = 2; }; for (let index = 0; index < pose.bones.length; index++) visit(index); }

function solveConstraint(pose: WorkingPose, constraint: RuntimeConstraint, time: number): void {
  if (constraint.kind === 'ik') solveIK(pose, constraint);
  else if (constraint.kind === 'distance') solveDistance(pose, constraint);
  else if (constraint.kind === 'follow-path') solveFollowPath(pose, constraint);
  else if (constraint.kind === 'scroll') solveScroll(pose, constraint, time);
  else if (constraint.kind === 'scrollbar') solveScrollBar(pose, constraint);
  else solveCopyConstraint(pose, constraint);
}

function solveCopyConstraint(pose: WorkingPose, constraint: Exclude<RuntimeConstraint, { kind: 'ik' | 'distance' | 'follow-path' | 'scroll' | 'scrollbar' }>): void {
  const bone = getBone(pose, constraint.constrained), target = getBone(pose, constraint.target), source = constraint.sourceSpace === 'local' ? target.local : decomposeMatrix(target.world), destination = constraint.destinationSpace === 'local' ? { ...bone.local } : decomposeMatrix(bone.world), strength = constraint.strength;
  if (constraint.kind === 'translation' || constraint.kind === 'transform') { const factorX = constraint.copyFactor ?? 1, factorY = constraint.copyFactorY ?? factorX, offsetX = constraint.kind === 'transform' ? constraint.offset?.x ?? 0 : constraint.offsetX ?? 0, offsetY = constraint.kind === 'transform' ? constraint.offset?.y ?? 0 : constraint.offsetY ?? 0; let x = source.x * factorX + offsetX, y = source.y * factorY + offsetY; const minX = constraint.kind === 'transform' ? constraint.min?.x : constraint.minX, maxX = constraint.kind === 'transform' ? constraint.max?.x : constraint.maxX, minY = constraint.kind === 'transform' ? constraint.min?.y : constraint.minY, maxY = constraint.kind === 'transform' ? constraint.max?.y : constraint.maxY; if (constraint.kind === 'translation' && constraint.limitSpace !== undefined) { const limited = limitTranslation(pose, bone, target, [x, y], constraint.sourceSpace ?? 'world', constraint.destinationSpace ?? 'world', constraint.limitSpace, minX, maxX, minY, maxY); x = limited[0]; y = limited[1]; } else { x = clampOptional(x, minX, maxX); y = clampOptional(y, minY, maxY); } destination.x = mix(destination.x, x, strength); destination.y = mix(destination.y, y, strength); }
  if (constraint.kind === 'scale' || constraint.kind === 'transform') { const factorX = constraint.copyFactor ?? 1, factorY = constraint.copyFactorY ?? factorX, offsetX = constraint.kind === 'transform' ? constraint.offset?.scaleX ?? 0 : constraint.offsetX ?? 0, offsetY = constraint.kind === 'transform' ? constraint.offset?.scaleY ?? 0 : constraint.offsetY ?? 0; let x = source.scaleX * factorX + offsetX, y = source.scaleY * factorY + offsetY; const minX = constraint.kind === 'transform' ? constraint.min?.scaleX : constraint.minX, maxX = constraint.kind === 'transform' ? constraint.max?.scaleX : constraint.maxX, minY = constraint.kind === 'transform' ? constraint.min?.scaleY : constraint.minY, maxY = constraint.kind === 'transform' ? constraint.max?.scaleY : constraint.maxY; x = clampOptional(x, minX, maxX); y = clampOptional(y, minY, maxY); destination.scaleX = mix(destination.scaleX, x, strength); destination.scaleY = mix(destination.scaleY, y, strength); }
  if (constraint.kind === 'rotation' || constraint.kind === 'transform') { const factor = constraint.copyFactor ?? 1, offset = constraint.kind === 'transform' ? constraint.offset?.rotation ?? 0 : constraint.offset ?? 0, minimum = constraint.kind === 'transform' ? constraint.min?.rotation : constraint.min, maximum = constraint.kind === 'transform' ? constraint.max?.rotation : constraint.max, desired = clampOptional(source.rotation * factor + offset, minimum, maximum); destination.rotation = mixAngle(destination.rotation, desired, strength); }
  if (constraint.kind === 'transform') destination.skew = mixAngle(destination.skew, source.skew + (constraint.offset?.skew ?? 0), strength);
  applyDestination(pose, bone, destination, constraint.destinationSpace ?? 'world');
}

function solveDistance(pose: WorkingPose, constraint: Extract<RuntimeConstraint, { kind: 'distance' }>): void { const bone = getBone(pose, constraint.constrained), target = getBone(pose, constraint.target), current = decomposeMatrix(bone.world), dx = current.x - target.world[4]!, dy = current.y - target.world[5]!, actual = Math.hypot(dx, dy); if (actual < 1e-10) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', `Distance constraint ${constraint.id} has coincident bones.`); const desiredDistance = constraint.mode === 'minimum' ? Math.max(actual, constraint.distance) : constraint.mode === 'maximum' ? Math.min(actual, constraint.distance) : constraint.distance; const desiredX = target.world[4]! + dx / actual * desiredDistance, desiredY = target.world[5]! + dy / actual * desiredDistance; current.x = mix(current.x, desiredX, constraint.strength); current.y = mix(current.y, desiredY, constraint.strength); applyDestination(pose, bone, current, 'world'); }

function solveIK(pose: WorkingPose, constraint: Extract<RuntimeConstraint, { kind: 'ik' }>): void {
  const endIndex = pose.boneIndex.get(constraint.constrained)!, target = getBone(pose, constraint.target); const chain: number[] = []; let cursor = endIndex; for (let index = 0; index < constraint.chainLength && cursor >= 0; index++) { chain.push(cursor); cursor = pose.bones[cursor]!.parent; }
  if (chain.length !== constraint.chainLength || chain.some(index => pose.bones[index]!.length <= 1e-10)) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', `IK constraint ${constraint.id} has a degenerate chain.`);
  const targetPoint: readonly [number, number] = [target.world[4]!, target.world[5]!], tolerance = constraint.tolerance ?? 1e-4;
  if (chain.length === 2) solveAnalyticTwoBone(pose, chain[1]!, chain[0]!, targetPoint, constraint.strength, constraint.invertDirection ?? false);
  else {
    const iterations = constraint.iterations ?? 16;
    for (let iteration = 0; iteration < iterations; iteration++) { recomputeWorld(pose); if (endDistance(pose.bones[endIndex]!, targetPoint) <= tolerance) break; for (const jointIndex of chain) { const joint = pose.bones[jointIndex]!, tip = boneTip(pose.bones[endIndex]!); const from = Math.atan2(tip[1] - joint.world[5]!, tip[0] - joint.world[4]!), to = Math.atan2(targetPoint[1] - joint.world[5]!, targetPoint[0] - joint.world[4]!); joint.local.rotation += normalizeAngle(to - from) * constraint.strength; recomputeWorld(pose); } }
  }
  recomputeWorld(pose); const residual = endDistance(pose.bones[endIndex]!, targetPoint); if (residual > tolerance && (constraint.nonConvergence ?? 'error') === 'error') throw new RigRuntimeError('E_RIG_RUNTIME_NON_CONVERGENCE', `IK constraint ${constraint.id} residual ${residual} exceeds ${tolerance}.`);
}

function solveAnalyticTwoBone(pose: WorkingPose, rootIndex: number, endIndex: number, target: readonly [number, number], strength: number, invert: boolean): void {
  const root = pose.bones[rootIndex]!, end = pose.bones[endIndex]!, rootOrigin: readonly [number, number] = [root.world[4]!, root.world[5]!], l1 = Math.hypot(end.world[4]! - rootOrigin[0], end.world[5]! - rootOrigin[1]), l2 = Math.max(1e-9, end.length * Math.hypot(end.world[0]!, end.world[1]!)), rawDistance = Math.hypot(target[0] - rootOrigin[0], target[1] - rootOrigin[1]), distance = clamp(rawDistance, Math.abs(l1 - l2) + 1e-8, l1 + l2 - 1e-8), direction = invert ? -1 : 1, targetAngle = Math.atan2(target[1] - rootOrigin[1], target[0] - rootOrigin[0]), rootOffset = Math.acos(clamp((l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance), -1, 1)), elbowInternal = Math.acos(clamp((l1 * l1 + l2 * l2 - distance * distance) / (2 * l1 * l2), -1, 1)), desiredRoot = targetAngle - direction * rootOffset, desiredEnd = desiredRoot + direction * (Math.PI - elbowInternal);
  if (l1 <= 1e-10 || l2 <= 1e-10 || distance <= 1e-10) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', 'Analytic IK chain has coincident joints.');
  setWorldRotation(pose, root, mixAngle(worldRotation(root), desiredRoot, strength)); recomputeWorld(pose); setWorldRotation(pose, end, mixAngle(worldRotation(end), desiredEnd, strength));
}

function solveFollowPath(pose: WorkingPose, constraint: Extract<RuntimeConstraint, { kind: 'follow-path' }>): void { const path = pose.paths.get(constraint.path); if (!path) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Missing path ${constraint.path}.`); const offset = constraint.offset ?? 0, sampled = samplePath(path, constraint.distance + offset), end = constraint.distanceEnd === undefined ? undefined : samplePath(path, constraint.distanceEnd + offset), bone = getBone(pose, constraint.constrained), transform = decomposeMatrix(bone.world); transform.x = mix(transform.x, sampled.x, constraint.strength); transform.y = mix(transform.y, sampled.y, constraint.strength); if (constraint.orient) { const angle = end && Math.hypot(end.x - sampled.x, end.y - sampled.y) > 1e-10 ? Math.atan2(end.y - sampled.y, end.x - sampled.x) : sampled.angle; transform.rotation = mixAngle(transform.rotation, angle, constraint.strength); } applyDestination(pose, bone, transform, 'world'); }

function solveScroll(pose: WorkingPose, constraint: Extract<RuntimeConstraint, { kind: 'scroll' }>, time: number): void { const bone = getBone(pose, constraint.constrained), transform = decomposeMatrix(bone.world), maxX = Math.max(0, constraint.content[0] - constraint.viewport[0]), maxY = Math.max(0, constraint.content[1] - constraint.viewport[1]), drag = constraint.dragMultiplier ?? 1; let x = (parameter(pose, constraint.offsetParameterX) + parameter(pose, constraint.percentParameterX) * maxX) * drag, y = (parameter(pose, constraint.offsetParameterY) + parameter(pose, constraint.percentParameterY) * maxY) * drag; const index = parameter(pose, constraint.indexParameter); if (constraint.snap) { if (constraint.axis !== 'y') x += index * constraint.snap; if (constraint.axis !== 'x') y += index * constraint.snap; } const physics = constraint.physics, active = constraint.activeParameter === undefined || parameter(pose, constraint.activeParameter) > (constraint.threshold ?? 0); if (physics && active) { const decay = Math.exp(-physics.friction * Math.max(0, time)); x += parameter(pose, constraint.velocityParameterX) * physics.speedMultiplier * (physics.friction > 0 ? (1 - decay) / physics.friction : time); y += parameter(pose, constraint.velocityParameterY) * physics.speedMultiplier * (physics.friction > 0 ? (1 - decay) / physics.friction : time); if (physics.kind === 'elastic') { x = elasticClamp(x, 0, maxX, physics.elasticFactor ?? 0.25); y = elasticClamp(y, 0, maxY, physics.elasticFactor ?? 0.25); } }
  if (!constraint.infinite) { x = clamp(x, 0, maxX); y = clamp(y, 0, maxY); } if (constraint.axis !== 'y') transform.x = mix(transform.x, -x, constraint.strength); if (constraint.axis !== 'x') transform.y = mix(transform.y, -y, constraint.strength); applyDestination(pose, bone, transform, 'world'); }

function solveScrollBar(pose: WorkingPose, constraint: Extract<RuntimeConstraint, { kind: 'scrollbar' }>): void { const scroll = pose.constraints.find(candidate => candidate.id === constraint.scrollConstraint); if (!scroll || scroll.kind !== 'scroll') throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Scrollbar ${constraint.id} references a missing scroll constraint.`); const bone = getBone(pose, constraint.constrained), transform = decomposeMatrix(bone.world), horizontal = scroll.axis !== 'y', viewport = horizontal ? scroll.viewport[0] : scroll.viewport[1], content = horizontal ? scroll.content[0] : scroll.content[1], maximum = Math.max(0, content - viewport), offset = horizontal ? parameter(pose, scroll.offsetParameterX) + parameter(pose, scroll.percentParameterX) * maximum : parameter(pose, scroll.offsetParameterY) + parameter(pose, scroll.percentParameterY) * maximum, ratio = content > 0 ? Math.min(1, viewport / content) : 1, position = maximum > 0 ? clamp(offset / maximum, 0, 1) * viewport * (1 - ratio) : 0; if (horizontal) { transform.x = mix(transform.x, position, constraint.strength); if (constraint.autoSize) transform.scaleX = mix(transform.scaleX, ratio, constraint.strength); } else { transform.y = mix(transform.y, position, constraint.strength); if (constraint.autoSize) transform.scaleY = mix(transform.scaleY, ratio, constraint.strength); } applyDestination(pose, bone, transform, 'world'); }

function skinMesh(mesh: RuntimeRigDefinition['meshes'][number], bones: readonly RigBonePose[], instanceMatrix: Matrix2D): RigMeshPose { const vertexCount = mesh.positions.length / 2, output = new Float32Array(mesh.positions.length); for (let vertex = 0; vertex < vertexCount; vertex++) { const x = mesh.positions[vertex * 2]!, y = mesh.positions[vertex * 2 + 1]!, start = mesh.influenceOffsets[vertex]!, end = mesh.influenceOffsets[vertex + 1]!; if (start === end) { const point = transformPoint(instanceMatrix, x, y); output[vertex * 2] = point[0]; output[vertex * 2 + 1] = point[1]; continue; } let outX = 0, outY = 0; for (let influence = start; influence < end; influence++) { const jointIndex = mesh.jointIndices[influence]!, weight = mesh.weights[influence]!, bone = bones[jointIndex]!, matrix = multiplyMatrix(bone.world, bone.inverseBind), point = transformPoint(matrix, x, y); outX += point[0] * weight; outY += point[1] * weight; } output[vertex * 2] = outX; output[vertex * 2 + 1] = outY; } return Object.freeze({ id: mesh.id, positions: output, uvs: mesh.uvs, indices: mesh.indices }); }

function getBone(pose: WorkingPose, id: string): RigBonePose { const index = pose.boneIndex.get(id); if (index === undefined) throw new RigRuntimeError('E_RIG_RUNTIME_REFERENCE', `Missing bone ${id}.`); return pose.bones[index]!; }
function applyDestination(pose: WorkingPose, bone: RigBonePose, transform: MutableTransform, space: 'local' | 'world'): void { if (space === 'local') Object.assign(bone.local, transform); else { const world = transformMatrix(transform); if (bone.parent < 0) Object.assign(bone.local, transform); else { const inverse = invertMatrix(pose.bones[bone.parent]!.world); if (!inverse) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', `Parent of ${bone.id} has a singular transform.`); Object.assign(bone.local, decomposeMatrix(multiplyMatrix(inverse, world))); } } recomputeWorld(pose); }
function limitTranslation(pose: WorkingPose, bone: RigBonePose, target: RigBonePose, point: readonly [number, number], sourceSpace: 'local' | 'world', destinationSpace: 'local' | 'world', limitSpace: 'local' | 'world', minX?: number, maxX?: number, minY?: number, maxY?: number): readonly [number, number] { let world = point; if (sourceSpace === 'local' && target.parent >= 0) world = transformPoint(pose.bones[target.parent]!.world, point[0], point[1]); let limited = world; if (limitSpace === 'local' && bone.parent >= 0) { const inverse = invertMatrix(pose.bones[bone.parent]!.world); if (!inverse) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', `Parent of ${bone.id} has a singular transform.`); limited = transformPoint(inverse, world[0], world[1]); } limited = [clampOptional(limited[0], minX, maxX), clampOptional(limited[1], minY, maxY)]; if (limitSpace === destinationSpace) return limited; if (limitSpace === 'local' && bone.parent >= 0) return transformPoint(pose.bones[bone.parent]!.world, limited[0], limited[1]); if (destinationSpace === 'local' && bone.parent >= 0) { const inverse = invertMatrix(pose.bones[bone.parent]!.world); if (!inverse) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', `Parent of ${bone.id} has a singular transform.`); return transformPoint(inverse, limited[0], limited[1]); } return limited; }
function setWorldRotation(pose: WorkingPose, bone: RigBonePose, rotation: number): void { const transform = decomposeMatrix(bone.world); transform.rotation = rotation; applyDestination(pose, bone, transform, 'world'); }
function worldRotation(bone: RigBonePose): number { return Math.atan2(bone.world[1]!, bone.world[0]!); }
function boneTip(bone: RigBonePose): readonly [number, number] { return transformPoint(bone.world, bone.length, 0); }
function endDistance(bone: RigBonePose, target: readonly [number, number]): number { const tip = boneTip(bone); return Math.hypot(tip[0] - target[0], tip[1] - target[1]); }
function samplePath(path: { readonly points: ArrayLike<number>; readonly closed?: boolean }, distance: number): { x: number; y: number; angle: number } { const points = path.points, segments = points.length / 2 - 1 + (path.closed ? 1 : 0), lengths: number[] = []; let total = 0; for (let index = 0; index < segments; index++) { const next = (index + 1) % (points.length / 2), length = Math.hypot(points[next * 2]! - points[index * 2]!, points[next * 2 + 1]! - points[index * 2 + 1]!); lengths.push(length); total += length; } if (total <= 1e-10) throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', 'Follow path is degenerate.'); let remaining = path.closed ? ((distance % total) + total) % total : clamp(distance, 0, total); for (let index = 0; index < lengths.length; index++) { const length = lengths[index]!, next = (index + 1) % (points.length / 2); if (remaining <= length || index === lengths.length - 1) { const amount = length > 0 ? remaining / length : 0, ax = points[index * 2]!, ay = points[index * 2 + 1]!, bx = points[next * 2]!, by = points[next * 2 + 1]!; return { x: mix(ax, bx, amount), y: mix(ay, by, amount), angle: Math.atan2(by - ay, bx - ax) }; } remaining -= length; } throw new RigRuntimeError('E_RIG_RUNTIME_DEGENERATE', 'Follow path cannot be sampled.'); }
function parameter(pose: WorkingPose, id: string | undefined): number { return id ? pose.parameters.get(id) ?? 0 : 0; }
function elasticClamp(value: number, minimum: number, maximum: number, factor: number): number { return value < minimum ? minimum + (value - minimum) * factor : value > maximum ? maximum + (value - maximum) * factor : value; }
function clampOptional(value: number, minimum?: number, maximum?: number): number { return Math.max(minimum ?? -Infinity, Math.min(maximum ?? Infinity, value)); }
function normalizeTime(time: number, duration: number, loop: boolean): number { if (!loop || duration <= 0) return Math.max(0, duration > 0 ? Math.min(duration, time) : time); return ((time % duration) + duration) % duration; }
function asMatrix(value: ArrayLike<number>): Matrix2D { return [value[0]!, value[1]!, value[2]!, value[3]!, value[4]!, value[5]!]; }
