import { Spine2DComponent } from './Spine2DComponent';
import {
  type BonePose,
  type PathConstraintData,
  type RegionAttachment,
  type SlotData,
  type SpineData,
} from './SpineSkeletonRuntime';
import { requiredItemAt, requiredNumberAt } from '../utils/arrayAccess';
import {
  sampleCompiledTimeline,
  type SpineTimelineSamplerState,
} from './SpineTimelineRuntime';

export interface SpinePathConstraintScratch {
  pathBonesScratch: BonePose[];
  pathConstrainedBonesScratch: Set<string>;
  pathSpacesScratch: number[];
  pathLengthsScratch: number[];
  pathWorldScratch: number[];
  pathOutScratch: number[];
  pathCurveWorldScratch: number[];
  pathCurvesScratch: number[];
  pathSegmentsScratch: number[];
  pathCurvePointScratch: number[];
  pathStateScratch: { position: number; spacing: number; mixRotate: number; mixX: number; mixY: number };
}

export interface SpinePathConstraintRuntime extends SpinePathConstraintScratch {
  data: SpineData;
  timelineSamplerState: SpineTimelineSamplerState;
}

export interface SpinePathConstraintDeps {
  normalizeRadians(value: number): number;
  updateDescendantBoneTrees(
    name: string,
    poses: Map<string, BonePose>,
    children: Map<string, string[]>,
    blockedRoots?: Set<string>,
  ): void;
}

export function createSpinePathConstraintScratch(): SpinePathConstraintScratch {
  return {
    pathBonesScratch: [],
    pathConstrainedBonesScratch: new Set(),
    pathSpacesScratch: [],
    pathLengthsScratch: [],
    pathWorldScratch: [],
    pathOutScratch: [],
    pathCurveWorldScratch: [],
    pathCurvesScratch: [],
    pathSegmentsScratch: [],
    pathCurvePointScratch: [],
    pathStateScratch: { position: 0, spacing: 0, mixRotate: 0, mixX: 0, mixY: 0 },
  };
}

