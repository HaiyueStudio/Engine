import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRANCH_SIZE = 100;

export function createDeterministicEditorScene(
  entityCount,
  { branchSize = DEFAULT_BRANCH_SIZE, seed = 0x5eed1234 } = {},
) {
  if (!Number.isSafeInteger(entityCount) || entityCount < 1) {
    throw new RangeError('entityCount must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(branchSize) || branchSize < 2) {
    throw new RangeError('branchSize must be a safe integer of at least two.');
  }
  const entities = [];
  let created = 0;
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  while (created < entityCount) {
    const groupIndex = entities.length;
    const rootOrdinal = created++;
    const root = createEntity(rootOrdinal, groupIndex, -1, random);
    const childCount = Math.min(branchSize - 1, entityCount - created);
    for (let childIndex = 0; childIndex < childCount; childIndex++) {
      root.children.push(createEntity(created++, groupIndex, childIndex, random));
    }
    entities.push(root);
  }
  const scene = {
    version: 1,
    name: `Deterministic Editor Scale ${entityCount}`,
    globals: {
      designWidth: 1280,
      designHeight: 720,
      viewportMode: 'fit',
      clearColor: [0.025, 0.035, 0.055, 1],
      reverseZ: false,
      render2DLoadOp: 'clear',
      guiLoadOp: 'load',
      parameters: {},
      inputMap: {},
    },
    systems: [],
    resources: {
      geometries: [{
        id: 1,
        name: 'Scale Gate Triangle',
        positions: [-0.08, -0.08, 0, 0.08, -0.08, 0, 0, 0.08, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        textureCoordinates: [],
        textureCoordinateLayout: [],
        indices: [0, 1, 2],
        indexType: 'uint16',
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      }],
      materials: [{
        id: 1,
        name: 'Scale Gate Material',
        type: 'BasicMaterial',
        color: [0.2, 0.55, 0.9, 1],
        blending: 'none',
        textureId: null,
      }],
      textures: [],
      models: [],
      prefabs: [],
      scripts: [],
    },
    entities,
  };
  const json = `${JSON.stringify(scene)}\n`;
  return Object.freeze({
    scene,
    json,
    entityCount,
    rootCount: entities.length,
    branchSize,
    seed,
    sha256: createHash('sha256').update(json).digest('hex'),
  });
}

function createEntity(ordinal, groupIndex, childIndex, random) {
  const padded = String(ordinal).padStart(5, '0');
  const x = Number(((ordinal % 101) * 0.125).toFixed(3));
  const y = Number(((groupIndex % 37) * 0.25).toFixed(3));
  const z = Number(((random() - 0.5) * 4).toFixed(3));
  const components = [{
    type: 'CartesianTransform3D',
    position: [x, y, z],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    anchor: [0, 0, 0],
  }];
  if (childIndex < 0) {
    components.push({
      type: 'Mesh3D',
      geometryId: 1,
      materialId: 1,
    });
  }
  return {
    name: childIndex < 0
      ? `Scale Group ${String(groupIndex).padStart(3, '0')} · Entity ${padded}`
      : `Scale Entity ${padded} · G${String(groupIndex).padStart(3, '0')}C${String(childIndex).padStart(2, '0')}`,
    disabled: false,
    components,
    children: [],
  };
}

function parseArguments(argv) {
  const options = { entityCount: 1000, output: null };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--entities') options.entityCount = Number(argv[++index]);
    else if (value === '--output') options.output = argv[++index] ?? null;
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const generated = createDeterministicEditorScene(options.entityCount);
  if (options.output) {
    const path = resolve(options.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated.json);
    console.log(`${path} ${generated.sha256}`);
  } else {
    process.stdout.write(generated.json);
  }
}
