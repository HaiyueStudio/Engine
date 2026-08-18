import * as dat from 'dat.gui';
import { BasicMaterial, Camera3D, Entity, Mesh3D, OrbitControl, SphericalTransform3D, HaiyueEngine, World, createBox3D, createSphere3D } from '@haiyue/engine';
import { Render3DSystem } from '@haiyue/engine/systems';
import { Transform3D } from '@haiyue/engine/components';
import { RenderIntegration } from '@haiyue/engine/experimental';
import { PostProcessRenderFeature, SobelPass } from '@haiyue/engine/postprocess';
import { mat4 } from 'wgpu-matrix';

interface GuiParams {
  enabled: boolean;
  edgeOnly: boolean;
  strength: number;
  threshold: number;
  blend: number;
  edgeColor: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const n = Number.parseInt(value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function addMesh(
  world: World,
  geometry: ReturnType<typeof createBox3D>,
  color: [number, number, number],
  matrix: Float32Array,
): Entity {
  const entity = new Entity('SobelMesh');
  const transform = new Transform3D();
  transform.localMatrix = matrix;
  entity.addComponent(transform);
  entity.addComponent(new Mesh3D(geometry, new BasicMaterial({ color })));
  world.addEntity(entity);
  return entity;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.9, g: 0.92, b: 0.94, a: 1 },
  });
  await engine.init();

  const world = new World('SobelPostprocess');

  const cameraTransform = new SphericalTransform3D({
    radius: 18,
    theta: Math.PI * 0.2,
    phi: Math.PI * 0.32,
    target: [0, 0.6, 0],
  });
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  camera.addComponent(cameraTransform);
  world.addEntity(camera);
  new OrbitControl(canvas, cameraTransform, { minRadius: 6, maxRadius: 40 });

  const box = createBox3D({ width: 2, height: 2, depth: 2 });
  const tallBox = createBox3D({ width: 1.2, height: 4.5, depth: 1.2 });
  const sphere = createSphere3D({ radius: 1.25, widthSegments: 48, heightSegments: 32 });

  const animated: Array<{ entity: Entity; base: [number, number, number]; speed: number }> = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const radius = i % 2 === 0 ? 6 : 4;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const geometry = i % 3 === 0 ? tallBox : box;
    const color: [number, number, number] = i % 3 === 0
      ? [0.96, 0.45, 0.18]
      : i % 3 === 1
        ? [0.12, 0.45, 0.92]
        : [0.14, 0.72, 0.42];
    const entity = addMesh(world, geometry, color, mat4.translation([x, 0, z]) as Float32Array);
    animated.push({ entity, base: [x, 0, z], speed: 0.6 + i * 0.06 });
  }

  const sphereEntity = addMesh(
    world,
    sphere,
    [0.92, 0.92, 0.96],
    mat4.translation([0, 1.2, 0]) as Float32Array,
  );

  const sobelPass = new SobelPass({
    strength: 1.8,
    threshold: 0.07,
    blend: 0.9,
    edgeColor: [0.02, 0.02, 0.025],
  });
  const renderSystem = new Render3DSystem(engine, camera, { loadOp: 'clear' });
  const postProcess = new PostProcessRenderFeature(renderSystem, [sobelPass]);
  world.addSystem(renderSystem);
  world.addSystem(postProcess);
  const renderIntegration = new RenderIntegration(engine, { label: 'SobelPostprocess.render' });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration.registerAll(world);

  const params: GuiParams = {
    enabled: true,
    edgeOnly: false,
    strength: sobelPass.strength,
    threshold: sobelPass.threshold,
    blend: sobelPass.blend,
    edgeColor: '#050506',
  };

  const syncPass = () => {
    sobelPass.edgeOnly = params.edgeOnly;
    sobelPass.strength = params.strength;
    sobelPass.threshold = params.threshold;
    sobelPass.blend = params.blend;
    sobelPass.edgeColor = hexToRgb(params.edgeColor);
    postProcess.setPasses(params.enabled ? [sobelPass] : []);
  };

  const gui = new dat.GUI({ width: 280 });
  gui.add(params, 'enabled').name('Sobel').onChange(syncPass);
  gui.add(params, 'edgeOnly').name('Edge only').onChange(syncPass);
  gui.add(params, 'strength', 0, 6, 0.01).name('Strength').onChange(syncPass);
  gui.add(params, 'threshold', 0, 0.5, 0.001).name('Threshold').onChange(syncPass);
  gui.add(params, 'blend', 0, 1, 0.01).name('Blend').onChange(syncPass);
  gui.addColor(params, 'edgeColor').name('Edge color').onChange(syncPass);
  syncPass();

  engine.on('update', ({ detail: { time, delta } }) => {
    const t = time * 0.001;
    for (const item of animated) {
      const transform = item.entity.getComponent(Transform3D)!;
      transform.localMatrix = mat4.multiply(
        mat4.translation([
          item.base[0],
          0.5 + Math.sin(t * item.speed) * 0.4,
          item.base[2],
        ]),
        mat4.rotationY(t * item.speed),
      ) as Float32Array;
    }

    const sphereTransform = sphereEntity.getComponent(Transform3D)!;
    sphereTransform.localMatrix = mat4.multiply(
      mat4.translation([0, 1.2 + Math.sin(t * 1.3) * 0.25, 0]),
      mat4.rotationY(t * 0.8),
    ) as Float32Array;

    world.update(time, delta);
  });

  engine.run();
}

main().catch(console.error);
