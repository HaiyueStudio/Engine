import { Spine2DComponent } from './Spine2DComponent';
import { SpineFloatBuilder } from './SpineFloatBuilder';
import type { AtlasRegion } from './SpineAtlasParser';
import type { BonePose, RegionAttachment, SlotData, SpineData } from './SpineSkeletonRuntime';
import { requiredItemAt, requiredNumberAt } from '../utils/arrayAccess';

export interface SpineDrawBatch {
  blend: 'normal' | 'additive';
  page: string;
  firstVertex: number;
  vertexCount: number;
}

interface SpineVertex {
  x: number;
  y: number;
  u: number;
  v: number;
  color: [number, number, number, number];
}

export interface SpineSlotGeometryCache {
  key: string;
  signature: number;
  debugSignature: number;
  vertices: Float32Array;
  vertexLength: number;
  vertexCapacity: number;
  debugVertices: Float32Array;
  debugVertexLength: number;
  debugVertexCapacity: number;
  batch: Omit<SpineDrawBatch, 'firstVertex'>;
  vertexOffset: number;
  debugVertexOffset: number;
}

export interface SpineVertexRuntime {
  data: SpineData;
  pages: Map<string, { width: number; height: number }>;
  vertexBuilder: SpineFloatBuilder;
  debugVertexBuilder: SpineFloatBuilder;
  meshPointBuilder: SpineFloatBuilder;
  batches: SpineDrawBatch[];
  batchPool: SpineDrawBatch[];
  allocationStats?: { batchPoolMisses: number };
  vertexColorScratch: [number, number, number, number];
}

export const HASH_OFFSET = 2166136261;
const HASH_PRIME = 16777619;

export function createEmptySlotCache(key: string): SpineSlotGeometryCache {
  return {
    key,
    signature: 0,
    debugSignature: 0,
    vertices: new Float32Array(0),
    vertexLength: 0,
    vertexCapacity: 0,
    debugVertices: new Float32Array(0),
    debugVertexLength: 0,
    debugVertexCapacity: 0,
    batch: { blend: 'normal', page: '', vertexCount: 0 },
    vertexOffset: -1,
    debugVertexOffset: -1,
  };
}

export function copyBuilderData(builder: SpineFloatBuilder, target: Float32Array): Float32Array {
  let output = target;
  if (output.length < builder.length) {
    output = new Float32Array(builder.length);
  }
  for (let index = 0; index < builder.length; index++) output[index] = builder.data[index] ?? 0;
  return output;
}

export function hasInvalidOffsets(entries: SpineSlotGeometryCache[]): boolean {
  let vertexOffset = 0;
  let debugOffset = 0;
  for (const entry of entries) {
    if (entry.vertexOffset !== vertexOffset || entry.debugVertexOffset !== debugOffset) return true;
    vertexOffset += entry.vertexCapacity;
    debugOffset += entry.debugVertexLength;
  }
  return false;
}

export function rebuildCachedGeometryLayout(runtime: SpineVertexRuntime, entries: SpineSlotGeometryCache[]): void {
  const vertices = runtime.vertexBuilder;
  const debugVertices = runtime.debugVertexBuilder;
  vertices.clear();
  debugVertices.clear();
  for (const entry of entries) {
    entry.vertexOffset = vertices.length;
    entry.debugVertexOffset = debugVertices.length;
    if (entry.vertexLength > 0) {
      vertices.reserveLength(vertices.length + entry.vertexCapacity);
      for (let index = 0; index < entry.vertexLength; index++) {
        vertices.data[entry.vertexOffset + index] = entry.vertices[index] ?? 0;
      }
    } else if (entry.vertexCapacity > 0) {
      vertices.reserveLength(vertices.length + entry.vertexCapacity);
    }
    if (entry.debugVertexLength > 0) {
      debugVertices.reserveLength(debugVertices.length + entry.debugVertexLength);
      for (let index = 0; index < entry.debugVertexLength; index++) {
        debugVertices.data[entry.debugVertexOffset + index] = entry.debugVertices[index] ?? 0;
      }
    }
  }
}

