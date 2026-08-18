import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { isEntityDisabledInHierarchyCached, sweepEntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { DirectionalLight } from '../lighting/DirectionalLight';
import { EnvironmentLight } from '../lighting/EnvironmentLight';
import { Fog } from '../lighting/Fog';
import { LightComponent } from '../lighting/LightComponent';
import { PointLight } from '../lighting/PointLight';
import { requiredItemAt } from '../math/arrayAccess';
import type { FrameData } from './FrameData';

export const SCENE_RENDER_MAX_LIGHTS = 8;
/** Fixed PBR shadow-map array capacity. Additional shadow-casting lights stay lit but unshadowed. */
export const SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS = 3;
const FOG_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([Fog]) });
const IMAGE_BASED_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([EnvironmentLight]) });
const LIGHT_ENVIRONMENT_QUERY = Object.freeze({ all: Object.freeze([LightComponent]) });
let lightingRevisionSequence = 0;

export interface PbrLightInfo {
  type: 0 | 1 | 2;
  color: [number, number, number];
  intensity: number;
  direction: [number, number, number];
  position: [number, number, number];
  range: number;
}

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
}

const services = new WeakMap<FrameData, SceneRenderEnvironmentFrameService>();

/** Internal frame service shared by every renderer recording the same World frame. */
export function getSceneRenderEnvironment(frameData: FrameData, world: World): SceneRenderEnvironment {
  let service = services.get(frameData);
  if (!service) {
    service = new SceneRenderEnvironmentFrameService();
    services.set(frameData, service);
  }
  return service.get(frameData, world);
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
  private readonly _lightEntities: Entity[] = [];
  private readonly _lightComponents: LightComponent[] = [];
  private readonly _shadowEntities: Entity[] = [];
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
    this._lightEntities.length = 0;
    this._lightComponents.length = 0;
    this._shadowEntities.length = 0;
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
      this._lightEntities.push(entity);
      this._lightComponents.push(light);
      if (
        shadowLights.length < SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS
        && light instanceof DirectionalLight
        && light.castShadow
      ) {
        shadowLights.push(light);
        this._shadowEntities.push(entity);
      }
    }

    let lightCursor = 0;
    for (let index = 0; index < this._shadowEntities.length; index++) {
      const shadowEntity = requiredItemAt(this._shadowEntities, index, 'scene render shadow entities');
      const shadowLight = requiredItemAt(shadowLights, index, 'scene render shadow lights');
      const info = slot.lightPool[lightCursor++]!;
      this._writeLightInfo(info, shadowEntity, shadowLight, frameData);
      pbrLights.push(info);
    }
    for (let i = 0; i < this._lightEntities.length && pbrLights.length < SCENE_RENDER_MAX_LIGHTS; i++) {
      const entity = requiredItemAt(this._lightEntities, i, 'scene render light entities');
      if (this._shadowEntities.includes(entity)) continue;
      const light = requiredItemAt(this._lightComponents, i, 'scene render light components');
      const info = slot.lightPool[lightCursor++]!;
      this._writeLightInfo(info, entity, light, frameData);
      pbrLights.push(info);
    }

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
    lightPool: Array.from({ length: SCENE_RENDER_MAX_LIGHTS }, () => ({
      type: 0,
      color: [0, 0, 0],
      intensity: 0,
      direction: [0, -1, 0],
      position: [0, 0, 0],
      range: 10,
    })),
  };
}

function nextRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
