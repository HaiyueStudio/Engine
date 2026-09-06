import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { isEntityDisabledInHierarchyCached, sweepEntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { DirectionalLight } from '../lighting/DirectionalLight';
import { EnvironmentLight } from '../lighting/EnvironmentLight';
import { Fog } from '../lighting/Fog';
import { LightComponent } from '../lighting/LightComponent';
import { PointLight } from '../lighting/PointLight';
import { SceneLightSelection, createLightInfo, lightEnergy, type SceneLightCandidate, type SceneLightSelectionStats } from './SceneLightSelection';
import { getSceneFrameUniformSnapshotMetadata, type SceneFrameUniformSnapshot } from './SceneFrameUniformLayout';
import type { FrameData } from './FrameData';

export { SCENE_RENDER_MAX_LIGHTS, SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS, type PbrLightInfo } from './SceneLightData';
import { SCENE_RENDER_MAX_LIGHTS, SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS, type PbrLightInfo } from './SceneLightData';
const FOG_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([Fog]) });
const IMAGE_BASED_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([EnvironmentLight]) });
const LIGHT_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([LightComponent]) });
let lightingRevisionSequence = 0;

/** Phase-local snapshot. Consumers must not retain it across FrameData phase changes. */
export interface SceneRenderEnvironment {
  readonly frameId: number;
  readonly phaseRevision: number;
  /** Changes only when GPU-visible PBR light or image-based environment data changes. */
  readonly lightingRevision: number;
  readonly fog: Fog | null;
  readonly environmentLight: EnvironmentLight | null;
  /** Compatibility alias for the first entry in shadowLights. */
  readonly shadowLight: DirectionalLight | null;
  /** Shadow-casting directional lights, ordered first in pbrLights with matching indices. */
  readonly shadowLights: readonly DirectionalLight[];
  readonly pbrLights: readonly PbrLightInfo[];
  /** Per-view admission diagnostics; overflow counts relevant lights excluded by the fixed budget. */
  readonly lightSelection?: SceneLightSelectionStats;
}

const services = new WeakMap<FrameData, SceneRenderEnvironmentFrameService>();

/** Internal frame service shared by every renderer recording the same World frame. */
export function getSceneRenderEnvironment(frameData: FrameData, world: World, view?: SceneFrameUniformSnapshot): SceneRenderEnvironment {
  let service = services.get(frameData);
  if (!service) {
    service = new SceneRenderEnvironmentFrameService();
    services.set(frameData, service);
  }
  const scene = service.get(frameData, world);
  return view ? service.getView(frameData, world, scene, view) : scene;
}

class SceneRenderEnvironmentFrameService {
  private _world: World | null = null;
  private _frameId = 0;
  private _phaseRevision = 0;
  private _snapshot: SceneRenderEnvironment | null = null;
  private readonly _snapshotRing: SceneRenderEnvironmentSlot[] = Array.from(
    { length: 3 },
    createSceneRenderEnvironmentSlot,
  );
  private _snapshotRevision = 0;
  private _lightingRevision = 0;
  private _lightingSignatureLength = 0;
  private readonly _lightingSignature = new Float64Array(128);
  private readonly _lightingSignatureScratch = new Float64Array(128);
  private readonly _resourceIds = new WeakMap<object, number>();
  private _nextResourceId = 1;
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _candidatePool: SceneLightCandidate[] = [];
  private readonly _candidates: SceneLightCandidate[] = [];
  private readonly _shadowCandidates: SceneLightCandidate[] = [];
  private readonly _selection = new SceneLightSelection();
  private readonly _views = new WeakMap<object, SceneRenderEnvironmentFrameService>();
  private readonly _colorScratch = new Float32Array(4);

