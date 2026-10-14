// Public runtime facades plus the explicitly experimental multi-view scheduler.
import { HaiyueEngine, Entity, CartesianTransform3D, Camera3D, Mesh3D, PbrMaterial,
  Geometry3D, createBox3D, createPlane3D } from '../../engine/dist/index.js';
import { PointLight, AmbientLight, DirectionalLight } from '../../engine/dist/lighting.js';
import { ColorLinear } from '../../engine/dist/color.js';
import { RenderView, RenderViewFamily } from '../../engine/dist/core.js';
import { PlanarMirror } from '../../engine/dist/components.js';
import { RttEngine } from '../../engine/dist/rtt.js';
import { getSceneRenderIntegration } from '../../engine/dist/experimental.js';
import { createDeferredLightingProfile } from '../../engine/dist/experimental/renderer.js';
import { GtaoPass, TaaPass, GaussianBlurPass } from '../../engine/dist/postprocess.js';
import { getEngineDiagnosticsSnapshot } from '../../engine/dist/diagnostics.js';
import { mat4 } from 'wgpu-matrix';
import { createDeferredRoomFixture } from './deferred-room-fixture.mjs';

export async function createProductionScene(canvas, spec, diagnostics = {}) {
  const engine = new HaiyueEngine({ canvas, devicePixelRatio: spec.resolution[0] / 1280,
    msaaSamples: 1, timestampQuery: false, diagnostics: { enabled: true, ...diagnostics },
    gpu: { requestAdapter: () => navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat() } });
  let profile, rtt;
  try {
    await engine.init();
    const camera = new Entity('production-camera').addComponent(new Camera3D({ fov: Math.PI / 3, near: .1, far: 100 }))
      .addComponent(new CartesianTransform3D());
    const scene = engine.createScene({ name: spec.id, camera, render3D: { renderProfile: 'batched', toneMapping: 'reinhard' }, render2D: false, gui: false });
    engine.switchScene(scene);
    const data = createDeferredRoomFixture({ count: spec.lights });
    const materials = data.materials.map(m => new PbrMaterial({ baseColor: new ColorLinear(...m.color), metallic: m.metallic, roughness: m.roughness }));
    const box = createBox3D();
    function mesh(name, geometry, material, position) {
      const entity = new Entity(name).addComponent(new CartesianTransform3D({ position })).addComponent(new Mesh3D(geometry, material));
      scene.add(entity); return entity;
    }
    data.boxes.forEach((b, i) => mesh(`room-box-${i}`, box, materials[b.material], b.position));
    mesh('floor', createPlane3D({ width: 24, height: 24, normal: 'y' }), materials[6], [0, 0, 0]);
    // Inward single-sided walls match the frozen room: the orbit camera is
    // outside the room, so exterior wall backs must not occlude its contents.
    for (const [positions, normal] of [
      [[[-12,0,12],[-12,0,-12],[-12,8,-12],[-12,8,12]],[1,0,0]],
      [[[12,0,-12],[12,0,12],[12,8,12],[12,8,-12]],[-1,0,0]],
      [[[-12,0,-12],[12,0,-12],[12,8,-12],[-12,8,-12]],[0,0,1]],
      [[[12,0,12],[-12,0,12],[-12,8,12],[12,8,12]],[0,0,-1]],
    ]) {
      mesh('wall', new Geometry3D({ positions: new Float32Array(positions.flat()), normals: new Float32Array(Array.from({length:4},()=>normal).flat()),
        indices: new Uint32Array([0,1,2,0,2,3]) }), materials[6], [0,0,0]);
    }
    scene.add(new Entity('ambient').addComponent(new AmbientLight({ intensity: .1 })));
    scene.add(new Entity('directional').addComponent(new DirectionalLight({ direction: data.directional.direction, intensity: .5 })));
    const lights = data.lights.map((light, i) => {
      const transform = new CartesianTransform3D({ position: light.position });
      scene.add(new Entity(`light-${i}`).addComponent(transform).addComponent(new PointLight({ color: new ColorLinear(...light.color), intensity: 2, range: 2 })));
      return transform;
    });
    const cameras = [camera];
    const family = new RenderViewFamily();
    for (let i = 0; i < spec.views; i++) {
      if (i > 0) { const c = new Entity(`camera-${i}`).addComponent(new Camera3D({ fov: Math.PI/3, near: .1, far: 100 })).addComponent(new CartesianTransform3D()); cameras.push(c); scene.add(c); }
      const viewport = spec.views === 4 ? { x: i % 2 * 640, y: Math.floor(i / 2) * 360, width: 640, height: 360, minDepth: 0, maxDepth: 1 } : null;
      family.add(new RenderView({ key: `display-${i}`, camera: cameras[i], target: engine.renderTarget, viewport,
        scissor: viewport ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } : null, loadOp: i ? 'load' : 'clear' }));
    }
    if (spec.effect === 'rtt') {
      rtt = new RttEngine(engine, 640, 360, undefined, 'production-external-rtt', null, 'rgba16float');
      family.add(new RenderView({ key: 'external-rtt', camera, target: rtt }));
    }
    getSceneRenderIntegration(scene).setExecuteOptions({ viewFamily: family });
    if (spec.effect === 'gtao') scene.render3DSystem.passes.push(new GtaoPass());
    if (spec.effect === 'taa-blur') {
      mesh('transparent', createBox3D({ width: 4, height: 3, depth: .4 }), new PbrMaterial({ baseColor: [.8,.2,.3,.35], alphaMode: 'blend', roughness: .4 }), [0,2,2]);
      scene.render3DSystem.passes.push(new TaaPass(), new GaussianBlurPass());
    }
    if (spec.effect === 'mirror') {
      const geometry = new Geometry3D({ positions: new Float32Array([-5,0,0, 5,0,0, 5,6,0, -5,6,0]),
        normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) });
      mesh('mirror', geometry, materials[6], [0,0,-10]).addComponent(new PlanarMirror({ width: 640, height: 360, maxBounces: 1, localNormal: [0,0,1] }));
    }
    if (spec.algorithm !== 'forward') profile = await createDeferredLightingProfile(scene.render3DSystem, engine, { mode: spec.algorithm });
    function update(time) {
      const t = time / 1000;
      lights.forEach((transform, i) => { const light = data.lights[i]; transform.setTranslation(light.position[0] + Math.sin(t + light.phase), light.position[1], light.position[2] + Math.cos(t + light.phase)); });
      cameras.forEach((c, i) => { const a = t * Math.PI / 2 + i * Math.PI / 2; c.getComponent(CartesianTransform3D).setMatrix(mat4.cameraAim([18*Math.cos(a),6,18*Math.sin(a)],[0,2,0],[0,1,0])); });
    }
    update(0);
    return { engine, update, snapshot: () => ({ resources: getEngineDiagnosticsSnapshot(engine).gpuResources.totals,
      lighting: profile?.snapshot() ?? null, width: canvas.width, height: canvas.height, views: family.size,
      boxes: data.boxes.length, lights: lights.length, effects: scene.render3DSystem.passes.map(p => p.constructor.name) }),
      dispose() { profile?.dispose(); engine.destroy(); rtt?.destroy(); },
      cleanup: () => getEngineDiagnosticsSnapshot(engine).gpuResources.totals };
  } catch (error) { profile?.dispose(); engine.destroy(); rtt?.destroy(); throw error; }
}
