import { AssetJob, type AssetJobPriority, type AssetManager } from '@haiyue/engine/assets';
import { Entity, System, type World } from '@haiyue/engine';
import { GltfModelComponent } from './GltfModelComponent';
import { disposeGltfModel, loadGltfModel } from './gltfLoader';
import type { DracoDecoderConfig, DracoDecoderFactory, DracoDecoderModule, GltfAssetWorker, LoadedGltfModel } from './GltfLoaderContract';

export interface GltfModelSystemOptions {
  priority?: number;
  dracoDecoder?: DracoDecoderModule | Promise<DracoDecoderModule> | DracoDecoderFactory | null;
  dracoDecoderConfig?: DracoDecoderConfig;
  loadTimeoutMs?: number;
  assetManager?: AssetManager | null;
  assetWorker?: GltfAssetWorker | null;
  assetPriority?: AssetJobPriority | number;
}

interface PendingGltfLoad {
  key: string;
  job: AssetJob<LoadedGltfModel>;
}

export class GltfModelSystem extends System {
  private dracoDecoder: DracoDecoderModule | Promise<DracoDecoderModule> | DracoDecoderFactory | null;
  private dracoDecoderConfig: DracoDecoderConfig | undefined;
  private loadTimeoutMs: number;
  private assetManager: AssetManager | null;
  private assetWorker: GltfAssetWorker | null;
  private assetPriority: AssetJobPriority | number;
  private readonly componentModels = new Map<GltfModelComponent, Set<LoadedGltfModel>>();
  private readonly pendingLoads = new Map<GltfModelComponent, PendingGltfLoad>();
  private readonly failedLoads = new Map<GltfModelComponent, string>();
  private readonly liveComponents = new Set<GltfModelComponent>();

  constructor(options: GltfModelSystemOptions = {}) {
    super({ all: [GltfModelComponent] });
    this.name = 'GltfModelSystem';
    if (options.priority !== undefined) this.priority = options.priority;
    this.dracoDecoder = options.dracoDecoder ?? null;
    this.dracoDecoderConfig = options.dracoDecoderConfig;
    this.loadTimeoutMs = Math.max(0, options.loadTimeoutMs ?? 30000);
    this.assetManager = options.assetManager ?? null;
    this.assetWorker = options.assetWorker ?? null;
    this.assetPriority = options.assetPriority ?? 'normal';
  }