export function rebuildCachedDrawBatches(runtime: SpineVertexRuntime, entries: SpineSlotGeometryCache[]): void {
  const batches = runtime.batches;
  batches.length = 0;
  for (const entry of entries) {
    if (entry.vertexLength <= 0 || entry.batch.vertexCount <= 0) continue;
    appendBatch(
      batches,
      runtime.batchPool,
      runtime.allocationStats,
      entry.batch.blend,
      entry.batch.page,
      entry.vertexOffset / 8,
      entry.batch.vertexCount,
    );
  }
}

export function getSlotOrderHash(entries: SpineSlotGeometryCache[]): number {
  let hash = HASH_OFFSET;
  for (const entry of entries) {
    hash = hashString(hash, entry.key);
    hash = hashInt(hash, entry.vertexCapacity);
    hash = hashInt(hash, entry.debugVertexLength);
  }
  return hash;
}

export function getSlotBuildSignature(
  slot: SlotData,
  attachmentName: string,
  attachment: RegionAttachment,
  regionName: string,
  region: AtlasRegion,
  bone: BonePose,
  poses: Map<string, BonePose>,
  slotColor: [number, number, number, number] | undefined,
  clip: { endSlot?: string; polygon: Array<[number, number]> } | null,
  component: Spine2DComponent,
): number {
  let hash = HASH_OFFSET;
  hash = hashString(hash, slot.name);
  hash = hashString(hash, attachmentName);
  hash = hashString(hash, attachment.type ?? '');
  hash = hashString(hash, regionName);
  hash = hashString(hash, region.page);
  hash = hashString(hash, normalizeBlend(slot.blend));
  hash = hashInt(hash, quantizeSignatureNumber(component.scale));
  hash = hashColor(hash, slotColor);
  hash = hashClip(hash, clip);
  return attachment.type === 'mesh' ? hashAllPoses(hash, poses) : hashPose(hash, bone);
}

export function getDebugBonesSignature(scale: number, poses: Map<string, BonePose>): number {
  let hash = hashString(HASH_OFFSET, 'debugBones');
  hash = hashInt(hash, quantizeSignatureNumber(scale));
  return hashAllPoses(hash, poses);
}

export function hashInt(hash: number, value: number): number {
  let input = value | 0;
  for (let i = 0; i < 4; i++) {
    hash ^= input & 0xff;
    hash = Math.imul(hash, HASH_PRIME) >>> 0;
    input >>= 8;
  }
  return hash;
}

export function normalizeBlend(blend: string): 'normal' | 'additive' {
  return blend === 'additive' ? 'additive' : 'normal';
}

export function computeClipPolygon(bone: BonePose, attachment: RegionAttachment, scale: number): Array<[number, number]> {
  const vertices = attachment.vertices ?? [];
  const polygon: Array<[number, number]> = [];
  for (let i = 0; i < vertices.length - 1; i += 2) {
    polygon.push(transformBonePoint(
      bone,
      requiredNumberAt(vertices, i, 'clip attachment vertices'),
      requiredNumberAt(vertices, i + 1, 'clip attachment vertices'),
      scale,
    ));
  }
  return signedPolygonArea(polygon) < 0 ? polygon.slice().reverse() : polygon;
}

export function replaceClippedRange(floats: SpineFloatBuilder, start: number, polygon: Array<[number, number]>, clipped: SpineFloatBuilder): void {
  if (polygon.length < 3 || start >= floats.length) return;
  clipped.clear();
  for (let i = start; i < floats.length; i += 24) {
    const triangle: SpineVertex[] = [
      readVertex(floats, i),
      readVertex(floats, i + 8),
      readVertex(floats, i + 16),
    ];
    const clippedPolygon = clipVertexPolygon(triangle, polygon);
    for (let vertex = 1; vertex < clippedPolygon.length - 1; vertex++) {
      writeVertex(clipped, requiredItemAt(clippedPolygon, 0, 'clipped polygon'));
      writeVertex(clipped, requiredItemAt(clippedPolygon, vertex, 'clipped polygon'));
      writeVertex(clipped, requiredItemAt(clippedPolygon, vertex + 1, 'clipped polygon'));
    }
  }
  floats.truncate(start);
  floats.appendArray(clipped.data, clipped.length);
}

