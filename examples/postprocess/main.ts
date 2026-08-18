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
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { CustomPass, FxaaPass, GaussianBlurPass, GrayscalePass, OutlinePass } from '@haiyue/engine/postprocess';
import { OutlineTarget } from '@haiyue/engine/components';
import { mat4 } from 'wgpu-matrix';

// ────────────────────────────────────────────────────────────────────────────
// Post-processing demo
//   Press  1  → no post-processing
//   Press  2  → FXAA
//   Press  3  → Gaussian blur (radius 5)
//   Press  4  → FXAA + Gaussian blur
//   Press  5  → Custom chromatic-aberration pass
//   Press  7  → depth/normal outline
// ────────────────────────────────────────────────────────────────────────────

// Custom pass: chromatic aberration (RGB channel splits)
const CHROMATIC_ABERRATION_WGSL = /* wgsl */`
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let dims      = textureDimensions(srcTex, 0);
  let texelSize = vec2<f32>(1.0 / f32(dims.x), 1.0 / f32(dims.y));
  let offset    = texelSize * 3.0;                 // 3-texel channel split
  let r = textureSample(srcTex, srcSampler, in.uv + vec2( offset.x, 0.0)).r;
  let g = textureSample(srcTex, srcSampler, in.uv).g;
  let b = textureSample(srcTex, srcSampler, in.uv - vec2( offset.x, 0.0)).b;
  return vec4<f32>(r, g, b, 1.0);
}
`;

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.04, g: 0.04, b: 0.08, a: 1 },
  });
  await engine.init();

  const world = new World('Postprocess');

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camSph = new SphericalTransform3D({
    radius: 18,
    theta:  Math.PI * 0.18,
    phi:    Math.PI * 0.32,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  camEntity.addComponent(camSph);
  world.addEntity(camEntity);

  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 60 });

  // ── Scene geometry ─────────────────────────────────────────────────────────
  const boxGeo    = createBox3D({ width: 1.4, height: 1.4, depth: 1.4 });
  const sphereGeo = createSphere3D({ radius: 0.8, widthSegments: 32, heightSegments: 24 });

  const palette: Array<[number, number, number]> = [
    [0.95, 0.30, 0.30],
    [0.30, 0.85, 0.40],
    [0.30, 0.50, 1.00],
    [0.95, 0.75, 0.20],
    [0.75, 0.30, 0.95],
    [0.25, 0.90, 0.90],
  ];

  function addMesh(geo: ReturnType<typeof createBox3D>, color: [number, number, number], pos: [number, number, number]) {
    const e = new Entity('Mesh');
    const t = new Transform3D();
    t.localMatrix = mat4.translation(pos) as Float32Array;
    e.addComponent(t);
    e.addComponent(new Mesh3D(geo, new BasicMaterial({ color })));
    world.addEntity(e);
    return e;
  }

  // Ring of boxes + central sphere
  const RING = 8;
  const RING_R = 6;
  const spinningEntities: Array<{ entity: Entity; baseAngle: number }> = [];

  for (let i = 0; i < RING; i++) {
    const angle = (i / RING) * Math.PI * 2;
    const x = Math.cos(angle) * RING_R;
    const z = Math.sin(angle) * RING_R;
    const col = palette[i % palette.length] ?? [1, 1, 1];
    const e = addMesh(boxGeo, col, [x, 0, z]);
    spinningEntities.push({ entity: e, baseAngle: angle });
  }

  // Central sphere
  const sphereE = new Entity('Sphere');
  const sphereT = new Transform3D();
  sphereT.localMatrix = mat4.identity() as Float32Array;
  sphereE.addComponent(sphereT);
  sphereE.addComponent(new Mesh3D(sphereGeo, new BasicMaterial({ color: [0.9, 0.9, 0.95] })));
  sphereE.addComponent(new OutlineTarget());
  world.addEntity(sphereE);

  // ── Post-processing passes ─────────────────────────────────────────────────
  const fxaaPass      = new FxaaPass();
  const blurPass      = new GaussianBlurPass({ radius: 5, sigma: 2.5 });
  const grayscalePass = new GrayscalePass();
  const customPass    = new CustomPass({ label: 'ChromaticAberration', fragmentCode: CHROMATIC_ABERRATION_WGSL });
  const outlinePass   = new OutlinePass({
    visibleEdgeColor: [1, 1, 1],
    hiddenEdgeColor: [0.1, 0.04, 0.02],
    edgeStrength: 3,
    edgeThickness: 1,
    edgeGlow: 0,
  });

  // ── Render system + explicit post-process feature ──────────────────────────
  const renderSystem = new Render3DSystem(engine, camEntity, { loadOp: 'clear' });
  const postProcess = new PostProcessRenderFeature(renderSystem, [fxaaPass]);
  world.addSystem(renderSystem);
  world.addSystem(postProcess);
  const renderIntegration = new RenderIntegration(engine, { label: 'Postprocess.render' });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration.registerAll(world);

  // ── Keyboard controls ──────────────────────────────────────────────────────
  const label = document.getElementById('effect-label')!;

  function setMode(mode: number) {
    switch (mode) {
      case 1:
        postProcess.setPasses([]);
        label.textContent = 'No post-processing';
        break;
      case 2:
        postProcess.setPasses([fxaaPass]);
        label.textContent = 'FXAA';
        break;
      case 3:
        postProcess.setPasses([blurPass]);
        label.textContent = 'Gaussian Blur  (radius 5)';
        break;
      case 4:
        postProcess.setPasses([fxaaPass, blurPass]);
        label.textContent = 'FXAA → Gaussian Blur';
        break;
      case 5:
        postProcess.setPasses([customPass]);
        label.textContent = 'Custom: Chromatic Aberration';
        break;
      case 6:
        postProcess.setPasses([grayscalePass]);
        label.textContent = 'Grayscale';
        break;
      case 7:
        postProcess.setPasses([outlinePass, fxaaPass]);
        label.textContent = 'Outline → FXAA';
        break;
    }
  }

  setMode(2); // FXAA by default

  window.addEventListener('keydown', (e) => {
    const n = parseInt(e.key);
    if (n >= 1 && n <= 7) setMode(n);
  });

  // ── Render loop ────────────────────────────────────────────────────────────
  engine.on('update', ({ detail: { time, delta } }) => {
    const t = time * 0.001;

    // Rotate boxes around the ring
    for (const { entity, baseAngle } of spinningEntities) {
      const transform = entity.getComponent(Transform3D)!;
      const angle     = baseAngle + t * 0.4;
      const x = Math.cos(angle) * RING_R;
      const z = Math.sin(angle) * RING_R;
      transform.localMatrix = mat4.multiply(
        mat4.translation([x, 0, z]),
        mat4.rotationY(t * 1.2),
      ) as Float32Array;
    }

    // Pulse sphere
    const s = 1 + 0.12 * Math.sin(t * 1.8);
    sphereT.localMatrix = mat4.scaling([s, s, s]) as Float32Array;

    world.update(time, delta);
  });

  engine.run();
}

main().catch(console.error);