  override update(world: World, _time: number, _delta: number): this {
    this.liveComponents.clear();
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      const component = entity.getComponent(GltfModelComponent);
      if (!component) continue;
      this.liveComponents.add(component);
      if (!component.autoLoad || !component.src) continue;
      const key = component.sourceKey;
      if (component.runtimeSourceKey === key
        || component.loadingSourceKey === key
        || this.failedLoads.get(component) === key) continue;
      this.loadIntoEntity(entity, component, key);
    }
    this.releaseModelsNotIn(this.liveComponents);
    this.abortLoadsNotIn(this.liveComponents);
    this.releaseFailuresNotIn(this.liveComponents);
    return this;
  }

  override destroy(): this {
    for (const component of [...this.pendingLoads.keys()]) this.abortPendingLoad(component);
    this.disposeAllModels();
    this.failedLoads.clear();
    return super.destroy();
  }

  private async loadIntoEntity(entity: Entity, component: GltfModelComponent, key: string): Promise<void> {
    this.abortPendingLoad(component);
    component.status = 'loading';
    component.error = null;
    component.loadingSourceKey = key;
    this.failedLoads.delete(component);
    component.runtimeAnimations = [];
    component.runtimeAnimationClips = [];
    component.runtimeAssetStats = null;
    component.runtimeCompatibilityReport = null;
    component.runtimeMaterialVariants = [];
    const pending = this.createPendingLoad(component, key);
    try {
      const model = await pending.job.start(async context => {
        context.setPhase('parsing');
        return await loadGltfModel(component.src, {
          scene: component.scene,
          baseColorFactor: component.baseColorFactor,
          dracoDecoder: this.dracoDecoder,
          ...(this.dracoDecoderConfig === undefined ? {} : { dracoDecoderConfig: this.dracoDecoderConfig }),
          assetManager: this.assetManager,
          assetWorker: this.assetWorker,
          signal: context.signal,
        });
      });
      if (component.loadingSourceKey !== key) {
        disposeGltfModel(model);
        return;
      }
      if (component.clearPrevious) {
        if (component.runtimeRoot) entity.removeChild(component.runtimeRoot);
        this.disposeModelsForComponent(component);
      }
      model.root.name = `${entity.name || 'glTF'} Model`;
      entity.addChild(model.root);
      this.trackModel(component, model);
      component.runtimeRoot = model.root;
      component.runtimeAnimations = model.animations;
      component.runtimeAnimationClips = model.animationClips;
      component.runtimeAssetStats = model.assetStats;
      component.runtimeCompatibilityReport = model.compatibilityReport;
      component.runtimeMaterialVariants = model.materialVariants;
      component.runtimeSourceKey = key;
      this.failedLoads.delete(component);
      component.status = 'loaded';
    } catch (error) {
      const timedOut = String(pending.job.controller.signal.reason ?? '').startsWith('timeout:');
      if (component.loadingSourceKey !== key || (pending.job.controller.signal.aborted && !timedOut)) {
        if (component.loadingSourceKey === key) component.loadingSourceKey = '';
        return;
      }
      component.status = 'error';
      this.failedLoads.set(component, key);
      component.error = timedOut
        ? `glTF load timed out after ${this.loadTimeoutMs}ms.`
        : error instanceof Error ? error.message : String(error);
      console.warn(`[GltfModelSystem] ${component.error}`, error);
    } finally {
      this.clearPendingLoad(component, pending);
      if (component.loadingSourceKey === key) component.loadingSourceKey = '';
    }
  }

  private createPendingLoad(component: GltfModelComponent, key: string): PendingGltfLoad {
    const pending: PendingGltfLoad = {
      key,
      job: new AssetJob<LoadedGltfModel>(`gltf:${key}`, {
        timeoutMs: this.loadTimeoutMs,
        priority: this.assetPriority,
        disposeLateResult: disposeGltfModel,
      }),
    };
    this.pendingLoads.set(component, pending);
    return pending;
  }

  private clearPendingLoad(component: GltfModelComponent, pending: PendingGltfLoad): void {
    if (this.pendingLoads.get(component) === pending) this.pendingLoads.delete(component);
  }

  private abortPendingLoad(component: GltfModelComponent): void {
    const pending = this.pendingLoads.get(component);
    if (!pending) return;
    pending.job.abort('component-removed');
    this.pendingLoads.delete(component);
    if (component.loadingSourceKey === pending.key) component.loadingSourceKey = '';
  }

  private trackModel(component: GltfModelComponent, model: LoadedGltfModel): void {
    let models = this.componentModels.get(component);
    if (!models) {
      models = new Set();
      this.componentModels.set(component, models);
    }
    models.add(model);
  }

  private disposeModelsForComponent(component: GltfModelComponent): void {
    const models = this.componentModels.get(component);
    if (!models) return;
    for (const model of models) disposeGltfModel(model);
    models.clear();
    this.componentModels.delete(component);
  }

  private releaseModelsNotIn(liveComponents: ReadonlySet<GltfModelComponent>): void {
    for (const component of [...this.componentModels.keys()]) {
      if (!liveComponents.has(component)) {
        this.disposeModelsForComponent(component);
        component.runtimeRoot = null;
        component.runtimeAnimations = [];
        component.runtimeAnimationClips = [];
        component.runtimeAssetStats = null;
        component.runtimeCompatibilityReport = null;
        component.runtimeMaterialVariants = [];
        component.runtimeSourceKey = '';
      }
    }
  }

  private abortLoadsNotIn(liveComponents: ReadonlySet<GltfModelComponent>): void {
    for (const component of [...this.pendingLoads.keys()]) {
      if (!liveComponents.has(component)) this.abortPendingLoad(component);
    }
  }

  private releaseFailuresNotIn(liveComponents: ReadonlySet<GltfModelComponent>): void {
    for (const component of this.failedLoads.keys()) {
      if (!liveComponents.has(component)) this.failedLoads.delete(component);
    }
  }

  private disposeAllModels(): void {
    for (const component of [...this.componentModels.keys()]) this.disposeModelsForComponent(component);
  }
}