  get(frameData: FrameData, world: World): SceneRenderEnvironment {
    if (
      this._snapshot
      && this._world === world
      && this._frameId === frameData.frameId
      && this._phaseRevision === frameData.phaseRevision
    ) return this._snapshot;

    this._world = world;
    this._frameId = frameData.frameId;
    this._phaseRevision = frameData.phaseRevision;
    this._candidates.length = 0;
    this._shadowCandidates.length = 0;
    this._snapshotRevision = this._snapshotRevision >= Number.MAX_SAFE_INTEGER ? 1 : this._snapshotRevision + 1;
    const slot = this._snapshotRing[(this._snapshotRevision - 1) % this._snapshotRing.length]!;
    const pbrLights = slot.pbrLights;
    pbrLights.length = 0;
    const shadowLights = slot.shadowLights;
    shadowLights.length = 0;

    let fog: Fog | null = null;
    let environmentLight: EnvironmentLight | null = null;

    for (const entity of world.iterQueryCandidates(FOG_ENVIRONMENT_QUERY)) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const candidate = entity.getComponent(Fog);
      if (candidate && !candidate.disabled) {
        fog = candidate;
        break;
      }
    }
    for (const entity of world.iterQueryCandidates(IMAGE_BASED_ENVIRONMENT_QUERY)) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const candidate = entity.getComponent(EnvironmentLight);
      if (candidate && !candidate.disabled) {
        environmentLight = candidate;
        break;
      }
    }
    for (const entity of world.iterQueryCandidates(LIGHT_ENVIRONMENT_QUERY)) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const light = entity.getComponent(LightComponent);
      if (!light || light.disabled) continue;
      const index = this._candidates.length;
      let candidate = this._candidatePool[index];
      if (!candidate || candidate.id !== entity.id) {
        candidate = { id: entity.id, info: createLightInfo(), shadow: null };
        this._candidatePool[index] = candidate;
      }
      this._writeLightInfo(candidate.info, entity, light, frameData);
      candidate.shadow = light instanceof DirectionalLight && light.castShadow ? light : null;
      this._candidates.push(candidate);
      if (candidate.shadow && lightEnergy(candidate.info) > 0) this._shadowCandidates.push(candidate);
    }
    this._candidatePool.length = this._candidates.length;
    const previousShadows = this._snapshot?.shadowLights;
    this._shadowCandidates.sort((a, b) => {
      const aScore = lightEnergy(a.info) * (previousShadows?.includes(a.shadow!) ? 1.1 : 1);
      const bScore = lightEnergy(b.info) * (previousShadows?.includes(b.shadow!) ? 1.1 : 1);
      return bScore - aScore || a.id - b.id;
    });
    this._shadowCandidates.length = Math.min(this._shadowCandidates.length, SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS);
    this._shadowCandidates.sort((a, b) => a.id - b.id);
    for (const candidate of this._shadowCandidates) shadowLights.push(candidate.shadow!);
    slot.snapshot.lightSelection = this._selection.select(this._candidates, shadowLights, pbrLights, slot.lightPool);

    sweepEntityHierarchyDisabledCache(this._disabledHierarchyCache, world.entities);
    this._updateLightingRevision(pbrLights, environmentLight);
    slot.snapshot.frameId = frameData.frameId;
    slot.snapshot.phaseRevision = frameData.phaseRevision;
    slot.snapshot.lightingRevision = this._lightingRevision;
    slot.snapshot.fog = fog;
    slot.snapshot.environmentLight = environmentLight;
    slot.snapshot.shadowLight = shadowLights[0] ?? null;
    this._snapshot = slot.snapshot;
    return slot.snapshot;
  }

  getView(frameData: FrameData, world: World, scene: SceneRenderEnvironment, view: SceneFrameUniformSnapshot): SceneRenderEnvironment {
    const stream = getSceneFrameUniformSnapshotMetadata(view)?.stream ?? view;
    let state = this._views.get(stream);
    if (!state) { state = new SceneRenderEnvironmentFrameService(); this._views.set(stream, state); }
    if (state._world === world && state._frameId === frameData.frameId
      && state._phaseRevision === frameData.phaseRevision && state._snapshot) return state._snapshot;
    state._world = world; state._frameId = frameData.frameId; state._phaseRevision = frameData.phaseRevision;
    const slot = state._snapshotRing[state._snapshotRevision++ % state._snapshotRing.length]!;
    slot.shadowLights.length = 0;
    slot.shadowLights.push(...scene.shadowLights);
    slot.snapshot.lightSelection = state._selection.select(this._candidates, scene.shadowLights, slot.pbrLights, slot.lightPool, view);
    state._updateLightingRevision(slot.pbrLights, scene.environmentLight);
    slot.snapshot.frameId = scene.frameId;
    slot.snapshot.phaseRevision = scene.phaseRevision;
    slot.snapshot.lightingRevision = state._lightingRevision;
    slot.snapshot.fog = scene.fog;
    slot.snapshot.environmentLight = scene.environmentLight;
    slot.snapshot.shadowLight = scene.shadowLight;
    state._snapshot = slot.snapshot;
    return slot.snapshot;
  }

  private _writeLightInfo(info: PbrLightInfo, entity: Entity, light: LightComponent, frameData: FrameData): void {
    light.color.writeLinear(this._colorScratch, 0);
    info.type = light.lightType === 'ambient' ? 0 : light.lightType === 'directional' ? 1 : 2;
    info.color[0] = this._colorScratch[0]!;
    info.color[1] = this._colorScratch[1]!;
    info.color[2] = this._colorScratch[2]!;
    info.intensity = light.intensity;
    info.direction[0] = 0;
    info.direction[1] = -1;
    info.direction[2] = 0;
    info.position[0] = 0;
    info.position[1] = 0;
    info.position[2] = 0;
    info.range = 10;
    if (light instanceof DirectionalLight) {
      info.direction[0] = light.direction[0];
      info.direction[1] = light.direction[1];
      info.direction[2] = light.direction[2];
    }
    if (light instanceof PointLight) {
      info.range = light.range;
      const worldMatrix = frameData.transforms.getWorldMatrix(entity);
      info.position[0] = worldMatrix[12]!;
      info.position[1] = worldMatrix[13]!;
      info.position[2] = worldMatrix[14]!;
    }
  }

  private _updateLightingRevision(lights: readonly PbrLightInfo[], environment: EnvironmentLight | null): void {
    const signature = this._lightingSignatureScratch;
    let cursor = 0;
    signature[cursor++] = lights.length;
    for (const light of lights) {
      signature[cursor++] = light.type;
      signature[cursor++] = light.color[0];
      signature[cursor++] = light.color[1];
      signature[cursor++] = light.color[2];
      signature[cursor++] = light.intensity;
      signature[cursor++] = light.direction[0];
      signature[cursor++] = light.direction[1];
      signature[cursor++] = light.direction[2];
      signature[cursor++] = light.position[0];
      signature[cursor++] = light.position[1];
      signature[cursor++] = light.position[2];
      signature[cursor++] = light.range;
    }
    signature[cursor++] = environment ? 1 : 0;
    if (environment) {
      signature[cursor++] = environment.intensity;
      signature[cursor++] = environment.rotation;
      environment.diffuseColor.writeLinear(this._colorScratch, 0);
      for (let index = 0; index < 4; index++) signature[cursor++] = this._colorScratch[index]!;
      environment.specularColor.writeLinear(this._colorScratch, 0);
      for (let index = 0; index < 4; index++) signature[cursor++] = this._colorScratch[index]!;
      cursor = this._writeEnvironmentTextureSignature(signature, cursor, environment.diffuseTexture);
      cursor = this._writeEnvironmentTextureSignature(signature, cursor, environment.specularTexture);
    }
    let changed = cursor !== this._lightingSignatureLength;
    if (!changed) {
      for (let index = 0; index < cursor; index++) {
        if (!Object.is(signature[index], this._lightingSignature[index])) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this._lightingSignature.set(signature.subarray(0, cursor), 0);
    this._lightingSignatureLength = cursor;
    lightingRevisionSequence = nextRevision(lightingRevisionSequence);
    this._lightingRevision = lightingRevisionSequence;
  }

  private _writeEnvironmentTextureSignature(
    signature: Float64Array,
    cursor: number,
    source: EnvironmentLight['diffuseTexture'],
  ): number {
    signature[cursor++] = this._getResourceId(source);
    signature[cursor++] = source && 'texture' in source && typeof source.version === 'number' ? source.version : 0;
    signature[cursor++] = source && 'texture' in source && typeof source.mipLevelCount === 'number'
      ? source.mipLevelCount
      : 1;
    return cursor;
  }

  private _getResourceId(value: unknown): number {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return 0;
    const object = value as object;
    let id = this._resourceIds.get(object);
    if (id !== undefined) return id;
    id = this._nextResourceId++;
    this._resourceIds.set(object, id);
    return id;
  }
}

type MutableSceneRenderEnvironment = {
  -readonly [K in keyof SceneRenderEnvironment]: SceneRenderEnvironment[K];
};

interface SceneRenderEnvironmentSlot {
  readonly snapshot: MutableSceneRenderEnvironment;
  readonly pbrLights: PbrLightInfo[];
  readonly shadowLights: DirectionalLight[];
  readonly lightPool: PbrLightInfo[];
}

function createSceneRenderEnvironmentSlot(): SceneRenderEnvironmentSlot {
  const pbrLights: PbrLightInfo[] = [];
  const shadowLights: DirectionalLight[] = [];
  return {
    snapshot: {
      frameId: 0,
      phaseRevision: 0,
      lightingRevision: 0,
      fog: null,
      environmentLight: null,
      shadowLight: null,
      shadowLights,
      pbrLights,
    },
    pbrLights,
    shadowLights,
    lightPool: Array.from({ length: SCENE_RENDER_MAX_LIGHTS }, createLightInfo),
  };
}

function nextRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
