import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { LiveIdSet } from './utils';
import { RendererObjectSlotCache } from './RendererCacheMap';
import { RendererObjectTable, type RendererObjectTableOptions } from './RendererObjectTable';
import {
  getSharedGeometry3DGPUCache,
  type SharedGeometry3DGPUCache,
  type SharedGeometry3DGPUData,
} from './SharedGeometry3DGPUCache';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { GPUResourceTracker } from '../core/GPUResourceTracker';
import { RendererCacheMap } from './RendererCacheMap';
import { encodeShaderPipelineKey } from './pipelineKey';

export interface RendererGeometryOwner<TGeometry> {
  ensure(geometry: Geometry3D): TGeometry;
  releaseNotIn(liveGeometryIds: LiveIdSet): void;
  destroy(): void;
}

export interface RendererObjectTablePairOptions extends Omit<RendererObjectTableOptions, 'label'> {
  label: string;
  batch?: boolean;
}

export interface ParameterizedRendererCoreOptions<TObject extends { modelSlot: number }, TGeometry> {
  objectTables?: RendererObjectTablePairOptions;
  createObject?: (modelSlot: number) => TObject;
  geometry: RendererGeometryOwner<TGeometry>;
}

/**
 * Owns the renderer state that must obey the same view, slot and geometry
 * lifecycle regardless of the concrete shader/material/pass policy.
 *
 * This is deliberately a composed owner rather than a renderer base class:
 * concrete renderers keep their shader family, packing and pipeline policy.
 */
export class ParameterizedRendererCore<TObject extends { modelSlot: number }, TGeometry> {
  readonly objectTable: RendererObjectTable | null;
  readonly batchObjectTable: RendererObjectTable | null;
  readonly objects: RendererObjectSlotCache<TObject> | null;
  readonly geometry: RendererGeometryOwner<TGeometry>;

  private _uploadsPrepared = false;
  private _destroyed = false;
  private readonly abortController = new AbortController();

  constructor(options: ParameterizedRendererCoreOptions<TObject, TGeometry>) {
    this.geometry = options.geometry;
    if (!options.objectTables) {
      this.objectTable = null;
      this.batchObjectTable = null;
      this.objects = null;
      return;
    }

    if (!options.createObject) {
      throw new TypeError('ParameterizedRendererCore object tables require an object factory.');
    }

    const { label, batch = true, ...tableOptions } = options.objectTables;
    this.objectTable = new RendererObjectTable({ ...tableOptions, label: `${label}.objectTable` });
    this.objectTable.ensureCapacity(1);
    this.batchObjectTable = batch
      ? new RendererObjectTable({ ...tableOptions, label: `${label}.batchObjectTable` })
      : null;
    this.batchObjectTable?.ensureCapacity(1);
    this.objects = new RendererObjectSlotCache(() => this.requireObjectTable(), options.createObject);
  }

  get uploadsPrepared(): boolean {
    return this._uploadsPrepared;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  beginUploads(context?: RenderCommandContext): void {
    this.assertAlive();
    this._uploadsPrepared = false;
    this.objectTable?.beginUploads(context);
    this.batchObjectTable?.beginUploads(context);
  }

  tableForBatchSlot(batchSlot: number | undefined): RendererObjectTable {
    if (batchSlot === undefined) return this.requireObjectTable();
    if (!this.batchObjectTable) return this.requireObjectTable();
    return this.batchObjectTable;
  }

  flushUploads(): void {
    this.assertAlive();
    this.objectTable?.flushUploads();
    this.batchObjectTable?.flushUploads();
    this._uploadsPrepared = true;
  }

  endView(): void {
    this.assertAlive();
    if (!this._uploadsPrepared) this.flushUploads();
    this._uploadsPrepared = false;
  }

  releaseObjectsNotIn(liveObjectIds: LiveIdSet): void {
    this.objects?.releaseNotIn(liveObjectIds);
  }

  releaseGeometriesNotIn(liveGeometryIds: LiveIdSet): void {
    this.geometry.releaseNotIn(liveGeometryIds);
  }

  materialIdentity(material: { id: number }): number {
    if (!Number.isSafeInteger(material.id) || material.id < 0) {
      throw new RangeError('Renderer material identity must be a non-negative safe integer.');
    }
    return material.id;
  }

  pipelineKey(
    primitiveKey: string | number,
    shaderKey: string,
    ...specializations: readonly (string | number | boolean | null | undefined)[]
  ): string {
    const base = encodeShaderPipelineKey(primitiveKey, shaderKey);
    if (specializations.length === 0) return base;
    return `${base}|${specializations.map(value => value ?? '').join('|')}`;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.abortController.abort();
    this._uploadsPrepared = false;
    this.objects?.clear();
    this.geometry.destroy();
    this.objectTable?.destroy();
    this.batchObjectTable?.destroy();
  }

  requireObjectTable(): RendererObjectTable {
    if (!this.objectTable) throw new Error('ParameterizedRendererCore has no object table.');
    return this.objectTable;
  }

  requireBatchObjectTable(): RendererObjectTable {
    if (!this.batchObjectTable) throw new Error('ParameterizedRendererCore has no batch object table.');
    return this.batchObjectTable;
  }

  requireObjects(): RendererObjectSlotCache<TObject> {
    if (!this.objects) throw new Error('ParameterizedRendererCore has no object-slot cache.');
    return this.objects;
  }

  private assertAlive(): void {
    if (this._destroyed) throw new Error('ParameterizedRendererCore is destroyed.');
  }
}

export class SharedGeometryRendererOwner implements RendererGeometryOwner<SharedGeometry3DGPUData> {
  private readonly cache: SharedGeometry3DGPUCache;

  constructor(device: GPUDevice, private readonly owner: object, tracker?: GPUResourceTracker) {
    this.cache = getSharedGeometry3DGPUCache(device, tracker);
  }

  ensure(geometry: Geometry3D, _legacyOwner?: object): SharedGeometry3DGPUData {
    return this.cache.ensure(geometry, this.owner);
  }

  releaseNotIn(liveGeometryIds: LiveIdSet): void {
    this.cache.releaseUnused(this.owner, liveGeometryIds);
  }

  releaseUnused(_legacyOwner: object, liveGeometryIds: LiveIdSet): void {
    this.releaseNotIn(liveGeometryIds);
  }

  destroy(): void {
    this.cache.releaseOwner(this.owner);
  }

  releaseOwner(_legacyOwner?: object): void {
    this.destroy();
  }

  get ownerGeometryCount(): number {
    return this.cache.getOwnerGeometryCount(this.owner);
  }
}

export class RendererCacheGeometryOwner<TGeometry> implements RendererGeometryOwner<TGeometry> {
  private readonly cache: RendererCacheMap<TGeometry>;

  constructor(
    destroyGeometry: (geometry: TGeometry) => void,
    private readonly createGeometry: (geometry: Geometry3D) => TGeometry,
  ) {
    this.cache = new RendererCacheMap(destroyGeometry);
  }

  ensure(geometry: Geometry3D): TGeometry {
    return this.cache.ensure(geometry.id, () => this.createGeometry(geometry));
  }

  get(geometryId: number): TGeometry | undefined {
    return this.cache.get(geometryId);
  }

  set(geometryId: number, geometry: TGeometry): void {
    this.cache.set(geometryId, geometry);
  }

  release(geometryId: number): void {
    this.cache.release(geometryId);
  }

  releaseNotIn(liveGeometryIds: LiveIdSet): void {
    this.cache.releaseNotIn(liveGeometryIds);
  }

  destroy(): void {
    this.cache.clear();
  }
}