export function appendRegionVertices(
  out: SpineFloatBuilder,
  component: Spine2DComponent,
  runtime: SpineVertexRuntime,
  bone: BonePose,
  slotColor: [number, number, number, number] | undefined,
  attachment: RegionAttachment,
  region: AtlasRegion,
): void {
  const w = attachment.width || region.originalWidth || region.width;
  const h = attachment.height || region.originalHeight || region.height;
  const sx = attachment.scaleX ?? 1;
  const sy = attachment.scaleY ?? 1;
  const rad = (attachment.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = w * 0.5;
  const halfH = h * 0.5;
  const tx = attachment.x ?? 0;
  const ty = attachment.y ?? 0;
  const scale = component.scale;
  const x0 = -halfW * sx; const y0 = -halfH * sy;
  const x1 = halfW * sx; const y1 = halfH * sy;
  const rx0 = x0 * cos - y0 * sin + tx; const ry0 = x0 * sin + y0 * cos + ty;
  const rx1 = x1 * cos - y0 * sin + tx; const ry1 = x1 * sin + y0 * cos + ty;
  const rx2 = x1 * cos - y1 * sin + tx; const ry2 = x1 * sin + y1 * cos + ty;
  const rx3 = x0 * cos - y1 * sin + tx; const ry3 = x0 * sin + y1 * cos + ty;
  const px0 = (bone.a * rx0 + bone.b * ry0 + bone.worldX) * scale;
  const py0 = (bone.c * rx0 + bone.d * ry0 + bone.worldY) * scale;
  const px1 = (bone.a * rx1 + bone.b * ry1 + bone.worldX) * scale;
  const py1 = (bone.c * rx1 + bone.d * ry1 + bone.worldY) * scale;
  const px2 = (bone.a * rx2 + bone.b * ry2 + bone.worldX) * scale;
  const py2 = (bone.c * rx2 + bone.d * ry2 + bone.worldY) * scale;
  const px3 = (bone.a * rx3 + bone.b * ry3 + bone.worldX) * scale;
  const py3 = (bone.c * rx3 + bone.d * ry3 + bone.worldY) * scale;
  const page = runtime.pages.get(region.page);
  const pageWidth = page?.width ?? 1;
  const pageHeight = page?.height ?? 1;
  const packedWidth = region.rotate === 90 ? region.height : region.width;
  const packedHeight = region.rotate === 90 ? region.width : region.height;
  const u0 = region.x / pageWidth; const v0 = region.y / pageHeight;
  const u1 = (region.x + packedWidth) / pageWidth; const v1 = (region.y + packedHeight) / pageHeight;
  const color = multiplyColor(slotColor, attachment.color, runtime.vertexColorScratch);
  if (region.rotate === 90) {
    pushVertex(out, px0, py0, u1, v1, color); pushVertex(out, px1, py1, u1, v0, color);
    pushVertex(out, px2, py2, u0, v0, color); pushVertex(out, px0, py0, u1, v1, color);
    pushVertex(out, px2, py2, u0, v0, color); pushVertex(out, px3, py3, u0, v1, color);
  } else {
    pushVertex(out, px0, py0, u0, v1, color); pushVertex(out, px1, py1, u1, v1, color);
    pushVertex(out, px2, py2, u1, v0, color); pushVertex(out, px0, py0, u0, v1, color);
    pushVertex(out, px2, py2, u1, v0, color); pushVertex(out, px3, py3, u0, v0, color);
  }
}

export function appendMeshVertices(
  out: SpineFloatBuilder,
  component: Spine2DComponent,
  runtime: SpineVertexRuntime,
  data: SpineData,
  poses: Map<string, BonePose>,
  bone: BonePose,
  slotColor: [number, number, number, number] | undefined,
  attachment: RegionAttachment,
  region: AtlasRegion,
): void {
  const points = computeMeshPoints(data, poses, bone, attachment, component.scale, runtime.meshPointBuilder);
  const triangles = attachment.triangles ?? [];
  const color = multiplyColor(slotColor, attachment.color, runtime.vertexColorScratch);
  for (let i = 0; i < triangles.length - 2; i += 3) {
    const a = triangles[i] ?? -1;
    const b = triangles[i + 1] ?? -1;
    const c = triangles[i + 2] ?? -1;
    if (!hasMeshPoint(points, a) || !hasMeshPoint(points, b) || !hasMeshPoint(points, c)) continue;
    appendMeshVertex(out, points, region, runtime, attachment, a, color);
    appendMeshVertex(out, points, region, runtime, attachment, b, color);
    appendMeshVertex(out, points, region, runtime, attachment, c, color);
  }
}

export function appendMeshWireframe(
  out: SpineFloatBuilder,
  component: Spine2DComponent,
  runtime: SpineVertexRuntime,
  data: SpineData,
  poses: Map<string, BonePose>,
  bone: BonePose,
  attachment: RegionAttachment,
): void {
  const points = computeMeshPoints(data, poses, bone, attachment, component.scale, runtime.meshPointBuilder);
  const triangles = attachment.triangles ?? [];
  const seen = new Set<string>();
  for (let i = 0; i < triangles.length - 2; i += 3) {
    appendMeshDebugEdge(out, points, triangles[i] ?? -1, triangles[i + 1] ?? -1, seen, [0.3, 0.85, 1, 0.8]);
    appendMeshDebugEdge(out, points, triangles[i + 1] ?? -1, triangles[i + 2] ?? -1, seen, [0.3, 0.85, 1, 0.8]);
    appendMeshDebugEdge(out, points, triangles[i + 2] ?? -1, triangles[i] ?? -1, seen, [0.3, 0.85, 1, 0.8]);
  }
}

export function appendRegionWireframe(
  out: SpineFloatBuilder,
  component: Spine2DComponent,
  bone: BonePose,
  attachment: RegionAttachment,
  region: AtlasRegion,
): void {
  const w = attachment.width || region.originalWidth || region.width;
  const h = attachment.height || region.originalHeight || region.height;
  const sx = attachment.scaleX ?? 1;
  const sy = attachment.scaleY ?? 1;
  const rad = (attachment.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const localCorners: Array<[number, number]> = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const points = localCorners.map(([x, y]) => {
    const lx = x * sx;
    const ly = y * sy;
    const rx = lx * cos - ly * sin + (attachment.x ?? 0);
    const ry = lx * sin + ly * cos + (attachment.y ?? 0);
    return transformBonePoint(bone, rx, ry, component.scale);
  });
  const seen = new Set<string>();
  appendDebugEdge(out, points, 0, 1, seen, [0.3, 0.85, 1, 0.8]);
  appendDebugEdge(out, points, 1, 2, seen, [0.3, 0.85, 1, 0.8]);
  appendDebugEdge(out, points, 2, 3, seen, [0.3, 0.85, 1, 0.8]);
  appendDebugEdge(out, points, 3, 0, seen, [0.3, 0.85, 1, 0.8]);
}

export function appendBoneDebug(out: SpineFloatBuilder, data: SpineData, poses: Map<string, BonePose>, scale: number): void {
  for (const boneData of data.bones) {
    const bone = poses.get(boneData.name);
    if (!bone) continue;
    const start: [number, number] = [bone.worldX * scale, bone.worldY * scale];
    const end = boneData.length > 0
      ? [(bone.worldX + bone.a * boneData.length) * scale, (bone.worldY + bone.c * boneData.length) * scale] as [number, number]
      : boneData.parent && poses.get(boneData.parent)
        ? [poses.get(boneData.parent)!.worldX * scale, poses.get(boneData.parent)!.worldY * scale] as [number, number]
        : start;
    appendDebugLine(out, start, end, [1, 0.85, 0.25, 0.95]);
    const joint = 3 / Math.max(0.001, scale);
    appendDebugLine(out, transformBonePoint(bone, -joint, 0, scale), transformBonePoint(bone, joint, 0, scale), [1, 0.35, 0.3, 0.95]);
    appendDebugLine(out, transformBonePoint(bone, 0, -joint, scale), transformBonePoint(bone, 0, joint, scale), [1, 0.35, 0.3, 0.95]);
  }
}

function hashPose(hash: number, pose: BonePose): number {
  hash = hashInt(hash, quantizeSignatureNumber(pose.a));
  hash = hashInt(hash, quantizeSignatureNumber(pose.b));
  hash = hashInt(hash, quantizeSignatureNumber(pose.c));
  hash = hashInt(hash, quantizeSignatureNumber(pose.d));
  hash = hashInt(hash, quantizeSignatureNumber(pose.worldX));
  hash = hashInt(hash, quantizeSignatureNumber(pose.worldY));
  return hash;
}

function hashAllPoses(hash: number, poses: Map<string, BonePose>): number {
  for (const [name, pose] of poses) {
    hash = hashString(hash, name);
    hash = hashPose(hash, pose);
  }
  return hash;
}

function hashColor(hash: number, color: [number, number, number, number] | undefined): number {
  if (!color) return hashInt(hash, 0);
  hash = hashInt(hash, 1);
  hash = hashInt(hash, quantizeSignatureNumber(color[0]));
  hash = hashInt(hash, quantizeSignatureNumber(color[1]));
  hash = hashInt(hash, quantizeSignatureNumber(color[2]));
  return hashInt(hash, quantizeSignatureNumber(color[3]));
}

function hashClip(hash: number, clip: { endSlot?: string; polygon: Array<[number, number]> } | null): number {
  if (!clip) return hashInt(hash, 0);
  hash = hashInt(hash, 1);
  hash = hashString(hash, clip.endSlot ?? '');
  for (const point of clip.polygon) {
    hash = hashInt(hash, quantizeSignatureNumber(point[0]));
    hash = hashInt(hash, quantizeSignatureNumber(point[1]));
  }
  return hash;
}

function quantizeSignatureNumber(value: number): number {
  return Math.round(value * 10000);
}

function hashString(hash: number, value: string): number {
  for (let i = 0; i < value.length; i++) hash = hashInt(hash, value.charCodeAt(i));
  return hash;
}

function appendBatch(
  batches: SpineDrawBatch[],
  pool: SpineDrawBatch[],
  runtimeAllocationStats: { batchPoolMisses: number } | undefined,
  blend: 'normal' | 'additive',
  page: string,
  firstVertex: number,
  vertexCount: number,
): void {
  const last = batches[batches.length - 1];
  if (last && last.blend === blend && last.page === page && last.firstVertex + last.vertexCount === firstVertex) {
    last.vertexCount += vertexCount;
    return;
  }
  const index = batches.length;
  let batch = pool[index];
  if (!batch) {
    batch = { blend, page, firstVertex, vertexCount };
    pool.push(batch);
    if (runtimeAllocationStats) runtimeAllocationStats.batchPoolMisses++;
  } else {
    batch.blend = blend;
    batch.page = page;
    batch.firstVertex = firstVertex;
    batch.vertexCount = vertexCount;
  }
  batches.push(batch);
}

function transformBonePoint(bone: BonePose, x: number, y: number, scale: number): [number, number] {
  return [
    (bone.a * x + bone.b * y + bone.worldX) * scale,
    (bone.c * x + bone.d * y + bone.worldY) * scale,
  ];
}

function computeMeshPoints(
  data: SpineData,
  poses: Map<string, BonePose>,
  slotBone: BonePose,
  attachment: RegionAttachment,
  scale: number,
  out: SpineFloatBuilder,
): SpineFloatBuilder {
  const vertices = attachment.vertices ?? [];
  const vertexCount = Math.floor((attachment.uvs?.length ?? 0) / 2);
  out.clear();
  if (vertices.length === vertexCount * 2) {
    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i] ?? 0;
      const y = vertices[i + 1] ?? 0;
      out.push(
        (slotBone.a * x + slotBone.b * y + slotBone.worldX) * scale,
        (slotBone.c * x + slotBone.d * y + slotBone.worldY) * scale,
      );
    }
    return out;
  }

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
    out.push(x * scale, y * scale);
  }
  return out;
}

