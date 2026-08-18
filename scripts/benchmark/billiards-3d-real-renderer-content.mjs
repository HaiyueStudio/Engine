import {
  AmbientLight,
  BlinnPhongMaterial,
  CartesianTransform3D,
  DirectionalLight,
  Geometry3D,
  Mesh3D,
  Physics2DBody,
  Physics2DSystem,
  Physics2DTo3DTransformSync,
  Physics2DTo3DTransformSyncSystem,
  deserializeEntityCore,
} from '../../engine/dist/experimental.js';

export const BILLIARDS_3D_SCENE_PATH =
  'games/pad-simulator/scenes/billiards-3d-import.scene.json';
export const BILLIARDS_3D_SCENE_BYTE_LENGTH = 363_097;
export const BILLIARDS_3D_SCENE_SHA256 =
  '9e7f393aba90a91a1a84a42be9583ce627bfa2a0ee996c0b843d21f9514ba007';

const BILLIARDS_3D_SCENE_URL =
  new URL(`../../${BILLIARDS_3D_SCENE_PATH}`, import.meta.url);
const REPRESENTATIVE_DIRECTIONAL_SHADOW = Object.freeze({
  mapSize: 256,
  extent: 576,
  near: 3.2,
  far: 2_560,
  bias: 0.0015,
  normalBias: 0.02,
});
const RADIAL_SHADOW_MATERIAL_TYPE = 'RadialShadowMaterial';
const UNSUPPORTED_MATERIAL_DIAGNOSTIC =
  'BILLIARDS_REAL_RENDERER_UNSUPPORTED_MATERIAL';
const BENCHMARK_SKIPPED_COMPONENT_TYPES = Object.freeze([
  'Camera2D',
  'Camera3D',
  'CanvasTextComponent',
  'KeyboardComponent',
  'ScriptComponent',
]);
const benchmarkSkippedComponentTypes = new Set(BENCHMARK_SKIPPED_COMPONENT_TYPES);
const validatedSceneDocuments = new WeakSet();
let validatedSceneDocumentPromise;

/**
 * Loads the checked-in billiards scene from its fixed repository path and
 * installs its real entities/resources into the supplied benchmark World.
 */