export function applyPathConstraint(
  runtime: SpinePathConstraintRuntime,
  component: Spine2DComponent,
  constraint: PathConstraintData,
  time: number,
  duration: number,
  loop: boolean,
  poses: Map<string, BonePose>,
  children: Map<string, string[]>,
  deps: SpinePathConstraintDeps,
): void {
  const data = runtime.data;
  const slot = data.slots.find(item => item.name === constraint.slot);
  if (!slot) return;
  const slotBone = poses.get(slot.bone);
  if (!slotBone) return;
  const skin = data.skins[component.skin] ?? {};
  const slotSkin = skin[slot.name] ?? data.skins.default?.[slot.name] ?? {};
  const attachmentName = slot.attachment ?? Object.keys(slotSkin)[0];
  const attachment = attachmentName ? slotSkin[attachmentName] : null;
  if (!attachment || attachment.type !== 'path') return;
  const state = samplePathConstraint(
    runtime,
    constraint,
    data.animations[component.animation]?.path?.[constraint.name],
    time,
    duration,
    loop,
    runtime.pathStateScratch,
  );
  if (state.mixRotate === 0 && state.mixX === 0 && state.mixY === 0) return;

  const bones = runtime.pathBonesScratch;
  const constrainedBones = runtime.pathConstrainedBonesScratch;
  bones.length = 0;
  constrainedBones.clear();
  for (const name of constraint.bones) {
    constrainedBones.add(name);
    const bone = poses.get(name);
    if (bone) bones.push(bone);
  }
  const boneCount = bones.length;
  if (boneCount === 0) return;
  const tangents = constraint.rotateMode === 'tangent';
  const chainScale = constraint.rotateMode === 'chainScale';
  const spacesCount = tangents ? boneCount : boneCount + 1;
  const spaces = runtime.pathSpacesScratch;
  const lengths = runtime.pathLengthsScratch;
  spaces.length = spacesCount;
  lengths.length = boneCount;
  for (let i = 0; i < spacesCount; i++) spaces[i] = 0;
  for (let i = 0; i < boneCount; i++) lengths[i] = 0;

  switch (constraint.spacingMode) {
    case 'percent':
      if (chainScale) {
        for (let i = 0; i < spacesCount - 1; i++) {
          lengths[i] = getBoneWorldLength(requiredItemAt(bones, i, 'path constrained bones'));
        }
      }
      for (let i = 1; i < spacesCount; i++) spaces[i] = state.spacing;
      break;
    case 'proportional': {
      let sum = 0;
      for (let i = 0; i < spacesCount - 1;) {
        const length = getBoneWorldLength(requiredItemAt(bones, i, 'path constrained bones'));
        if (chainScale) lengths[i] = length;
        spaces[++i] = length < 0.000001 ? state.spacing : length;
        sum += length < 0.000001 ? 0 : length;
      }
      if (sum > 0) {
        const scale = spacesCount / sum * state.spacing;
        for (let i = 1; i < spacesCount; i++) spaces[i] = requiredNumberAt(spaces, i, 'path spaces') * scale;
      }
      break;
    }
    default:
      for (let i = 0; i < spacesCount - 1;) {
        const bone = requiredItemAt(bones, i, 'path constrained bones');
        const worldLength = getBoneWorldLength(bone);
        if (chainScale) lengths[i] = worldLength;
        spaces[++i] = constraint.spacingMode === 'length' && bone.data.length > 0
          ? Math.max(0, bone.data.length + state.spacing) * worldLength / bone.data.length
          : state.spacing;
      }
      break;
  }

  const positions = computePathWorldPositions(runtime, poses, slotBone, attachment, constraint, state.position, spaces, tangents);
  let boneX = requiredNumberAt(positions, 0, 'path positions');
  let boneY = requiredNumberAt(positions, 1, 'path positions');
  let offsetRotation = constraint.offsetRotation * Math.PI / 180;
  if (offsetRotation !== 0 && slotBone.a * slotBone.d - slotBone.b * slotBone.c < 0) offsetRotation = -offsetRotation;
  const tip = offsetRotation === 0 && constraint.rotateMode === 'chain';

  for (let i = 0, positionIndex = 3; i < boneCount; i++, positionIndex += 3) {
    const bone = requiredItemAt(bones, i, 'path constrained bones');
    bone.worldX += (boneX - bone.worldX) * state.mixX;
    bone.worldY += (boneY - bone.worldY) * state.mixY;
    const x = requiredNumberAt(positions, positionIndex, 'path positions');
    const y = requiredNumberAt(positions, positionIndex + 1, 'path positions');
    const dx = x - boneX;
    const dy = y - boneY;
    if (chainScale) {
      const length = requiredNumberAt(lengths, i, 'path lengths');
      if (length !== 0) {
        const scale = (Math.hypot(dx, dy) / length - 1) * state.mixRotate + 1;
        bone.a *= scale;
        bone.c *= scale;
      }
    }
    boneX = x;
    boneY = y;
    if (state.mixRotate > 0) {
      const a = bone.a;
      const b = bone.b;
      const c = bone.c;
      const d = bone.d;
      let rotation = tangents
        ? requiredNumberAt(positions, positionIndex - 1, 'path positions')
        : requiredNumberAt(spaces, i + 1, 'path spaces') === 0
          ? requiredNumberAt(positions, positionIndex + 2, 'path positions')
          : Math.atan2(dy, dx);
      rotation -= Math.atan2(c, a);
      if (tip) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const length = bone.data.length;
        boneX += (length * (cos * a - sin * c) - dx) * state.mixRotate;
        boneY += (length * (sin * a + cos * c) - dy) * state.mixRotate;
      } else {
        rotation += offsetRotation;
      }
      rotation = deps.normalizeRadians(rotation) * state.mixRotate;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      bone.a = cos * a - sin * c;
      bone.b = cos * b - sin * d;
      bone.c = sin * a + cos * c;
      bone.d = sin * b + cos * d;
    }
  }
  for (const boneName of constraint.bones) deps.updateDescendantBoneTrees(boneName, poses, children, constrainedBones);
}