function hasMeshPoint(points: SpineFloatBuilder, vertexIndex: number): boolean {
  return vertexIndex >= 0 && vertexIndex * 2 + 1 < points.length;
}

function appendMeshVertex(
  out: SpineFloatBuilder,
  points: SpineFloatBuilder,
  region: AtlasRegion,
  runtime: SpineVertexRuntime,
  attachment: RegionAttachment,
  vertexIndex: number,
  color: [number, number, number, number],
): void {
  const rawU = attachment.uvs?.[vertexIndex * 2] ?? 0;
  const rawV = attachment.uvs?.[vertexIndex * 2 + 1] ?? 0;
  const page = runtime.pages.get(region.page);
  const textureWidth = page?.width ?? 1;
  const textureHeight = page?.height ?? 1;
  let u: number;
  let v: number;
  if (region.rotate === 90) {
    const baseU = region.x / textureWidth - (region.originalHeight - region.offsetY - region.height) / textureWidth;
    const baseV = region.y / textureHeight - (region.originalWidth - region.offsetX - region.width) / textureHeight;
    u = baseU + rawV * region.originalHeight / textureWidth;
    v = baseV + (1 - rawU) * region.originalWidth / textureHeight;
  } else if (region.rotate === 180) {
    const baseU = region.x / textureWidth - (region.originalWidth - region.offsetX - region.width) / textureWidth;
    const baseV = region.y / textureHeight - region.offsetY / textureHeight;
    u = baseU + (1 - rawU) * region.originalWidth / textureWidth;
    v = baseV + (1 - rawV) * region.originalHeight / textureHeight;
  } else if (region.rotate === 270) {
    const baseU = region.x / textureWidth - region.offsetY / textureWidth;
    const baseV = region.y / textureHeight - region.offsetX / textureHeight;
    u = baseU + (1 - rawV) * region.originalHeight / textureWidth;
    v = baseV + rawU * region.originalWidth / textureHeight;
  } else {
    const baseU = region.x / textureWidth - region.offsetX / textureWidth;
    const baseV = region.y / textureHeight - (region.originalHeight - region.offsetY - region.height) / textureHeight;
    u = baseU + rawU * region.originalWidth / textureWidth;
    v = baseV + rawV * region.originalHeight / textureHeight;
  }
  const pointOffset = vertexIndex * 2;
  pushVertex(out, points.get(pointOffset), points.get(pointOffset + 1), u, v, color);
}

