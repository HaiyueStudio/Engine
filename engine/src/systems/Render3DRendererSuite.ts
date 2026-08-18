import type { IEngine } from '../core/IEngine';
import { DepthRenderer } from '../renderer/DepthRenderer';
import { Mesh3DRenderer } from '../renderer/Mesh3DRenderer';
import { NormalRenderer } from '../renderer/NormalRenderer';
import { PbrRenderer } from '../renderer/PbrRenderer';
import { PlanarMirrorRenderer } from '../renderer/PlanarMirrorRenderer';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { ShadowMapRenderer } from '../renderer/ShadowMapRenderer';
import { VolumeRenderer } from '../renderer/VolumeRenderer';
import type { LiveIdSet } from '../renderer/utils';

export interface Render3DRendererCacheLiveness {
  basicEntities: LiveIdSet;
  basicGeometries: LiveIdSet;
  basicMaterials: LiveIdSet;
  depthEntities: LiveIdSet;
  depthGeometries: LiveIdSet;
  depthMaterials: LiveIdSet;
  normalEntities: LiveIdSet;
  normalGeometries: LiveIdSet;
  normalMaterials: LiveIdSet;
  volumeEntities: LiveIdSet;
  volumeGeometries: LiveIdSet;
  volumeMaterials: LiveIdSet;
  pbrEntities: LiveIdSet;
  pbrGeometries: LiveIdSet;
  pbrMaterials: LiveIdSet;
}

/**
 * Owns lazy renderer creation, device-loss teardown, and cache sweeping.
 *
 * Render3DSystem remains the frame orchestrator; individual renderer lifetime
 * and preparation rules are centralized here so optional renderers cannot
 * accumulate independent ownership paths in that orchestrator.
 */
export class Render3DRendererSuite {
  private _basic: Mesh3DRenderer | null = null;
  private _basicPrepared = false;
  private _depth: DepthRenderer | null = null;
  private _normal: NormalRenderer | null = null;
  private _volume: VolumeRenderer | null = null;
  private _planarMirror: PlanarMirrorRenderer | null = null;
  private _pbr: PbrRenderer | null = null;
  private _shadow: ShadowMapRenderer | null = null;

  constructor(private readonly engine: IEngine) {}

  get basic(): Mesh3DRenderer | null {
    return this._basic;
  }

  get pbr(): PbrRenderer | null {
    return this._pbr;
  }

  get depth(): DepthRenderer | null {
    return this._depth;
  }

  get normal(): NormalRenderer | null {
    return this._normal;
  }

  get volume(): VolumeRenderer | null {
    return this._volume;
  }

  get planarMirror(): PlanarMirrorRenderer | null {
    return this._planarMirror;
  }

  get shadow(): ShadowMapRenderer | null {
    return this._shadow;
  }

  setBasic(renderer: Mesh3DRenderer): void {
    this._basic = renderer;
    this._basicPrepared = false;
  }

  requireBasic(): Mesh3DRenderer {
    if (!this._basic) this._basic = new Mesh3DRenderer();
    if (!this._basicPrepared) {
      this._basic.prepare(this.engine);
      this._basicPrepared = true;
    }
    return this._basic;
  }

  requirePbr(): PbrRenderer {
    if (!this._pbr) {
      this._pbr = new PbrRenderer();
      this._pbr.prepare(this.engine);
    }
    return this._pbr;
  }

  requireShadow(): ShadowMapRenderer {
    if (!this._shadow) {
      this._shadow = new ShadowMapRenderer();
      this._shadow.prepare(this.engine);
    }
    return this._shadow;
  }

  requireDepth(): DepthRenderer {
    if (!this._depth) {
      this._depth = new DepthRenderer();
      this._depth.prepare(this.engine);
    }
    return this._depth;
  }

  requireNormal(): NormalRenderer {
    if (!this._normal) {
      this._normal = new NormalRenderer();
      this._normal.prepare(this.engine);
    }
    return this._normal;
  }

  requireVolume(): VolumeRenderer {
    if (!this._volume) {
      this._volume = new VolumeRenderer();
      this._volume.prepare(this.engine);
    }
    return this._volume;
  }

  requirePlanarMirror(): PlanarMirrorRenderer {
    if (!this._planarMirror) this._planarMirror = new PlanarMirrorRenderer();
    this._planarMirror.prepare(this.engine);
    return this._planarMirror;
  }

  destroyPlanarMirror(): void {
    this._planarMirror?.destroy();
    this._planarMirror = null;
  }

  contributePipelineWarmup(
    plan: PipelineWarmupPlan,
    reverseZ: boolean,
    msaaSamples: 1 | 4,
  ): void {
    const basic = this.requireBasic();
    basic.reverseZ = reverseZ;
    basic.msaaSamples = msaaSamples;
    basic.contributePipelineWarmup(plan);

    const pbr = this.requirePbr();
    pbr.reverseZ = reverseZ;
    pbr.msaaSamples = msaaSamples;
    pbr.contributePipelineWarmup(plan);

    this.requireShadow().contributePipelineWarmup(plan);

    const depth = this.requireDepth();
    depth.reverseZ = reverseZ;
    depth.msaaSamples = msaaSamples;
    depth.contributePipelineWarmup(plan);

    const normal = this.requireNormal();
    normal.reverseZ = reverseZ;
    normal.msaaSamples = msaaSamples;
    normal.contributePipelineWarmup(plan);

    const volume = this.requireVolume();
    volume.reverseZ = reverseZ;
    volume.msaaSamples = msaaSamples;
    volume.contributePipelineWarmup(plan);

    this.requirePlanarMirror().contributePipelineWarmup(plan);
  }

  releaseStaleCaches(live: Render3DRendererCacheLiveness): void {
    releaseRendererCaches(this._basic, live.basicEntities, live.basicGeometries, live.basicMaterials);
    releaseRendererCaches(this._depth, live.depthEntities, live.depthGeometries, live.depthMaterials);
    releaseRendererCaches(this._normal, live.normalEntities, live.normalGeometries, live.normalMaterials);
    releaseRendererCaches(this._volume, live.volumeEntities, live.volumeGeometries, live.volumeMaterials);
    releaseRendererCaches(this._pbr, live.pbrEntities, live.pbrGeometries, live.pbrMaterials);
  }

  suspendForDeviceLoss(): void {
    this._basic?.destroy();
    this._depth?.destroy();
    this._normal?.destroy();
    this._volume?.destroy();
    this._planarMirror?.destroy();
    this._pbr?.destroy();
    this._shadow?.destroy();
    this._basic = null;
    this._basicPrepared = false;
    this._depth = null;
    this._normal = null;
    this._volume = null;
    this._planarMirror = null;
    this._pbr = null;
    this._shadow = null;
  }
}

function releaseRendererCaches(
  renderer: {
    releaseEntitiesNotIn(live: LiveIdSet): void;
    releaseGeometriesNotIn(live: LiveIdSet): void;
    releaseMaterialsNotIn(live: LiveIdSet): void;
  } | null,
  entities: LiveIdSet,
  geometries: LiveIdSet,
  materials: LiveIdSet,
): void {
  renderer?.releaseEntitiesNotIn(entities);
  renderer?.releaseGeometriesNotIn(geometries);
  renderer?.releaseMaterialsNotIn(materials);
}