function samplePathConstraint(
  runtime: SpinePathConstraintRuntime,
  constraint: PathConstraintData,
  frames: unknown[] | undefined,
  time: number,
  duration: number,
  loop: boolean,
  out: { position: number; spacing: number; mixRotate: number; mixX: number; mixY: number },
): { position: number; spacing: number; mixRotate: number; mixX: number; mixY: number } {
  const sampler = runtime.timelineSamplerState;
  out.position = sampleCompiledTimeline(frames ?? [], time, 'position', constraint.position, duration, loop, sampler);
  out.spacing = sampleCompiledTimeline(frames ?? [], time, 'spacing', constraint.spacing, duration, loop, sampler);
  out.mixRotate = sampleCompiledTimeline(frames ?? [], time, 'mixRotate', constraint.mixRotate, duration, loop, sampler);
  out.mixX = sampleCompiledTimeline(frames ?? [], time, 'mixX', constraint.mixX, duration, loop, sampler);
  out.mixY = sampleCompiledTimeline(frames ?? [], time, 'mixY', constraint.mixY, duration, loop, sampler);
  return out;
}

function getBoneWorldLength(bone: BonePose): number {
  return Math.hypot(bone.data.length * bone.a, bone.data.length * bone.c);
}

function computePathPoints(
  runtime: SpinePathConstraintRuntime,
  poses: Map<string, BonePose>,
  slotBone: BonePose,
  attachment: RegionAttachment,
  out: number[],
): number[] {
  const data = runtime.data;
  const vertices = attachment.vertices ?? [];
  const vertexCount = attachment.vertices ? attachment.vertexCount ?? inferWeightedVertexCount(vertices) : 0;
  out.length = 0;
  if (vertexCount > 0 && vertices.length !== vertexCount * 2) {
    let offset = 0;
    for (let vertex = 0; vertex < vertexCount && offset < vertices.length; vertex++) {
      const boneCount = vertices[offset++] ?? 0;
      let x = 0;
      let y = 0;
      for (let influence = 0; influence < boneCount; influence++) {
        const boneIndex = vertices[offset++] ?? -1;
        const vx = vertices[offset++] ?? 0;
        const vy = vertices[offset++] ?? 0;
        const weight = vertices[offset++] ?? 0;
        const boneName = data.bones[boneIndex]?.name;
        const bone = boneName ? poses.get(boneName) : null;
        if (!bone) continue;
        x += (bone.a * vx + bone.b * vy + bone.worldX) * weight;
        y += (bone.c * vx + bone.d * vy + bone.worldY) * weight;
      }
      out.push(x, y);
    }
    return out;
  }
  for (let i = 0; i < vertices.length - 1; i += 2) {
    out.push(
      slotBone.a * requiredNumberAt(vertices, i, 'path vertices')
        + slotBone.b * requiredNumberAt(vertices, i + 1, 'path vertices') + slotBone.worldX,
      slotBone.c * requiredNumberAt(vertices, i, 'path vertices')
        + slotBone.d * requiredNumberAt(vertices, i + 1, 'path vertices') + slotBone.worldY,
    );
  }
  return out;
}

