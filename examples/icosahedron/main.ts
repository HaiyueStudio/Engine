import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { MeshHelper } from '@haiyue/engine/components';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { createIcosahedron3D } from '@haiyue/engine/geometry';
import { mat4 } from 'wgpu-matrix';

interface DemoParams {
  radius: number;
  detail: number;
  wireframe: boolean;
  wireWidth: number;
  rotate: boolean;
  color: string;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLDivElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.035, g: 0.04, b: 0.055, a: 1 },
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'IcosahedronGeometry',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: {
        radius: 5.2,
        theta: Math.PI * 0.18,
        phi: Math.PI * 0.34,
        target: [0, 0, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'IcosahedronGeometry.render',
  });
  const spherical = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  new OrbitControl(canvas, spherical, { minRadius: 2.5, maxRadius: 18, rotateSpeed: 0.8 });

  const params: DemoParams = {
    radius: 1.25,
    detail: 1,
    wireframe: true,
    wireWidth: 2,
    rotate: true,
    color: '#2e9edb',
  };

  const material = new BasicMaterial({ color: ColorSRGB.fromHex(params.color) });

  const transform = new CartesianTransform3D();
  const mesh = new Mesh3D(createIcosahedron3D({ radius: params.radius, detail: params.detail }), material);
  const helper = new MeshHelper({ mode: 'wireframe', color: [0.9, 0.98, 1, 0.65], lineWidth: params.wireWidth });

  const entity = new Entity('Icosahedron');
  entity.addComponent(transform);
  entity.addComponent(mesh);
  entity.addComponent(helper);
  scene.add(entity);

  function updateGeometry(): void {
    const detail = Math.max(0, Math.min(6, Math.floor(params.detail)));
    params.detail = detail;
    mesh.geometry = createIcosahedron3D({ radius: params.radius, detail });
    material.color = ColorSRGB.fromHex(params.color);
    helper.color = new ColorSRGB(0.9, 0.98, 1, params.wireframe ? 0.65 : 0);
    helper.lineWidth = params.wireWidth;
    stats.innerHTML = [
      `radius: ${params.radius.toFixed(2)}`,
      `detail: ${detail}`,
      `vertices: ${mesh.geometry.vertexCount}`,
      `triangles: ${mesh.geometry.indexCount / 3}`,
    ].join('<br />');
  }

  const gui = new dat.GUI({ width: 280 });
  gui.add(params, 'radius', 0.2, 2.5, 0.01).name('Radius').onChange(updateGeometry);
  gui.add(params, 'detail', 0, 6, 1).name('Detail').onChange(updateGeometry);
  gui.addColor(params, 'color').name('Color').onChange(updateGeometry);
  gui.add(params, 'wireframe').name('Wireframe').onChange(updateGeometry);
  gui.add(params, 'wireWidth', 1, 12, 1).name('Wire Width').onChange(updateGeometry);
  gui.add(params, 'rotate').name('Rotate');

  updateGeometry();

  engine.switchScene(scene);
  engine.on('update', ({ detail: { time } }) => {
    if (params.rotate) {
      const yaw = time * 0.00035;
      const pitch = time * 0.00018;
      transform.localMatrix = mat4.multiply(
        mat4.rotationY(yaw),
        mat4.rotationX(pitch),
      ) as Float32Array;
    }
  });

  engine.run();
}

main().catch(console.error);