export async function addBilliards3DRealRendererContent(
  world,
  sceneDocument = null,
) {
  const document = sceneDocument === null
    ? await getValidatedSceneDocument()
    : requireValidatedSceneDocument(sceneDocument);
  const resources = createSceneResources(document);
  const authoredStats = collectAuthoredStats(document, resources.unsupportedMaterialIds);
  const context = {
    getGeometry: id => resources.geometries.get(id) ?? null,
    getMaterial: id => resources.materials.get(id) ?? null,
    // Scene cameras must not replace the deterministic replay camera, while
    // gameplay input/scripts must not attach browser listeners in a benchmark.
    // All render, transform, light and physics components continue through the
    // shared core registry.
    deserializeComponent: data => (
      benchmarkSkippedComponentTypes.has(data.type) ? null : undefined
    ),
  };
  const rootEntities = document.entities.map(entity => deserializeEntityCore(entity, context));
  for (const entity of rootEntities) world.addEntity(entity);

  const physicsConfiguration = requirePhysicsConfiguration(document.systems);
  const physics2d = new Physics2DSystem({
    gravity: numberPair(physicsConfiguration.gravity, [0, 0]),
    pixelsPerMeter: finiteNumber(physicsConfiguration.pixelsPerMeter, 100),
    fixedTimeStep: finiteNumber(physicsConfiguration.fixedTimeStep, 1 / 60),
    maxSubSteps: finiteNumber(physicsConfiguration.maxSubSteps, 5),
    velocityIterations: finiteNumber(physicsConfiguration.velocityIterations, 8),
    positionIterations: finiteNumber(physicsConfiguration.positionIterations, 3),
    syncStaticBodiesFromTransform:
      physicsConfiguration.syncStaticBodiesFromTransform !== false,
    priority: finiteNumber(physicsConfiguration.priority, 0),
  });
  const physics2dTo3d = new Physics2DTo3DTransformSyncSystem();
  world.addSystem(physics2d);
  world.addSystem(physics2dTo3d);

  const runtimeStats = collectRuntimeStats(world);
  assertSceneResourceParity(authoredStats, runtimeStats, resources);
  const ambientLight = findSingleComponent(world, AmbientLight, 'AmbientLight');
  const directionalLight =
    findSingleComponent(world, DirectionalLight, 'DirectionalLight');
  directionalLight.castShadow = true;
  Object.assign(directionalLight.shadow, REPRESENTATIVE_DIRECTIONAL_SHADOW);
  directionalLight.markDirty();

  // The first zero-delta update creates backend bodies and performs the initial
  // 2D -> 3D synchronization without advancing simulation time.
  world.update(0, 0);
  const physicsProbe = createPhysicsMotionProbe(world, physics2d);
  const unsupportedMaterialDiagnostics =
    createUnsupportedMaterialDiagnostics(resources, authoredStats);
  const skippedComponentCount =
    authoredStats.componentCount - runtimeStats.componentCount;
  const unsupportedMaterialMeshCount =
    authoredStats.unsupportedMaterialEntityNames.length;
  const attributedSkippedComponentCount =
    authoredStats.intentionallySkippedComponentCount
    + unsupportedMaterialMeshCount;
  if (skippedComponentCount !== attributedSkippedComponentCount) {
    throw new Error(
      `Billiards skipped component attribution mismatch: observed `
      + `${skippedComponentCount}, attributed ${attributedSkippedComponentCount}.`,
    );
  }
  const provenance = Object.freeze({
    scenePath: BILLIARDS_3D_SCENE_PATH,
    sceneByteLength: BILLIARDS_3D_SCENE_BYTE_LENGTH,
    sceneSha256: BILLIARDS_3D_SCENE_SHA256,
    sourceSceneEntityCount: runtimeStats.entityCount,
    authoredMeshCount: authoredStats.meshCount,
    meshCount: runtimeStats.meshCount,
    geometryCount: resources.geometries.size,
    authoredGeometryCount: document.resources.geometries.length,
    materialCount: resources.materials.size,
    authoredMaterialCount: document.resources.materials.length,
    physicsBodyCount: runtimeStats.physicsBodyCount,
    ambientLightCount: authoredStats.ambientLightCount,
    directionalLightCount: authoredStats.directionalLightCount,
    skippedComponentCount,
    intentionallySkippedComponentCount:
      authoredStats.intentionallySkippedComponentCount,
    unsupportedMaterialMeshCount,
    unsupportedMaterialAffectedEntityCount:
      authoredStats.unsupportedMaterialEntityNames.length,
    intentionallySkippedComponentTypes: BENCHMARK_SKIPPED_COMPONENT_TYPES,
    unsupportedMaterialDiagnostics,
    directionalShadow: Object.freeze({ ...REPRESENTATIVE_DIRECTIONAL_SHADOW }),
  });
  return {
    rootEntities,
    resources,
    physics2d,
    physics2dTo3d,
    physicsProbe,
    ambientLight,
    directionalLight,
    provenance,
  };
}

export async function validateBilliards3DSceneBytes(bytes) {
  const view = asUint8Array(bytes);
  if (view.byteLength !== BILLIARDS_3D_SCENE_BYTE_LENGTH) {
    throw new Error(
      `Billiards scene byte length mismatch for ${BILLIARDS_3D_SCENE_PATH}: `
      + `expected ${BILLIARDS_3D_SCENE_BYTE_LENGTH}, received ${view.byteLength}.`,
    );
  }
  const sha256 = await sha256Hex(view);
  if (sha256 !== BILLIARDS_3D_SCENE_SHA256) {
    throw new Error(
      `Billiards scene SHA-256 mismatch for ${BILLIARDS_3D_SCENE_PATH}: `
      + `expected ${BILLIARDS_3D_SCENE_SHA256}, received ${sha256}.`,
    );
  }
  return view;
}

export async function parseBilliards3DSceneDocument(bytes) {
  const validatedBytes = await validateBilliards3DSceneBytes(bytes);
  let document;
  try {
    document = JSON.parse(new TextDecoder().decode(validatedBytes));
  } catch (error) {
    throw new Error(
      `Billiards scene is not valid JSON: ${error?.message ?? error}`,
    );
  }
  assertSceneDocument(document);
  validatedSceneDocuments.add(document);
  return document;
}

export function hasBilliardsPhysicsMotion(content) {
  const position = content.physicsProbe.transform.position;
  const initial = content.physicsProbe.initialPosition;
  return position[0] !== initial[0]
    || position[1] !== initial[1]
    || position[2] !== initial[2];
}