function computePathWorldPositions(
  runtime: SpinePathConstraintRuntime,
  poses: Map<string, BonePose>,
  slotBone: BonePose,
  attachment: RegionAttachment,
  constraint: PathConstraintData,
  position: number,
  spaces: number[],
  tangents: boolean,
): number[] {
  const vertexCount = attachment.vertexCount ?? inferWeightedVertexCount(attachment.vertices ?? []);
  const world = computePathPoints(runtime, poses, slotBone, attachment, runtime.pathWorldScratch);
  const spacesCount = spaces.length;
  const out = runtime.pathOutScratch;
  out.length = spacesCount * 3 + 2;
  for (let i = 0; i < out.length; i++) out[i] = 0;
  if (world.length < 8) return out;
  const closed = attachment.closed ?? false;
  let verticesLength = vertexCount * 2;
  let curveCount = verticesLength / 6;

  if (!attachment.constantSpeed) {
    const lengths = attachment.lengths ?? [];
    curveCount -= closed ? 1 : 2;
    const pathLength = lengths[curveCount] ?? lengths[lengths.length - 1] ?? 0;
    if (constraint.positionMode === 'percent') position *= pathLength;
    const multiplier = constraint.spacingMode === 'percent'
      ? pathLength
      : constraint.spacingMode === 'proportional'
        ? pathLength / spacesCount
        : 1;
    let curve = 0;
    let previousCurve = -4;
    const curveWorld = runtime.pathCurveWorldScratch;
    for (let i = 0, o = 0; i < spacesCount; i++, o += 3) {
      position += requiredNumberAt(spaces, i, 'path spaces') * multiplier;
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
        curve = 0;
      } else if (p < 0) {
        addBeforePathPosition(p, world, 2, out, o);
        continue;
      } else if (p > pathLength) {
        addAfterPathPosition(p - pathLength, world, verticesLength - 6, out, o);
        continue;
      }
      for (;; curve++) {
        const length = lengths[curve] ?? pathLength;
        if (p > length) continue;
        const previousLength = curve === 0 ? 0 : requiredNumberAt(lengths, curve - 1, 'path attachment lengths');
        p = curve === 0 ? p / length : (p - previousLength) / (length - previousLength);
        break;
      }
      if (curve !== previousCurve) {
        previousCurve = curve;
        curveWorld.length = 0;
        if (closed && curve === curveCount) {
          appendArrayRange(curveWorld, world, verticesLength - 4, verticesLength);
          appendArrayRange(curveWorld, world, 0, 4);
        } else {
          appendArrayRange(curveWorld, world, curve * 6 + 2, curve * 6 + 10);
        }
      }
      addCurvePathPosition(
        p,
        curveWorld,
        out,
        o,
        tangents || (i > 0 && requiredNumberAt(spaces, i, 'path spaces') === 0),
      );
    }
    return out;
  }

  const pathWorld = runtime.pathCurveWorldScratch;
  pathWorld.length = 0;
  if (closed) {
    verticesLength += 2;
    appendArrayRange(pathWorld, world, 2, verticesLength - 2);
    appendArrayRange(pathWorld, world, 0, 2);
    pathWorld.push(
      requiredNumberAt(pathWorld, 0, 'closed path world points'),
      requiredNumberAt(pathWorld, 1, 'closed path world points'),
    );
  } else {
    curveCount--;
    verticesLength -= 4;
    appendArrayRange(pathWorld, world, 2, 2 + verticesLength);
  }
  const curves = runtime.pathCurvesScratch;
  curves.length = curveCount;
  let pathLength = 0;
  let x1 = requiredNumberAt(pathWorld, 0, 'path world points');
  let y1 = requiredNumberAt(pathWorld, 1, 'path world points');
  let cx1 = 0;
  let cy1 = 0;
  let cx2 = 0;
  let cy2 = 0;
  let x2 = 0;
  let y2 = 0;
  let tmpx = 0;
  let tmpy = 0;
  let dddfx = 0;
  let dddfy = 0;
  let ddfx = 0;
  let ddfy = 0;
  let dfx = 0;
  let dfy = 0;
  for (let i = 0, w = 2; i < curveCount; i++, w += 6) {
    cx1 = requiredNumberAt(pathWorld, w, 'path world points');
    cy1 = requiredNumberAt(pathWorld, w + 1, 'path world points');
    cx2 = requiredNumberAt(pathWorld, w + 2, 'path world points');
    cy2 = requiredNumberAt(pathWorld, w + 3, 'path world points');
    x2 = requiredNumberAt(pathWorld, w + 4, 'path world points');
    y2 = requiredNumberAt(pathWorld, w + 5, 'path world points');
    tmpx = (x1 - cx1 * 2 + cx2) * 0.1875;
    tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
    dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375;
    dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
    ddfx = tmpx * 2 + dddfx;
    ddfy = tmpy * 2 + dddfy;
    dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667;
    dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
    pathLength += Math.hypot(dfx, dfy);
    dfx += ddfx;
    dfy += ddfy;
    ddfx += dddfx;
    ddfy += dddfy;
    pathLength += Math.hypot(dfx, dfy);
    dfx += ddfx;
    dfy += ddfy;
    pathLength += Math.hypot(dfx, dfy);
    dfx += ddfx + dddfx;
    dfy += ddfy + dddfy;
    pathLength += Math.hypot(dfx, dfy);
    curves[i] = pathLength;
    x1 = x2;
    y1 = y2;
  }
  if (constraint.positionMode === 'percent') position *= pathLength;
  const multiplier = constraint.spacingMode === 'percent'
    ? pathLength
    : constraint.spacingMode === 'proportional'
      ? pathLength / spacesCount
      : 1;

  const segments = runtime.pathSegmentsScratch;
  segments.length = 10;
  let curveLength = 0;
  let previousCurve = -1;
  let segment = 0;
  for (let i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3) {
    const space = requiredNumberAt(spaces, i, 'path spaces') * multiplier;
    position += space;
    let p = position;
    if (closed) {
      p %= pathLength;
      if (p < 0) p += pathLength;
      curve = 0;
      segment = 0;
    } else if (p < 0) {
      addBeforePathPosition(p, pathWorld, 0, out, o);
      continue;
    } else if (p > pathLength) {
      addAfterPathPosition(p - pathLength, pathWorld, pathWorld.length - 4, out, o);
      continue;
    }
    for (;; curve++) {
      const length = requiredNumberAt(curves, curve, 'path curve lengths');
      if (p > length) continue;
      const previousLength = curve === 0 ? 0 : requiredNumberAt(curves, curve - 1, 'path curve lengths');
      p = curve === 0 ? p / length : (p - previousLength) / (length - previousLength);
      break;
    }
    if (curve !== previousCurve) {
      previousCurve = curve;
      const w = curve * 6;
      x1 = requiredNumberAt(pathWorld, w, 'path world points');
      y1 = requiredNumberAt(pathWorld, w + 1, 'path world points');
      cx1 = requiredNumberAt(pathWorld, w + 2, 'path world points');
      cy1 = requiredNumberAt(pathWorld, w + 3, 'path world points');
      cx2 = requiredNumberAt(pathWorld, w + 4, 'path world points');
      cy2 = requiredNumberAt(pathWorld, w + 5, 'path world points');
      x2 = requiredNumberAt(pathWorld, w + 6, 'path world points');
      y2 = requiredNumberAt(pathWorld, w + 7, 'path world points');
      tmpx = (x1 - cx1 * 2 + cx2) * 0.03;
      tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
      dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006;
      dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
      ddfx = tmpx * 2 + dddfx;
      ddfy = tmpy * 2 + dddfy;
      dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667;
      dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
      curveLength = Math.hypot(dfx, dfy);
      segments[0] = curveLength;
      for (let ii = 1; ii < 8; ii++) {
        dfx += ddfx;
        dfy += ddfy;
        ddfx += dddfx;
        ddfy += dddfy;
        curveLength += Math.hypot(dfx, dfy);
        segments[ii] = curveLength;
      }
      dfx += ddfx;
      dfy += ddfy;
      curveLength += Math.hypot(dfx, dfy);
      segments[8] = curveLength;
      dfx += ddfx + dddfx;
      dfy += ddfy + dddfy;
      curveLength += Math.hypot(dfx, dfy);
      segments[9] = curveLength;
      segment = 0;
    }

    p *= curveLength;
    for (;; segment++) {
      const length = requiredNumberAt(segments, segment, 'path segments');
      if (p > length) continue;
      if (segment === 0) p = length === 0 ? 0 : p / length;
      else {
        const previous = requiredNumberAt(segments, segment - 1, 'path segments');
        p = length === previous ? segment : segment + (p - previous) / (length - previous);
      }
      break;
    }
    const curvePoint = runtime.pathCurvePointScratch;
    curvePoint[0] = x1;
    curvePoint[1] = y1;
    curvePoint[2] = cx1;
    curvePoint[3] = cy1;
    curvePoint[4] = cx2;
    curvePoint[5] = cy2;
    curvePoint[6] = x2;
    curvePoint[7] = y2;
    addCurvePathPosition(p * 0.1, curvePoint, out, o, tangents || (i > 0 && space === 0));
  }
  return out;
}

