import { Camera3D, Transform3D } from '@haiyue/engine/components';
import type { Entity, World } from '@haiyue/engine/ecs';
import { AmbientLight, DirectionalLight, EnvironmentLight, PointLight } from '@haiyue/engine/lighting';
import type { EnvironmentCubeTexture } from '@haiyue/engine/lighting';
import type { Scene } from '@haiyue/engine/scene';
import { mat4n } from 'wgpu-matrix';
import type { RayMatrix4, RayVec3 } from '../reference/index.js';
import { pathDiagnostic } from './diagnostics.js';
import type {
  RayPathCamera,
  RayPathDiagnostic,
  RayPathEnvironment,
  RayPathLight,
  RayPathSceneExtractionOptions,
  RayPathSceneExtractionResult,
  RayPathSceneFacts,
} from './types.js';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function extractRayPathSceneFacts(
  source: Scene | World,
  options: RayPathSceneExtractionOptions = {},
): RayPathSceneExtractionResult {
  const world = 'world' in source ? source.world : source;
  const diagnostics: RayPathDiagnostic[] = [];
  if (world.destroyed) {
    diagnostics.push(pathDiagnostic('extract', 'error', 'RAY_PATH_SOURCE_DESTROYED',
      'The source world is destroyed.', { worldId: world.id }));
    return freezeResult(null, diagnostics);
  }
  const matrices = new Map<number, RayMatrix4>();
  const resolving = new Set<number>();
  const entities = [...world.entities.values()].sort((a, b) => a.id - b.id);
  const cameraCandidates = entities.filter(entity => !isDisabled(entity) && entity.getComponent(Camera3D));
  const cameraEntity = options.cameraEntityId === undefined
    ? cameraCandidates[0]
    : cameraCandidates.find(entity => entity.id === options.cameraEntityId);
  if (!cameraEntity) {
    diagnostics.push(pathDiagnostic('extract', 'error', 'RAY_PATH_CAMERA_MISSING',
      'No enabled Camera3D matches the path renderer request.', { cameraEntityId: options.cameraEntityId ?? null }));
    return freezeResult(null, diagnostics);
  }
  const cameraComponent = cameraEntity.getComponent(Camera3D)!;
  const cameraMatrix = worldMatrix(cameraEntity, matrices, resolving, diagnostics);
  if (!cameraMatrix) return freezeResult(null, diagnostics);
  const camera = freezeCamera(cameraComponent, cameraEntity, cameraMatrix);

  const maxLights = options.maxLights ?? 8;
  const lights: RayPathLight[] = [];
  let environment: RayPathEnvironment = Object.freeze({
    color: vec3(0, 0, 0), intensity: 0, rotation: 0, texture: null, textureVersion: 0,
    revision: 'environment:none',
  });
  for (const entity of entities) {
    if (isDisabled(entity)) continue;
    const ambient = entity.getComponent(AmbientLight);
    const directional = entity.getComponent(DirectionalLight);
    const point = entity.getComponent(PointLight);
    const environmentLight = entity.getComponent(EnvironmentLight);
    if (ambient) lights.push(freezeLight(entity, ambient, 'ambient', null));
    if (directional) lights.push(freezeLight(entity, directional, 'directional', null));
    if (point) {
      const matrix = worldMatrix(entity, matrices, resolving, diagnostics);
      if (matrix) lights.push(freezeLight(entity, point, 'point', matrix));
    }
    if (environmentLight) {
      const resolved = freezeEnvironment(environmentLight, diagnostics);
      if (resolved) environment = resolved;
    }
  }
  if (lights.length > maxLights) diagnostics.push(pathDiagnostic('extract', 'error',
    'RAY_PATH_LIGHT_LIMIT_UNSUPPORTED', 'The path renderer light count exceeds its frozen uniform capacity.',
    { required: lights.length, limit: maxLights }));
  if (diagnostics.some(entry => entry.severity === 'error')) return freezeResult(null, diagnostics);
  const selectedLights = Object.freeze(lights.slice(0, maxLights).sort((a, b) => a.identity.localeCompare(b.identity)));
  const revision = fingerprint([
    'ray-path-facts-v1', camera.revision, environment.revision, ...selectedLights.map(light => light.revision),
    String(world.structureVersion), String(world.componentChangeRevision),
  ].join('|'));
  const facts: RayPathSceneFacts = Object.freeze({
    camera, lights: selectedLights, environment, revision, diagnostics: Object.freeze([...diagnostics]),
  });
  return freezeResult(facts, diagnostics);
}

