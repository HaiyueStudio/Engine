import {
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
  SphericalTransform3D,
  World,
  createBox3D,
  createSphere3D,
} from '@haiyue/engine';

export interface OrbitRayScene {
  readonly world: World;
  readonly cameraEntity: Entity;
  readonly cameraTransform: SphericalTransform3D;
}

export function createOrbitRayScene(): OrbitRayScene {
  const world = new World('Interactive progressive ray tracing');
  const room = new PbrMaterial({
    baseColor: [0.13, 0.17, 0.24, 1],
    metallic: 0.02,
    roughness: 0.78,
  });
  const warm = new PbrMaterial({
    baseColor: [0.92, 0.16, 0.055, 1],
    metallic: 0.08,
    roughness: 0.36,
  });
  const metal = new PbrMaterial({
    baseColor: [0.72, 0.82, 0.96, 1],
    metallic: 0.94,
    roughness: 0.12,
  });
  const blue = new PbrMaterial({
    baseColor: [0.035, 0.23, 0.68, 1],
    metallic: 0.18,
    roughness: 0.25,
  });
  const emissive = new PbrMaterial({
    baseColor: [0.05, 0.16, 0.2, 1],
    metallic: 0,
    roughness: 0.48,
    emissiveFactor: [0.35, 0.85, 1.65],
  });

  addMesh(world, 'Floor', createBox3D({ width: 10, height: 0.18, depth: 9 }), room, [0, -1.7, -1.5]);
  addMesh(world, 'Back wall', createBox3D({ width: 10, height: 5.8, depth: 0.18 }), room, [0, 1.1, -5.4]);
  addMesh(world, 'Left wall', createBox3D({ width: 0.18, height: 5.8, depth: 9 }), room, [-5, 1.1, -1.5]);
  addMesh(world, 'Warm sphere', cleanSphere(1.15), warm, [-2.15, -0.45, -1.7]);
  addMesh(world, 'Mirror sphere', cleanSphere(1.02), metal, [1.55, -0.58, -2.1]);
  addMesh(world, 'Blue block', createBox3D({ width: 1.35, height: 1.8, depth: 1.25 }), blue, [0.05, -0.72, -0.25], [0.08, 0.48, 0.04]);
  addMesh(world, 'Emissive bar', createBox3D({ width: 2.2, height: 0.16, depth: 0.36 }), emissive, [0.2, 2.2, -3.6], [0, -0.18, 0]);

  const cameraTransform = new SphericalTransform3D({
    radius: 8.2,
    theta: 0,
    phi: 1.42,
    target: [0, -0.05, -1.65],
  });
  const cameraEntity = new Entity('Orbit camera')
    .add(cameraTransform)
    .add(new Camera3D({ fov: Math.PI / 3, near: 0.05, far: 100 }));
  world.addEntity(cameraEntity);
  world.addEntity(new Entity('Sun').add(new DirectionalLight({
    direction: [-0.42, -0.82, -0.36],
    color: [1, 0.91, 0.78],
    intensity: 2.5,
  })));
  world.addEntity(new Entity('Environment').add(new EnvironmentLight({
    intensity: 0.3,
    diffuseColor: [0.055, 0.1, 0.2],
    specularColor: [0.2, 0.38, 0.72],
  })));

  return Object.freeze({ world, cameraEntity, cameraTransform });
}

function addMesh(
  world: World,
  name: string,
  geometry: Geometry3D,
  material: PbrMaterial,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): void {
  world.addEntity(
    new Entity(name)
      .add(new CartesianTransform3D({ position, rotation }))
      .add(new Mesh3D(geometry, material)),
  );
}

function cleanSphere(radius: number): Geometry3D {
  const source = createSphere3D({ radius, widthSegments: 32, heightSegments: 20 });
  if (!source.indices) return source;
  const kept: number[] = [];
  const positions = source.positions;
  for (let offset = 0; offset < source.indices.length; offset += 3) {
    const ia = source.indices[offset] ?? 0;
    const ib = source.indices[offset + 1] ?? 0;
    const ic = source.indices[offset + 2] ?? 0;
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
    const abx = (positions[b] ?? 0) - (positions[a] ?? 0);
    const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
    const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
    const acx = (positions[c] ?? 0) - (positions[a] ?? 0);
    const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
    const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    const areaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ;
    const edgeScale = Math.max(
      (abx * abx + aby * aby + abz * abz) * (acx * acx + acy * acy + acz * acz),
      1,
    );
    if (areaSquared > 1e-24 * edgeScale) kept.push(ia, ib, ic);
  }
  return new Geometry3D({
    positions: source.positions,
    ...(source.normals ? { normals: source.normals } : {}),
    textureCoordinates: [...source.textureCoordinates].map(([set, data]) => ({ set, data })),
    textureCoordinateLayout: source.textureCoordinateLayout,
    indices: source.indices instanceof Uint32Array ? Uint32Array.from(kept) : Uint16Array.from(kept),
    ...(source.topology ? { topology: source.topology } : {}),
    ...(source.cullMode ? { cullMode: source.cullMode } : {}),
    ...(source.frontFace ? { frontFace: source.frontFace } : {}),
  });
}