function appendArrayRange(out: number[], source: number[], start: number, end: number): void {
  for (let i = start; i < end && i < source.length; i++) {
    out.push(requiredNumberAt(source, i, 'path source range'));
  }
}

function inferWeightedVertexCount(vertices: number[]): number {
  let count = 0;
  let offset = 0;
  while (offset < vertices.length) {
    const boneCount = vertices[offset++] ?? 0;
    offset += boneCount * 4;
    count++;
  }
  return count;
}

function addBeforePathPosition(p: number, points: number[], index: number, out: number[], outIndex: number): void {
  const x1 = requiredNumberAt(points, index, 'path points');
  const y1 = requiredNumberAt(points, index + 1, 'path points');
  const dx = requiredNumberAt(points, index + 2, 'path points') - x1;
  const dy = requiredNumberAt(points, index + 3, 'path points') - y1;
  const r = Math.atan2(dy, dx);
  out[outIndex] = x1 + p * Math.cos(r);
  out[outIndex + 1] = y1 + p * Math.sin(r);
  out[outIndex + 2] = r;
}

function addAfterPathPosition(p: number, points: number[], index: number, out: number[], outIndex: number): void {
  const x1 = requiredNumberAt(points, index + 2, 'path points');
  const y1 = requiredNumberAt(points, index + 3, 'path points');
  const dx = x1 - requiredNumberAt(points, index, 'path points');
  const dy = y1 - requiredNumberAt(points, index + 1, 'path points');
  const r = Math.atan2(dy, dx);
  out[outIndex] = x1 + p * Math.cos(r);
  out[outIndex + 1] = y1 + p * Math.sin(r);
  out[outIndex + 2] = r;
}