function freezeCamera(camera: Camera3D, entity: Entity, matrix: RayMatrix4): RayPathCamera {
  const origin = vec3(matrix[12]!, matrix[13]!, matrix[14]!);
  const right = normalize(matrix[0]!, matrix[1]!, matrix[2]!);
  const up = normalize(matrix[4]!, matrix[5]!, matrix[6]!);
  const forward = normalize(-matrix[8]!, -matrix[9]!, -matrix[10]!);
  const verticalFov = camera.projectionType === 'perspective' ? camera.fov : 0;
  const orthographicHeight = camera.projectionType === 'orthographic' ? camera.orthoTop - camera.orthoBottom : 0;
  const revision = fingerprint([
    'camera', String(entity.id), camera.projectionType, verticalFov, orthographicHeight,
    camera.near, camera.far, ...matrix,
  ].join('|'));
  return Object.freeze({ projection: camera.projectionType, origin, right, up, forward,
    verticalFov, orthographicHeight, near: camera.near, far: camera.far, revision });
}

function freezeLight(
  entity: Entity,
  light: AmbientLight | DirectionalLight | PointLight,
  type: RayPathLight['type'],
  matrix: RayMatrix4 | null,
): RayPathLight {
  const rgba = light.color.writeLinear(new Float32Array(4));
  const color = vec3(rgba[0]!, rgba[1]!, rgba[2]!);
  const direction = light instanceof DirectionalLight
    ? normalize(light.direction[0], light.direction[1], light.direction[2]) : vec3(0, -1, 0);
  const position = matrix ? vec3(matrix[12]!, matrix[13]!, matrix[14]!) : vec3(0, 0, 0);
  const range = light instanceof PointLight ? light.range : 0;
  const identity = `light:${entity.id}:${type}`;
  const revision = fingerprint([identity, String(light.version), String(light.color.version), String(light.intensity),
    ...color, ...direction, ...position, String(range)].join('|'));
  return Object.freeze({ identity, type, color, intensity: light.intensity, direction, position, range, revision });
}

function freezeEnvironment(light: EnvironmentLight, diagnostics: RayPathDiagnostic[]): RayPathEnvironment | null {
  const diffuse = unwrapEnvironment(light.diffuseTexture);
  const specular = unwrapEnvironment(light.specularTexture);
  if (diffuse.texture && specular.texture && diffuse.texture !== specular.texture) {
    diagnostics.push(pathDiagnostic('extract', 'error', 'RAY_PATH_ENVIRONMENT_SPLIT_UNSUPPORTED',
      'The first path renderer accepts one source environment cube; separate diffuse/specular cubes were not approximated.', {}));
    return null;
  }
  const chosen = specular.texture ? specular : diffuse;
  const rgba = light.specularColor.writeLinear(new Float32Array(4));
  const color = vec3(rgba[0]!, rgba[1]!, rgba[2]!);
  const revision = fingerprint(['environment', String(light.id), String(light.intensity), String(light.rotation),
    String(light.specularColor.version), String(chosen.version), ...color].join('|'));
  return Object.freeze({ color, intensity: light.intensity, rotation: light.rotation,
    texture: chosen.texture, textureVersion: chosen.version, revision });
}

function unwrapEnvironment(source: EnvironmentCubeTexture | GPUTexture | null): { texture: GPUTexture | null; version: number } {
  if (!source) return { texture: null, version: 0 };
  if ('texture' in source) return { texture: source.texture, version: source.version ?? 0 };
  return { texture: source, version: 0 };
}

function worldMatrix(
  entity: Entity,
  cache: Map<number, RayMatrix4>,
  resolving: Set<number>,
  diagnostics: RayPathDiagnostic[],
): RayMatrix4 | null {
  const cached = cache.get(entity.id); if (cached) return cached;
  if (resolving.has(entity.id)) {
    diagnostics.push(pathDiagnostic('extract', 'error', 'RAY_PATH_HIERARCHY_CYCLE',
      'Entity hierarchy contains a cycle.', { entityId: entity.id }));
    return null;
  }
  resolving.add(entity.id);
  const transform = entity.getComponent(Transform3D);
  const local = transform ? [...transform.localMatrix] : [...IDENTITY];
  const parent = entity.parent ? worldMatrix(entity.parent, cache, resolving, diagnostics) : null;
  const result = entity.parent && !parent ? null : Object.freeze(parent ? [...mat4n.multiply(parent, local)] : local) as RayMatrix4;
  resolving.delete(entity.id);
  if (result) cache.set(entity.id, result);
  return result;
}
function isDisabled(entity: Entity): boolean {
  let current: Entity | null = entity;
  while (current) { if (current.disabled || current.destroyed) return true; current = current.parent; }
  return false;
}
function normalize(x: number, y: number, z: number): RayVec3 {
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? vec3(x / length, y / length, z / length) : vec3(0, 0, -1);
}
function vec3(x: number, y: number, z: number): RayVec3 { return Object.freeze([x, y, z]); }
function freezeResult(facts: RayPathSceneFacts | null, diagnostics: RayPathDiagnostic[]): RayPathSceneExtractionResult {
  return Object.freeze({ facts, diagnostics: Object.freeze([...diagnostics]) });
}
function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) { hash ^= BigInt(value.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