function appendDebugEdge(
  out: SpineFloatBuilder,
  points: Array<[number, number]>,
  a: number,
  b: number,
  seen: Set<string>,
  color: [number, number, number, number],
): void {
  if (!points[a] || !points[b]) return;
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  if (seen.has(key)) return;
  seen.add(key);
  appendDebugLine(out, points[a], points[b], color);
}

function appendMeshDebugEdge(
  out: SpineFloatBuilder,
  points: SpineFloatBuilder,
  a: number,
  b: number,
  seen: Set<string>,
  color: [number, number, number, number],
): void {
  if (!hasMeshPoint(points, a) || !hasMeshPoint(points, b)) return;
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  if (seen.has(key)) return;
  seen.add(key);
  const aOffset = a * 2;
  const bOffset = b * 2;
  out.push(
    points.get(aOffset),
    points.get(aOffset + 1),
    0,
    0,
    ...color,
    points.get(bOffset),
    points.get(bOffset + 1),
    0,
    0,
    ...color,
  );
}

function appendDebugLine(out: SpineFloatBuilder, a: [number, number], b: [number, number], color: [number, number, number, number]): void {
  out.push(a[0], a[1], 0, 0, ...color, b[0], b[1], 0, 0, ...color);
}

function multiplyColor(
  a: [number, number, number, number] | undefined,
  b: [number, number, number, number] | undefined,
  out: [number, number, number, number],
): [number, number, number, number] {
  out[0] = (a?.[0] ?? 1) * (b?.[0] ?? 1);
  out[1] = (a?.[1] ?? 1) * (b?.[1] ?? 1);
  out[2] = (a?.[2] ?? 1) * (b?.[2] ?? 1);
  out[3] = (a?.[3] ?? 1) * (b?.[3] ?? 1);
  return out;
}

