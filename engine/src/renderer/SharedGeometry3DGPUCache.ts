import { Geometry3D } from '../geometry/Geometry3D';
import type { GPUResourceTracker } from '../core/GPUResourceTracker';
import { writeBuffer as wrtBuf, writeBufferAligned } from './utils';
import type { LiveIdSet } from './utils';
import { sharedZeroVectorCache } from './ZeroVectorCache';
import { alignUp4 } from '../utils/align';

export interface SharedGeometry3DGPUData {
  positionBuf: GPUBuffer;
  normalBuf: GPUBuffer;
  uvBuf: GPUBuffer;
  uv1Buf: GPUBuffer | null;
  indexBuf: GPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  version: number;
}

interface CacheEntry extends SharedGeometry3DGPUData {
  owners: Set<object>;
}

const caches = new WeakMap<GPUDevice, SharedGeometry3DGPUCache>();

export function getSharedGeometry3DGPUCache(device: GPUDevice, tracker?: GPUResourceTracker): SharedGeometry3DGPUCache {
  let cache = caches.get(device);
  if (!cache) {
    cache = new SharedGeometry3DGPUCache(device, tracker);
    caches.set(device, cache);
  } else if (tracker) {
    cache.setTracker(tracker);
  }
  return cache;
}

export function disposeSharedGeometry3DGPUCache(device: GPUDevice): void {
  const cache = caches.get(device);
  if (!cache) return;
  cache.dispose();
  caches.delete(device);
}

export class SharedGeometry3DGPUCache {
  private readonly _entries = new Map<number, CacheEntry>();
  private _ownerGeometryIds = new WeakMap<object, Set<number>>();

  constructor(private readonly _device: GPUDevice, private _tracker?: GPUResourceTracker) {}

  setTracker(tracker: GPUResourceTracker): void {
    this._tracker = tracker;
  }

  get size(): number {
    return this._entries.size;
  }

  getOwnerGeometryCount(owner: object): number {
    return this._ownerGeometryIds.get(owner)?.size ?? 0;
  }

  hasGeometry(geometryId: number): boolean {
    return this._entries.has(geometryId);
  }

  ensure(geometry: Geometry3D, owner: object): SharedGeometry3DGPUData {
    let entry = this._entries.get(geometry.id);
    if (!entry) {
      entry = this._createEntry(geometry);
      this._entries.set(geometry.id, entry);
    } else if (entry.version !== geometry.version) {
      this._replaceBuffers(entry, geometry);
    }
    this._addOwner(entry, geometry.id, owner);
    return entry;
  }

  release(geometryId: number, owner: object): void {
    const entry = this._entries.get(geometryId);
    if (!entry) return;
    if (!entry.owners.delete(owner)) return;
    this._removeOwnerGeometry(owner, geometryId);
    if (entry.owners.size === 0) {
      this._destroyEntry(entry);
      this._entries.delete(geometryId);
    }
  }

  releaseUnused(owner: object, liveGeometryIds: LiveIdSet): void {
    const ownerGeometryIds = this._ownerGeometryIds.get(owner);
    if (!ownerGeometryIds?.size) return;
    for (const geometryId of Array.from(ownerGeometryIds)) {
      if (!liveGeometryIds.has(geometryId)) this.release(geometryId, owner);
    }
  }

  releaseOwner(owner: object): void {
    const ownerGeometryIds = this._ownerGeometryIds.get(owner);
    if (!ownerGeometryIds?.size) return;
    for (const geometryId of Array.from(ownerGeometryIds)) this.release(geometryId, owner);
  }

  dispose(): void {
    for (const entry of this._entries.values()) this._destroyEntry(entry);
    this._entries.clear();
    this._ownerGeometryIds = new WeakMap<object, Set<number>>();
  }

  private _addOwner(entry: CacheEntry, geometryId: number, owner: object): void {
    if (!entry.owners.has(owner)) entry.owners.add(owner);
    let ownerGeometryIds = this._ownerGeometryIds.get(owner);
    if (!ownerGeometryIds) {
      ownerGeometryIds = new Set<number>();
      this._ownerGeometryIds.set(owner, ownerGeometryIds);
    }
    ownerGeometryIds.add(geometryId);
  }

