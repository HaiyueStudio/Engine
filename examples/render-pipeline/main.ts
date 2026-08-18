import {
  AmbientLight,
  BasicMaterial,
  BlinnPhongMaterial,
  BlinnPhongRenderSystem,
  Camera3D,
  CartesianTransform3D,
  ColorSRGB,
  DirectionalLight,
  Entity,
  GuiButton,
  GuiRoot,
  GuiSystem,
  Mesh3D,
  OrbitControl,
  Render3DSystem,
  RenderIntegration,
  SphericalTransform3D,
  HaiyueEngine,
  World,
  createBox3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine/experimental';

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.035, g: 0.045, b: 0.07, a: 1 },
  });
  await engine.init();

  const world = new World('RenderPipelineExample');

  const cameraTransform = new SphericalTransform3D({
    radius: 9,
    theta: Math.PI / 5,
    phi: Math.PI / 3.6,
    target: [0, 0.5, 0],
  });
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  cameraEntity.addComponent(cameraTransform);
  world.addEntity(cameraEntity);
  new OrbitControl(canvas, cameraTransform, { minRadius: 4, maxRadius: 24, rotateSpeed: 0.7 });

  const basicBoxTransform = new CartesianTransform3D({ position: [-1.8, 0.35, 0], rotation: [0, 0, 0] });
  const basicBox = new Entity('Basic renderer box');
  basicBox.addComponent(basicBoxTransform);
  basicBox.addComponent(new Mesh3D(
    createBox3D({ width: 1.2, height: 1.2, depth: 1.2 }),
    new BasicMaterial({ color: new ColorSRGB(0.2, 0.62, 1.0, 1) }),
  ));
  world.addEntity(basicBox);

  const litSphere = new Entity('Blinn-Phong sphere');
  litSphere.addComponent(new CartesianTransform3D({ position: [1.55, 0.45, 0] }));
  litSphere.addComponent(new Mesh3D(
    createSphere3D({ radius: 0.75, widthSegments: 32, heightSegments: 18 }),
    new BlinnPhongMaterial({
      ambient: [0.05, 0.04, 0.02],
      diffuse: [1.0, 0.62, 0.22],
      specular: [1.0, 0.95, 0.82],
      shininess: 128,
    }),
  ));
  world.addEntity(litSphere);

  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -0.35, 0] }));
  ground.addComponent(new Mesh3D(
    createPlane3D({ width: 7, height: 4 }),
    new BlinnPhongMaterial({
      ambient: [0.03, 0.035, 0.04],
      diffuse: [0.35, 0.38, 0.45],
      specular: [0.06, 0.06, 0.07],
      shininess: 16,
    }),
  ));
  world.addEntity(ground);

  const ambient = new Entity('Ambient light');
  ambient.addComponent(new AmbientLight({ color: [1, 1, 1], intensity: 0.12 }));
  world.addEntity(ambient);

  const sun = new Entity('Directional light');
  sun.addComponent(new DirectionalLight({
    color: [1, 0.94, 0.84],
    intensity: 1.3,
    direction: [-0.45, -1, -0.3],
  }));
  world.addEntity(sun);

  const render3D = new Render3DSystem(engine, cameraEntity, { loadOp: 'clear', priority: 0 });
  const blinnPhong = new BlinnPhongRenderSystem(engine, cameraEntity, { priority: -1, render3DSystem: render3D });
  const guiEntity = new Entity('Pipeline HUD');
  const guiRoot = new GuiRoot();
  guiRoot.add(new GuiButton({
    id: 'pipeline-label',
    x: 18,
    y: 18,
    width: 370,
    height: 32,
    text: 'RenderPipeline.execute(): Render3D + BlinnPhong + GUI',
  }));
  guiEntity.addComponent(guiRoot);
  world.addEntity(guiEntity);

  const guiSystem = new GuiSystem(engine, { loadOp: 'load' });
  world.addSystem(render3D);
  world.addSystem(blinnPhong);
  world.addSystem(guiSystem);

  const renderIntegration = new RenderIntegration(engine, { label: 'RenderPipelineExample.update' });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration
    .register(render3D, { pass: 'shared' })
    .register(guiSystem, { pass: 'shared' });

  engine.on('update', ({ detail: { time, delta } }) => {
    basicBoxTransform.rotation[1] = time * 0.001;
    world.update(time, delta);
  });
  engine.run();
}

main().catch(error => {
  console.error(error);
});