function addCurvePathPosition(p: number, points: number[], out: number[], outIndex: number, tangents: boolean): void {
  const x1 = requiredNumberAt(points, 0, 'Bezier path points');
  const y1 = requiredNumberAt(points, 1, 'Bezier path points');
  const cx1 = requiredNumberAt(points, 2, 'Bezier path points');
  const cy1 = requiredNumberAt(points, 3, 'Bezier path points');
  const cx2 = requiredNumberAt(points, 4, 'Bezier path points');
  const cy2 = requiredNumberAt(points, 5, 'Bezier path points');
  const x2 = requiredNumberAt(points, 6, 'Bezier path points');
  const y2 = requiredNumberAt(points, 7, 'Bezier path points');
  if (p === 0 || Number.isNaN(p)) {
    out[outIndex] = x1;
    out[outIndex + 1] = y1;
    out[outIndex + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    return;
  }
  const tt = p * p;
  const ttt = tt * p;
  const u = 1 - p;
  const uu = u * u;
  const uuu = uu * u;
  const ut = u * p;
  const ut3 = ut * 3;
  const uut3 = u * ut3;
  const utt3 = ut3 * p;
  const x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt;
  const y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
  out[outIndex] = x;
  out[outIndex + 1] = y;
  if (tangents) {
    if (p < 0.001) out[outIndex + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    else out[outIndex + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
  }
}
