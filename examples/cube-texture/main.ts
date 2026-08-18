import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { Easing, TweenManager } from '@haiyue/engine/tween';

async function main() {
  // ---- Engine ----
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    msaaSamples: 4,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  // ---- Camera entity ----
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  const cameraTransform = new CartesianTransform3D({ position: [0, 0, 5] });
  cameraEntity.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'CubeTexture',
    camera: cameraEntity,
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'CubeTexture.render',
  });

  // ---- Box entity ----
  const boxEntity = new Entity('Box');
  const boxTransform = new CartesianTransform3D({ position: [0, 0, 0] });
  boxEntity.addComponent(boxTransform);

  // Generate a simple checker texture as an ImageBitmap
  const checkerBitmap = await makeCheckerBitmap(256, 256, 16);

  boxEntity.addComponent(
    new Mesh3D(
      createBox3D({ width: 1.5, height: 1.5, depth: 1.5 }),
      new BasicMaterial({
        color: new ColorSRGB(1, 1, 1, 1),
        texture: checkerBitmap,
      }),
    ),
  );

  scene.add(boxEntity);

  // ---- Tween: continuous rotation ----
  const tweenManager = new TweenManager();

  // Animate rotation using a proxy object; set each frame
  const rotProxy = { y: 0 };
  tweenManager
    .create(rotProxy, { duration: 4000, easing: Easing.linear, repeat: 'infinite' })
    .to({ y: Math.PI * 2 });

  const rotProxyX = { x: 0 };
  tweenManager
    .create(rotProxyX, { duration: 7000, easing: Easing.linear, repeat: 'infinite' })
    .to({ x: Math.PI * 2 });

  // ---- Main loop ----
  engine.switchScene(scene);
  engine.on('update', ({ detail: { time, delta } }) => {
    tweenManager.update(time, delta);
    boxTransform.setRotation(rotProxyX.x, rotProxy.y, 0);
  });

  engine.run();
}

/** Create a checker pattern ImageBitmap */
async function makeCheckerBitmap(
  width: number,
  height: number,
  tileSize: number,
): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const even = ((x / tileSize) + (y / tileSize)) % 2 === 0;
      ctx.fillStyle = even ? '#6699cc' : '#ffffff';
      ctx.fillRect(x, y, tileSize, tileSize);
    }
  }
  return createImageBitmap(canvas);
}

main().catch(console.error);
