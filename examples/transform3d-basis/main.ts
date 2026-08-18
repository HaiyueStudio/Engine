import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { BasisTransform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { Mesh3DRenderer, setRender3DMeshRenderer } from '@haiyue/engine/experimental';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { LineGeometry } from '@haiyue/engine/geometry';
import { LineMaterial } from '@haiyue/engine/material';
import { Line3D } from '@haiyue/engine/components';
import { Line3DRenderSystem } from '@haiyue/engine/systems';
import { requiredNumberAt } from '../arrayAccess';

type AxisKey = 'x' | 'y' | 'z';

const params = {
  coordX: 1,
  coordY: 1,
  coordZ: 1,
  basisXX: 1,
  basisXY: 0,
  basisXZ: 0,
  basisYX: 0,
  basisYY: 1,
  basisYZ: 0,
  basisZX: 0,
  basisZY: 0,
  basisZZ: 1,
  resetIdentity: () => {
    Object.assign(params, {
      coordX: 1,
      coordY: 1,
      coordZ: 1,
      basisXX: 1,
      basisXY: 0,
      basisXZ: 0,
      basisYX: 0,
      basisYY: 1,
      basisYZ: 0,
      basisZX: 0,
      basisZY: 0,
      basisZZ: 1,
    });
    applyBasis();
    updateGui();
  },
  shearPreset: () => {
    Object.assign(params, {
      coordX: 1.2,
      coordY: 0.8,
      coordZ: 1.1,
      basisXX: 1.5,
      basisXY: 0,
      basisXZ: 0,
      basisYX: 0.7,
      basisYY: 1.2,
      basisYZ: 0,
      basisZX: -0.35,
      basisZY: 0.25,
      basisZZ: 1.4,
    });
    applyBasis();
    updateGui();
  },
};

let basisTransform: BasisTransform3D;
let basisLines: Record<AxisKey, LineGeometry>;
let positionLine: LineGeometry;
let readout: HTMLElement;
let gui: dat.GUI;

function color(r: number, g: number, b: number, a = 1): ColorSRGB {
  return new ColorSRGB(r, g, b, a);
}

function makeLine(points: number[], material: LineMaterial): { entity: Entity; geometry: LineGeometry } {
  const entity = new Entity('Line');
  const geometry = new LineGeometry(points);
  entity.addComponent(new CartesianTransform3D());
  entity.addComponent(new Line3D(geometry, material));
  return { entity, geometry };
}

function makeBasisLine(axis: AxisKey, material: LineMaterial): { entity: Entity; geometry: LineGeometry } {
  const end: [number, number, number] = axis === 'x'
    ? [params.basisXX, params.basisXY, params.basisXZ]
    : axis === 'y'
      ? [params.basisYX, params.basisYY, params.basisYZ]
      : [params.basisZX, params.basisZY, params.basisZZ];
  return makeLine([0, 0, 0, end[0], end[1], end[2]], material);
}

function applyBasis(): void {
  basisTransform
    .setBasis(
      [params.basisXX, params.basisXY, params.basisXZ],
      [params.basisYX, params.basisYY, params.basisYZ],
      [params.basisZX, params.basisZY, params.basisZZ],
    )
    .setCoordinates(params.coordX, params.coordY, params.coordZ);

  basisLines.x.setPoints([0, 0, 0, params.basisXX, params.basisXY, params.basisXZ]);
  basisLines.y.setPoints([0, 0, 0, params.basisYX, params.basisYY, params.basisYZ]);
  basisLines.z.setPoints([0, 0, 0, params.basisZX, params.basisZY, params.basisZZ]);

  const p = basisTransform.mappedPosition;
  const px = requiredNumberAt(p, 0, 'mapped basis position');
  const py = requiredNumberAt(p, 1, 'mapped basis position');
  const pz = requiredNumberAt(p, 2, 'mapped basis position');
  positionLine.setPoints([0, 0, 0, px, py, pz]);
  readout.innerHTML = [
    `local: (${params.coordX.toFixed(2)}, ${params.coordY.toFixed(2)}, ${params.coordZ.toFixed(2)})`,
    `world: (${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)})`,
  ].join('<br />');
}

function updateGui(): void {
  type GuiInternals = {
    __controllers: Array<{ updateDisplay(): void }>;
    __folders: Record<string, { __controllers: Array<{ updateDisplay(): void }> }>;
  };
  const internals = gui as unknown as GuiInternals;
  for (const controller of internals.__controllers) controller.updateDisplay();
  for (const folderName of Object.keys(internals.__folders)) {
    const folder = internals.__folders[folderName];
    if (!folder) continue;
    for (const controller of folder.__controllers) controller.updateDisplay();
  }
}

function addBasisFolder(guiRoot: dat.GUI, name: string, keys: [string, string, string]): void {
  const folder = guiRoot.addFolder(name);
  folder.add(params, keys[0] as keyof typeof params, -3, 3, 0.01).name('x').onChange(applyBasis);
  folder.add(params, keys[1] as keyof typeof params, -3, 3, 0.01).name('y').onChange(applyBasis);
  folder.add(params, keys[2] as keyof typeof params, -3, 3, 0.01).name('z').onChange(applyBasis);
  folder.open();
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  readout = document.getElementById('readout') as HTMLElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.035, g: 0.038, b: 0.05, a: 1 },
  });
  await engine.init();

  const spherical = new SphericalTransform3D({
    radius: 12,
    theta: Math.PI / 4,
    phi: Math.PI / 3,
    target: [0.8, 0.8, 0.4],
  });
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  camera.addComponent(spherical);
  const scene = engine.createScene({
    name: 'BasisTransform3D',
    camera,
    render3D: true,
    render2D: false,
    gui: false,
    pipelineLabel: 'Transform3DBasis.render',
  });
  const { world } = scene;

  new OrbitControl(canvas, spherical, {
    minRadius: 4,
    maxRadius: 40,
    rotateSpeed: 0.8,
    zoomSpeed: 1,
    panSpeed: 0.9,
  });

  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -0.04, 0] }));
  ground.addComponent(new Mesh3D(
    createBox3D({ width: 8, height: 0.04, depth: 8 }),
    new BasicMaterial({ color: color(0.16, 0.17, 0.19) }),
  ));
  world.addEntity(ground);

  basisTransform = new BasisTransform3D({ coordinates: [1, 1, 1] });
  const transformed = new Entity('Basis Object');
  transformed.addComponent(basisTransform);
  transformed.addComponent(new Mesh3D(
    createBox3D({ width: 0.45, height: 0.45, depth: 0.45 }),
    new BasicMaterial({ color: color(1, 0.82, 0.18) }),
  ));
  world.addEntity(transformed);

  const origin = new Entity('Origin');
  origin.addComponent(new CartesianTransform3D({ position: [0, 0, 0] }));
  origin.addComponent(new Mesh3D(
    createSphere3D({ radius: 0.08, widthSegments: 16, heightSegments: 8 }),
    new BasicMaterial({ color: color(1, 1, 1) }),
  ));
  world.addEntity(origin);

  const xLine = makeBasisLine('x', new LineMaterial({ color: color(1, 0.22, 0.22), width: 5, cap: 'round' }));
  const yLine = makeBasisLine('y', new LineMaterial({ color: color(0.25, 1, 0.35), width: 5, cap: 'round' }));
  const zLine = makeBasisLine('z', new LineMaterial({ color: color(0.3, 0.48, 1), width: 5, cap: 'round' }));
  const mappedLine = makeLine([0, 0, 0, 1, 1, 1], new LineMaterial({
    color: color(1, 0.9, 0.2),
    width: 3,
    cap: 'round',
  }));

  basisLines = { x: xLine.geometry, y: yLine.geometry, z: zLine.geometry };
  positionLine = mappedLine.geometry;
  for (const item of [xLine, yLine, zLine, mappedLine]) world.addEntity(item.entity);

  const renderSystem = scene.render3DSystem!;
  setRender3DMeshRenderer(renderSystem, new Mesh3DRenderer());
  scene.addSystem(new Line3DRenderSystem(engine, camera));

  gui = new dat.GUI({ width: 300 });
  const coords = gui.addFolder('Local Coordinates');
  coords.add(params, 'coordX', -3, 3, 0.01).name('x').onChange(applyBasis);
  coords.add(params, 'coordY', -3, 3, 0.01).name('y').onChange(applyBasis);
  coords.add(params, 'coordZ', -3, 3, 0.01).name('z').onChange(applyBasis);
  coords.open();

  addBasisFolder(gui, 'Basis X', ['basisXX', 'basisXY', 'basisXZ']);
  addBasisFolder(gui, 'Basis Y', ['basisYX', 'basisYY', 'basisYZ']);
  addBasisFolder(gui, 'Basis Z', ['basisZX', 'basisZY', 'basisZZ']);
  gui.add(params, 'shearPreset').name('Shear Preset');
  gui.add(params, 'resetIdentity').name('Reset Identity');

  applyBasis();

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