  private _removeOwnerGeometry(owner: object, geometryId: number): void {
    const ownerGeometryIds = this._ownerGeometryIds.get(owner);
    if (!ownerGeometryIds) return;
    ownerGeometryIds.delete(geometryId);
    if (ownerGeometryIds.size === 0) this._ownerGeometryIds.delete(owner);
  }

  private _createEntry(geometry: Geometry3D): CacheEntry {
    const uv0 = geometry.getTextureCoordinatesForChannel(0);
    const uv1 = geometry.getTextureCoordinatesForChannel(1);
    const entry = {
      positionBuf: this._makeVertexBuffer(geometry.positions),
      normalBuf: this._makeVertexBuffer(geometry.normals ?? sharedZeroVectorCache.vec3(geometry.vertexCount)),
      uvBuf: this._makeVertexBuffer(uv0 ?? sharedZeroVectorCache.vec2(geometry.vertexCount)),
      uv1Buf: uv1 ? this._makeVertexBuffer(uv1) : null,
      indexBuf: this._makeIndexBuffer(geometry.indices),
      indexCount: geometry.indexCount,
      vertexCount: geometry.vertexCount,
      indexFormat: geometry.indices instanceof Uint32Array ? 'uint32' as GPUIndexFormat : 'uint16' as GPUIndexFormat,
      version: geometry.version,
      owners: new Set<object>(),
    };
    return entry;
  }

  private _replaceBuffers(entry: CacheEntry, geometry: Geometry3D): void {
    this._destroyBuffers(entry);
    const uv0 = geometry.getTextureCoordinatesForChannel(0);
    const uv1 = geometry.getTextureCoordinatesForChannel(1);
    entry.positionBuf = this._makeVertexBuffer(geometry.positions);
    entry.normalBuf = this._makeVertexBuffer(geometry.normals ?? sharedZeroVectorCache.vec3(geometry.vertexCount));
    entry.uvBuf = this._makeVertexBuffer(uv0 ?? sharedZeroVectorCache.vec2(geometry.vertexCount));
    entry.uv1Buf = uv1 ? this._makeVertexBuffer(uv1) : null;
    entry.indexBuf = this._makeIndexBuffer(geometry.indices);
    entry.indexCount = geometry.indexCount;
    entry.vertexCount = geometry.vertexCount;
    entry.indexFormat = geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16';
    entry.version = geometry.version;
  }

  private _makeVertexBuffer(data: Float32Array): GPUBuffer {
    const size = Math.max(4, alignUp4(data.byteLength));
    const buffer = this._device.createBuffer({
      size,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._tracker?.trackBuffer(buffer, 'SharedGeometry3DGPUCache.vertexBuffer', size);
    if (data.byteLength > 0) wrtBuf(this._device.queue, buffer, 0, data);
    return buffer;
  }

  private _makeIndexBuffer(indices: Uint16Array | Uint32Array | null): GPUBuffer | null {
    if (!indices || indices.length === 0) return null;
    const size = alignUp4(indices.byteLength);
    const buffer = this._device.createBuffer({
      size,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this._tracker?.trackBuffer(buffer, 'SharedGeometry3DGPUCache.indexBuffer', size);
    writeBufferAligned(this._device.queue, buffer, 0, indices);
    return buffer;
  }

  private _destroyEntry(entry: CacheEntry): void {
    this._destroyBuffers(entry);
    entry.owners.clear();
  }

  private _destroyBuffers(entry: SharedGeometry3DGPUData): void {
    this._tracker?.untrackBuffer(entry.positionBuf);
    this._tracker?.untrackBuffer(entry.normalBuf);
    this._tracker?.untrackBuffer(entry.uvBuf);
    if (entry.uv1Buf) this._tracker?.untrackBuffer(entry.uv1Buf);
    if (entry.indexBuf) this._tracker?.untrackBuffer(entry.indexBuf);
    entry.positionBuf.destroy();
    entry.normalBuf.destroy();
    entry.uvBuf.destroy();
    entry.uv1Buf?.destroy();
    entry.indexBuf?.destroy();
  }
}
