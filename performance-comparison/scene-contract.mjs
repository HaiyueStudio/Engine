export const SCENE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  id: 'pbr-grid-v1',
  title: 'PBR grid (256 boxes, 8 materials, 2 lights)',
  viewport: Object.freeze({ width: 1280, height: 720, devicePixelRatio: 1 }),
  clearColor: Object.freeze([0.025, 0.04, 0.07, 1]),
  camera: Object.freeze({
    position: Object.freeze([22, 18, 24]),
    target: Object.freeze([0, 0, 0]),
    fovRadians: Math.PI / 4,
    near: 0.1,
    far: 100,
  }),
  grid: Object.freeze({ columns: 16, rows: 16, spacing: 1.45, boxSize: 1 }),
  objectCount: 256,
  trianglesPerObject: 12,
  triangleCount: 3072,
  materialCount: 8,
  lights: Object.freeze({ directional: 1, ambient: 1, shadows: 0 }),
  antialiasSamples: 1,
  materials: Object.freeze([
    Object.freeze({ color: Object.freeze([0.82, 0.16, 0.12]), metallic: 0.05, roughness: 0.28 }),
    Object.freeze({ color: Object.freeze([0.95, 0.48, 0.08]), metallic: 0.25, roughness: 0.42 }),
    Object.freeze({ color: Object.freeze([0.84, 0.78, 0.12]), metallic: 0.1, roughness: 0.62 }),
    Object.freeze({ color: Object.freeze([0.12, 0.7, 0.42]), metallic: 0.35, roughness: 0.34 }),
    Object.freeze({ color: Object.freeze([0.08, 0.58, 0.88]), metallic: 0.6, roughness: 0.22 }),
    Object.freeze({ color: Object.freeze([0.24, 0.28, 0.9]), metallic: 0.75, roughness: 0.5 }),
    Object.freeze({ color: Object.freeze([0.62, 0.18, 0.82]), metallic: 0.45, roughness: 0.72 }),
    Object.freeze({ color: Object.freeze([0.86, 0.32, 0.58]), metallic: 0.2, roughness: 0.18 }),
  ]),
});

export function createObjectDescriptors(contract = SCENE_CONTRACT) {
  const { columns, rows, spacing } = contract.grid;
  if (columns * rows !== contract.objectCount) {
    throw new Error(`Scene contract object count mismatch: ${columns}x${rows} != ${contract.objectCount}.`);
  }
  const xOffset = (columns - 1) * spacing * 0.5;
  const zOffset = (rows - 1) * spacing * 0.5;
  return Array.from({ length: contract.objectCount }, (_, index) => ({
    id: index,
    position: [
      (index % columns) * spacing - xOffset,
      ((index * 17) % 5) * 0.08,
      Math.floor(index / columns) * spacing - zOffset,
    ],
    rotation: [0.08 * (index % 7), 0.11 * (index % 11), 0],
    materialIndex: index % contract.materialCount,
  }));
}

export function expectedStructuralEvidence(contract = SCENE_CONTRACT) {
  return {
    sceneId: contract.id,
    width: contract.viewport.width,
    height: contract.viewport.height,
    devicePixelRatio: contract.viewport.devicePixelRatio,
    objectCount: contract.objectCount,
    triangleCount: contract.triangleCount,
    materialCount: contract.materialCount,
    directionalLightCount: contract.lights.directional,
    ambientLightCount: contract.lights.ambient,
    shadowCount: contract.lights.shadows,
    antialiasSamples: contract.antialiasSamples,
  };
}