function pushVertex(
  out: SpineFloatBuilder,
  x: number,
  y: number,
  u: number,
  v: number,
  color: [number, number, number, number],
): void {
  out.push8(x, y, u, v, color[0], color[1], color[2], color[3]);
}

function signedPolygonArea(polygon: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = requiredItemAt(polygon, i, 'clip polygon');
    const b = requiredItemAt(polygon, (i + 1) % polygon.length, 'clip polygon');
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function clipVertexPolygon(vertices: SpineVertex[], clipPolygon: Array<[number, number]>): SpineVertex[] {
  let output = vertices;
  for (let i = 0; i < clipPolygon.length; i++) {
    const a = requiredItemAt(clipPolygon, i, 'clip polygon');
    const b = requiredItemAt(clipPolygon, (i + 1) % clipPolygon.length, 'clip polygon');
    const input = output;
    output = [];
    if (input.length === 0) break;
    let previous = requiredItemAt(input, input.length - 1, 'clip input polygon');
    let previousInside = isInsideClipEdge(previous, a, b);
    for (const current of input) {
      const currentInside = isInsideClipEdge(current, a, b);
      if (currentInside !== previousInside) output.push(intersectClipEdge(previous, current, a, b));
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
  }
  return output;
}

function isInsideClipEdge(vertex: SpineVertex, a: [number, number], b: [number, number]): boolean {
  return (b[0] - a[0]) * (vertex.y - a[1]) - (b[1] - a[1]) * (vertex.x - a[0]) >= -0.0001;
}

function intersectClipEdge(start: SpineVertex, end: SpineVertex, a: [number, number], b: [number, number]): SpineVertex {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const edgeX = b[0] - a[0];
  const edgeY = b[1] - a[1];
  const denominator = edgeX * dy - edgeY * dx;
  const t = Math.abs(denominator) < 0.000001
    ? 0
    : (edgeY * (start.x - a[0]) - edgeX * (start.y - a[1])) / denominator;
  const clamped = Math.max(0, Math.min(1, t));
  return lerpVertex(start, end, clamped);
}

function lerpVertex(start: SpineVertex, end: SpineVertex, t: number): SpineVertex {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    u: start.u + (end.u - start.u) * t,
    v: start.v + (end.v - start.v) * t,
    color: [
      start.color[0] + (end.color[0] - start.color[0]) * t,
      start.color[1] + (end.color[1] - start.color[1]) * t,
      start.color[2] + (end.color[2] - start.color[2]) * t,
      start.color[3] + (end.color[3] - start.color[3]) * t,
    ],
  };
}

function readVertex(floats: SpineFloatBuilder, index: number): SpineVertex {
  return {
    x: floats.get(index),
    y: floats.get(index + 1),
    u: floats.get(index + 2),
    v: floats.get(index + 3),
    color: [floats.get(index + 4), floats.get(index + 5), floats.get(index + 6), floats.get(index + 7)],
  };
}

function writeVertex(out: SpineFloatBuilder, vertex: SpineVertex): void {
  out.push(vertex.x, vertex.y, vertex.u, vertex.v, ...vertex.color);
}
