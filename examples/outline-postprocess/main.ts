import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { World } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { Render3DSystem } from '@haiyue/engine/systems';
import { RenderIntegration } from '@haiyue/engine/experimental';
import { PostProcessRenderFeature } from '@haiyue/engine/postprocess';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { OutlinePass } from '@haiyue/engine/postprocess';
import { OutlineTarget } from '@haiyue/engine/components';
import { FxaaPass } from '@haiyue/engine/postprocess';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { createCone3D } from '@haiyue/engine/geometry';
import { createIcosahedron3D } from '@haiyue/engine/geometry';
import { createPlane3D } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

interface OutlineDemoParams {
  enabled: boolean;
  fxaa: boolean;
  color: string;
  hiddenColor: string;
  strength: number;
  thickness: number;
  glow: number;
  rotate: boolean;
}

function hexToRgba(hex: string): [number, number, number, number] {
  const color = ColorSRGB.fromHex(hex);
  return [color.r, color.g, color.b, 1];
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.055, g: 0.065, b: 0.075, a: 1 },
  });
  await engine.init();

  const world = new World('OutlinePostprocess');

  const cameraTransform = new SphericalTransform3D({
    radius: 12,
    theta: Math.PI * 0.18,
    phi: Math.PI * 0.30,
    target: [0, 0.8, 0],
  });
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 }));
  camera.addComponent(cameraTransform);
  world.addEntity(camera);

  new OrbitControl(canvas, cameraTransform, { minRadius: 4, maxRadius: 26, rotateSpeed: 0.75 });

  const renderSystem = new Render3DSystem(engine, camera, { loadOp: 'clear' });
  const postProcess = new PostProcessRenderFeature(renderSystem);
  const outlinePass = new OutlinePass({
    visibleEdgeColor: [1, 1, 1],
    hiddenEdgeColor: [0.1, 0.04, 0.02],
    edgeStrength: 3,
    edgeThickness: 1,
    edgeGlow: 0,
  });
  const fxaaPass = new FxaaPass();
  world.addSystem(renderSystem);
  world.addSystem(postProcess);
  const renderIntegration = new RenderIntegration(engine, { label: 'OutlinePostprocess.render' });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration.registerAll(world);

  const params: OutlineDemoParams = {
    enabled: true,
    fxaa: true,
    color: '#ffffff',
    hiddenColor: '#190a05',
    strength: 3,
    thickness: 1,
    glow: 0,
    rotate: true,
  };

  const moving: Array<{ transform: Transform3D; base: Float32Array; spin: [number, number, number] }> = [];

  function addMesh(
    name: string,
    geometry: ReturnType<typeof createBox3D>,
    color: string,
    position: [number, number, number],
    scale: [number, number, number] = [1, 1, 1],
    spin: [number, number, number] = [0, 0, 0],
    outlined = false,
  ): Entity {
    const entity = new Entity(name);
    const transform = new Transform3D();
    const base = mat4.multiply(
      mat4.translation(position),
      mat4.scaling(scale),
    ) as Float32Array;
    transform.localMatrix = base;
    entity.addComponent(transform);
    entity.addComponent(new Mesh3D(
      geometry,
      new BasicMaterial({ color: ColorSRGB.fromHex(color) }),
    ));
    if (outlined) entity.addComponent(new OutlineTarget());
    world.addEntity(entity);
    moving.push({ transform, base, spin });
    return entity;
  }

  const box = createBox3D({ width: 1.6, height: 1.6, depth: 1.6 });
  const sphere = createSphere3D({ radius: 1, widthSegments: 48, heightSegments: 28 });
  const cone = createCone3D({ radius: 0.95, height: 2.2, radialSegments: 40 });
  const ico = createIcosahedron3D({ radius: 1.05, detail: 2 });
  const plane = createPlane3D({ width: 14, height: 9 });

  addMesh('Ground', plane, '#44505d', [0, -1.25, 0], [1, 1, 1], [0, 0, 0])
    .getComponent(Transform3D)!.localMatrix = mat4.multiply(
      mat4.translation([0, -1.25, 0]),
      mat4.rotationX(-Math.PI / 2),
    ) as Float32Array;

  addMesh('Sphere', sphere, '#f2f5f7', [0, 0.1, 0], [1.25, 1.25, 1.25], [0, 0.65, 0], true);
  addMesh('Box', box, '#e4554f', [-3.0, 0.0, -0.4], [1.1, 1.1, 1.1], [0.6, 0.8, 0.2]);
  addMesh('Cone', cone, '#f0b33f', [3.1, 0.0, -0.2], [1, 1, 1], [0.0, -0.75, 0.0], true);
  addMesh('Icosahedron', ico, '#42a5f5', [0.0, 0.35, -3.0], [1.15, 1.15, 1.15], [0.45, 0.35, 0.55], true);
  addMesh('BackBox', box, '#6ee7a8', [-1.8, -0.25, -3.8], [0.9, 1.4, 0.9], [0.0, 0.45, 0.0]);
  addMesh('BackSphere', sphere, '#c084fc', [2.1, -0.2, -3.7], [0.85, 0.85, 0.85], [0.35, 0.1, 0.0]);

  function updatePasses(): void {
    const color = hexToRgba(params.color);
    const hiddenColor = hexToRgba(params.hiddenColor);
    outlinePass.visibleEdgeColor = [color[0], color[1], color[2]];
    outlinePass.hiddenEdgeColor = [hiddenColor[0], hiddenColor[1], hiddenColor[2]];
    outlinePass.edgeStrength = params.strength;
    outlinePass.edgeThickness = params.thickness;
    outlinePass.edgeGlow = params.glow;
    postProcess.setPasses(params.enabled
      ? (params.fxaa ? [outlinePass, fxaaPass] : [outlinePass])
      : (params.fxaa ? [fxaaPass] : []));
  }

  const gui = new dat.GUI({ width: 300 });
  gui.add(params, 'enabled').name('Outline').onChange(updatePasses);
  gui.add(params, 'fxaa').name('FXAA').onChange(updatePasses);
  gui.addColor(params, 'color').name('Visible Color').onChange(updatePasses);
  gui.addColor(params, 'hiddenColor').name('Hidden Color').onChange(updatePasses);
  gui.add(params, 'strength', 0.01, 10, 0.01).name('Edge Strength').onChange(updatePasses);
  gui.add(params, 'thickness', 1, 4, 0.1).name('Edge Thickness').onChange(updatePasses);
  gui.add(params, 'glow', 0, 1, 0.01).name('Edge Glow').onChange(updatePasses);
  gui.add(params, 'rotate').name('Rotate');
  updatePasses();

  engine.on('update', ({ detail: { time, delta } }) => {
    const t = time * 0.001;
    if (params.rotate) {
      for (const item of moving) {
        if (item.spin[0] === 0 && item.spin[1] === 0 && item.spin[2] === 0) continue;
        const rotation = mat4.multiply(
          mat4.rotationX(t * item.spin[0]),
          mat4.multiply(
            mat4.rotationY(t * item.spin[1]),
            mat4.rotationZ(t * item.spin[2]),
          ),
        ) as Float32Array;
        item.transform.localMatrix = mat4.multiply(item.base, rotation) as Float32Array;
      }
    }
    world.update(time, delta);
  });

  engine.run();
}

main().catch(console.error);