async function getValidatedSceneDocument() {
  validatedSceneDocumentPromise ??= readFixedSceneBytes()
    .then(parseBilliards3DSceneDocument);
  return validatedSceneDocumentPromise;
}

function requireValidatedSceneDocument(document) {
  if (!validatedSceneDocuments.has(document)) {
    throw new TypeError(
      'Injected billiards scene document must come from '
      + 'parseBilliards3DSceneDocument().',
    );
  }
  return document;
}

async function readFixedSceneBytes() {
  if (BILLIARDS_3D_SCENE_URL.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return readFile(BILLIARDS_3D_SCENE_URL);
  }
  const response = await fetch(BILLIARDS_3D_SCENE_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to load billiards scene ${BILLIARDS_3D_SCENE_PATH}: `
      + `${response.status} ${response.statusText}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function createSceneResources(document) {
  const geometries = new Map();
  for (const data of document.resources.geometries) {
    geometries.set(Number(data.id), new Geometry3D({
      positions: new Float32Array(data.positions),
      normals: data.normals ? new Float32Array(data.normals) : undefined,
      textureCoordinates: (data.textureCoordinates ?? []).map(coordinate => ({
        set: Number(coordinate.set),
        data: new Float32Array(coordinate.data),
      })),
      textureCoordinateLayout: data.textureCoordinateLayout ?? undefined,
      indices: data.indices
        ? data.indexType === 'uint32'
          ? new Uint32Array(data.indices)
          : new Uint16Array(data.indices)
        : undefined,
      topology: data.topology ?? undefined,
      cullMode: data.cullMode ?? undefined,
      frontFace: data.frontFace ?? undefined,
    }));
  }

  const materials = new Map();
  const unsupportedMaterials = [];
  const unsupportedMaterialIds = new Set();
  for (const data of document.resources.materials) {
    if (data.type === RADIAL_SHADOW_MATERIAL_TYPE) {
      unsupportedMaterials.push(data);
      unsupportedMaterialIds.add(Number(data.id));
      continue;
    }
    if (data.type !== 'BlinnPhongMaterial') {
      throw new TypeError(
        `Unsupported billiards material type "${String(data.type)}" `
        + `for material ${String(data.id)}.`,
      );
    }
    materials.set(Number(data.id), new BlinnPhongMaterial({
      ambient: data.ambient,
      diffuse: data.diffuse,
      specular: data.specular,
      shininess: data.shininess,
      blending: data.blending,
    }));
  }
  return {
    geometries,
    materials,
    unsupportedMaterials,
    unsupportedMaterialIds,
  };
}

function collectAuthoredStats(document, unsupportedMaterialIds) {
  const stats = {
    entityCount: 0,
    componentCount: 0,
    meshCount: 0,
    supportedMeshCount: 0,
    physicsBodyCount: 0,
    ambientLightCount: 0,
    directionalLightCount: 0,
    intentionallySkippedComponentCount: 0,
    unsupportedMaterialEntityNames: [],
  };
  for (const root of document.entities) collectAuthoredEntity(root, stats, unsupportedMaterialIds);
  return stats;
}

function collectAuthoredEntity(entity, stats, unsupportedMaterialIds) {
  stats.entityCount++;
  for (const component of entity.components ?? []) {
    stats.componentCount++;
    if (benchmarkSkippedComponentTypes.has(component.type)) {
      stats.intentionallySkippedComponentCount++;
    }
    if (component.type === 'Mesh3D') {
      stats.meshCount++;
      if (unsupportedMaterialIds.has(Number(component.materialId))) {
        stats.unsupportedMaterialEntityNames.push(entity.name);
      } else {
        stats.supportedMeshCount++;
      }
    } else if (component.type === 'Physics2DBody') {
      stats.physicsBodyCount++;
    } else if (component.type === 'AmbientLight') {
      stats.ambientLightCount++;
    } else if (component.type === 'DirectionalLight') {
      stats.directionalLightCount++;
    }
  }
  for (const child of entity.children ?? []) {
    collectAuthoredEntity(child, stats, unsupportedMaterialIds);
  }
}

function collectRuntimeStats(world) {
  let componentCount = 0;
  let meshCount = 0;
  let physicsBodyCount = 0;
  for (const entity of world.entities.values()) {
    componentCount += entity.components.size;
    if (entity.getComponent(Mesh3D)) meshCount++;
    if (entity.getComponent(Physics2DBody)) physicsBodyCount++;
  }
  return {
    entityCount: world.entities.size,
    componentCount,
    meshCount,
    physicsBodyCount,
  };
}

function assertSceneResourceParity(authored, runtime, resources) {
  if (runtime.entityCount !== authored.entityCount) {
    throw new Error(
      `Billiards entity count mismatch: expected ${authored.entityCount}, `
      + `loaded ${runtime.entityCount}.`,
    );
  }
  if (runtime.meshCount !== authored.supportedMeshCount) {
    throw new Error(
      `Billiards mesh count mismatch: expected ${authored.supportedMeshCount} `
      + `supported scene meshes, loaded ${runtime.meshCount}.`,
    );
  }
  if (runtime.physicsBodyCount !== authored.physicsBodyCount) {
    throw new Error(
      `Billiards physics body count mismatch: expected ${authored.physicsBodyCount}, `
      + `loaded ${runtime.physicsBodyCount}.`,
    );
  }
  if (resources.geometries.size === 0 || resources.materials.size === 0) {
    throw new Error('Billiards scene must load real geometry and material resources.');
  }
}

function createUnsupportedMaterialDiagnostics(resources, authoredStats) {
  const entityNames = Object.freeze(
    [...authoredStats.unsupportedMaterialEntityNames],
  );
  return Object.freeze(resources.unsupportedMaterials.map(material => Object.freeze({
    code: UNSUPPORTED_MATERIAL_DIAGNOSTIC,
    materialType: material.type,
    materialId: Number(material.id),
    materialName: material.name,
    skippedMeshComponentCount: entityNames.length,
    affectedEntityCount: entityNames.length,
    affectedEntityNames: entityNames,
    message: `${UNSUPPORTED_MATERIAL_DIAGNOSTIC}: `
      + `${material.type} material ${material.id} ("${material.name}") is not `
      + `supported by the lighting benchmark; skipped ${entityNames.length} `
      + 'Mesh3D components while retaining their entities: '
      + `${entityNames.join(', ')}.`,
  })));
}

function createPhysicsMotionProbe(world, physics2d) {
  for (const entity of world.entities.values()) {
    const body = entity.getComponent(Physics2DBody);
    const sync = entity.getComponent(Physics2DTo3DTransformSync);
    const transform = entity.getComponent(CartesianTransform3D);
    if (!body || body.type !== 'dynamic' || !sync || !transform) continue;
    const velocityApplied = physics2d.setLinearVelocity(body, 1.5, 0.35);
    if (!velocityApplied) {
      throw new Error(
        `Billiards physics probe could not activate dynamic body "${entity.name}".`,
      );
    }
    return {
      entityName: entity.name,
      transform,
      initialPosition: Float32Array.from(transform.position),
    };
  }
  throw new Error(
    'Billiards scene requires a dynamic Physics2DBody with 2D/3D transform sync.',
  );
}

function findSingleComponent(world, componentType, label) {
  let result = null;
  let count = 0;
  for (const entity of world.entities.values()) {
    const component = entity.getComponent(componentType);
    if (!component) continue;
    result = component;
    count++;
  }
  if (count !== 1 || !result) {
    throw new Error(
      `Billiards scene requires exactly one ${label}; loaded ${count}.`,
    );
  }
  return result;
}

function requirePhysicsConfiguration(systems) {
  const matches = systems.filter(system => system.type === 'Physics2DSystem');
  if (matches.length !== 1) {
    throw new Error(
      `Billiards scene requires exactly one Physics2DSystem configuration; `
      + `found ${matches.length}.`,
    );
  }
  return matches[0];
}

function assertSceneDocument(document) {
  if (!document || !Array.isArray(document.entities)
    || !Array.isArray(document.systems)
    || !Array.isArray(document.resources?.geometries)
    || !Array.isArray(document.resources?.materials)) {
    throw new TypeError(
      `Invalid billiards scene document at ${BILLIARDS_3D_SCENE_PATH}.`,
    );
  }
}

function numberPair(value, fallback) {
  return Array.isArray(value) && value.length >= 2
    ? [finiteNumber(value[0], fallback[0]), finiteNumber(value[1], fallback[1])]
    : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError('Billiards scene bytes must be an ArrayBuffer or typed array.');
}

async function sha256Hex(bytes) {
  let cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    ({ webcrypto: cryptoApi } = await import('node:crypto'));
  }
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return Array.from(new Uint8Array(digest), value => (
    value.toString(16).padStart(2, '0')
  )).join('');
}
