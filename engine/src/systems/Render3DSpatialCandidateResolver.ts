import { Camera3D } from '../components/Camera3D';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { FrameData } from '../frame/FrameData';
import type { DirectionalLight } from '../lighting/DirectionalLight';
import { Frustum } from '../culling/Frustum';
import { writeDirectionalShadowViewProjection } from '../renderer/DirectionalShadowMath';
import { getSpatialIndexService, type MeshSpatialEntry } from '../spatial/SpatialIndexService';
import type { RenderViewSnapshot } from '../core/RenderView';
import { mat4 } from 'wgpu-matrix';
import {SceneFrameUniformLayout,type SceneFrameUniformSnapshot} from '../frame/SceneFrameUniformLayout';

const viewProjectionOffset=SceneFrameUniformLayout.fields.find(field=>field.name==='viewProjection')!.offset/4;
interface PlannedSpatialView {readonly sceneFrameUniforms:SceneFrameUniformSnapshot;}

export interface Render3DSpatialCandidateStats {
  readonly used: boolean;
  readonly queryCount: number;
  readonly shadowQueryCount: number;
  readonly candidateCount: number;
}

/**
 * Resolves the shared broad-phase entity set for all camera and shadow views.
 * It owns spatial query scratch data; Render3DSystem only consumes the result.
 */
export class Render3DSpatialCandidateResolver {
  private readonly _entries: MeshSpatialEntry[] = [];
  private readonly _entities = new Set<Entity>();
  private readonly _shadowFrustum = new Frustum();
  private readonly _viewFrustum = new Frustum();
  private readonly _shadowView = mat4.identity() as Float32Array;
  private readonly _shadowProjection = mat4.identity() as Float32Array;
  private readonly _shadowViewProjection = mat4.identity() as Float32Array;
  private readonly _stats = {
    used: false,
    queryCount: 0,
    shadowQueryCount: 0,
    candidateCount: 0,
  };

  constructor(
    private readonly _threshold: number,
    private readonly _leafSize: number,
  ) {}

  get stats(): Render3DSpatialCandidateStats { return this._stats; }

  resolve(
    world: World,
    frameData: FrameData,
    views: readonly RenderViewSnapshot[],
    entities: ReadonlySet<Entity>,
    shadowLights: readonly DirectionalLight[],
    fallbackCamera: Entity,
    frustumCulling: boolean,
    plannedViews?:ReadonlyMap<string,PlannedSpatialView>,
  ): ReadonlySet<Entity> {
    if (!frustumCulling || entities.size < this._threshold || frameData !== world.frameData) {
      this._setStats(false, 0, 0, entities.size);
      return entities;
    }

    const service = getSpatialIndexService(world);
    const index = service.syncMeshIndex(this._leafSize);
    const entries = this._entries;
    const candidates = this._entities;
    candidates.clear();
    let queryCount = 0;
    let shadowQueryCount = 0;

    for (const view of views) {
      const planned=plannedViews?.get(view.key)?.sceneFrameUniforms;
      let frustum:Frustum;
      if(planned){
        // Query the same immutable matrix that geometry will consume. Re-querying
        // FrameData here can change the aspect/jitter of an already planned view.
        frustum=this._viewFrustum.setFromViewProjection(planned.data.subarray(viewProjectionOffset,viewProjectionOffset+16));
      }else{
        const cameraEntity = view.camera.getComponent(Camera3D) ? view.camera : fallbackCamera;
        const camera = cameraEntity.getComponent(Camera3D);
        if (!camera) continue;
        frustum = frameData.getCamera3D(
          cameraEntity,
          camera,
          view.width,
          view.height,
          view.reverseZ,
        ).frustum;
      }
      entries.length = 0;
      index.queryFrustum(frustum, entries);
      addEntries(candidates, entries);
      queryCount++;
    }

    for (const shadowLight of shadowLights) {
      writeDirectionalShadowViewProjection(
        shadowLight,
        this._shadowViewProjection,
        this._shadowView,
        this._shadowProjection,
      );
      this._shadowFrustum.setFromViewProjection(this._shadowViewProjection);
      entries.length = 0;
      index.queryFrustum(this._shadowFrustum, entries);
      addEntries(candidates, entries);
      queryCount++;
      shadowQueryCount++;
    }

    entries.length = 0;
    if (queryCount === 0) {
      this._setStats(false, 0, 0, entities.size);
      return entities;
    }
    for (const entity of service.unboundedMeshEntities) candidates.add(entity);
    this._setStats(true, queryCount, shadowQueryCount, candidates.size);
    return candidates;
  }

  reset(): void {
    this._entries.length = 0;
    this._entities.clear();
    this._setStats(false, 0, 0, 0);
  }

  private _setStats(
    used: boolean,
    queryCount: number,
    shadowQueryCount: number,
    candidateCount: number,
  ): void {
    this._stats.used = used;
    this._stats.queryCount = queryCount;
    this._stats.shadowQueryCount = shadowQueryCount;
    this._stats.candidateCount = candidateCount;
  }
}

function addEntries(target: Set<Entity>, entries: readonly MeshSpatialEntry[]): void {
  for (const entry of entries) target.add(entry.entity);
}
