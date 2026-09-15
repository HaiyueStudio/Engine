import {
  HaiyueEngine, Entity, Camera3D, CartesianTransform3D, SphericalTransform3D,
  Mesh3D, PbrMaterial, BasicMaterial, DirectionalLight, OrbitControl, createSphere3D,
} from '@haiyue/engine';
import { AmbientLight } from '@haiyue/engine/lighting';
import { Ray } from '@haiyue/engine/math';
import { createRaycastBVHInspector, type RaycastBVHTrace } from '@haiyue/engine/experimental/diagnostics';
import { mat4, vec3 } from 'wgpu-matrix';
import { BVHHelper, COLORS, Overlay, testedTrianglePositions } from './BVHHelper';
import { createExtrudedKnot, PATH_RINGS, SHAPE_EDGES } from './geometry';
import { drawLeafPreview } from './LeafPreview';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string | number) => { get(id).textContent = String(value); };
const count = (value: number) => value.toLocaleString('en-US');
const sourceCanvas = get<HTMLCanvasElement>('source');
const observerCanvas = get<HTMLCanvasElement>('observer');
const freezeButton = get<HTMLButtonElement>('freeze');
const replayButton = get<HTMLButtonElement>('replay');
const nextButton = get<HTMLButtonElement>('next');
const stepSlider = get<HTMLInputElement>('step');
const depthSlider = get<HTMLInputElement>('depth');
const background = get<HTMLInputElement>('background');
const rejected = get<HTMLInputElement>('rejected');
const identity = mat4.identity() as Float32Array;

async function main(): Promise<void> {
  const engines = [sourceCanvas, observerCanvas].map(canvas => new HaiyueEngine({
    canvas, msaaSamples: 4, clearColor: { r: 0.02, g: 0.035, b: 0.055, a: 1 },
  }));
  const sourceEngine = engines[0]!, observerEngine = engines[1]!;
  const events = new AbortController();
  let disposed = false, startupFrame = 0;
  let orbit: OrbitControl | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    cancelAnimationFrame(startupFrame);
    orbit?.dispose();
    for (const engine of engines) engine.destroy();
  };
  window.addEventListener('pagehide', dispose, { once: true, signal: events.signal });
  const fail = (error: unknown) => {
    if (disposed) return;
    dispose();
    document.body.dataset.ready = 'error';
    text('status', `初始化失败：${error instanceof Error ? error.message : String(error)}`);
    console.error(error);
  };

  try {
    await Promise.all(engines.map(engine => engine.init()));
    if (disposed) return;
    const sourceCamera = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 60 });
    const sourceTransform = new CartesianTransform3D({ position: [0, 0, 10.5] });
    const observerTransform = new SphericalTransform3D({ radius: 17, theta: Math.PI * 0.23, phi: Math.PI * 0.35, target: [0, 0, 2.4] });
    const cameras = [
      new Entity('Ray source camera').addComponent(sourceCamera).addComponent(sourceTransform),
      new Entity('BVH observer camera').addComponent(new Camera3D({ fov: Math.PI / 4, near: 0.1, far: 100 })).addComponent(observerTransform),
    ];
    const scenes = engines.map((engine, i) => {
      const scene = engine.createScene({ name: i ? 'BVH observation' : 'Ray source', camera: cameras[i]!, render3D: true });
      scene.add(new Entity('Key light').addComponent(new DirectionalLight({ direction: [-0.6, -0.8, -1], intensity: 3 })));
      scene.add(new Entity('Ambient light').addComponent(new AmbientLight({ intensity: 0.7 })));
      engine.switchScene(scene);
      engine.run();
      return scene;
    });
    const observerScene = scenes[1]!;
    orbit = new OrbitControl(observerCanvas, observerTransform, { minRadius: 5, maxRadius: 30, rotateSpeed: 0.7 });
    text('status', '正在挤出几何体并构建 BVH…');

    const setup = () => {
      if (disposed) return;
      try {
        const extrusionStart = performance.now();
        const geometry = createExtrudedKnot();
        text('extrusion-time', `${(performance.now() - extrusionStart).toFixed(1)} ms`);
        const material = new PbrMaterial({ baseColor: [0.16, 0.32, 0.48, 1], metallic: 0.15, roughness: 0.48 });
        const triangleOverlays = scenes.map(scene => {
          scene.add(new Entity('High density extruded knot').addComponent(new CartesianTransform3D()).addComponent(new Mesh3D(geometry, material)));
          return new Overlay(scene, 'Triangles actually tested in accepted leaves', COLORS.leaf);
        });
        const bvhStart = performance.now();
        const inspector = createRaycastBVHInspector(geometry);
        const snapshot = inspector.getSnapshot();
        text('build-time', `${(performance.now() - bvhStart).toFixed(1)} ms`);
        const helper = new BVHHelper(observerScene, snapshot);
        const rayOverlay = new Overlay(observerScene, 'Mouse ray', COLORS.ray);
        const sourceHelper = new Overlay(observerScene, 'Fixed ray source camera helper', COLORS.ray);
        const cameraEdges: number[] = [];
        const corners = [[-0.25, -0.25, 9.9], [0.25, -0.25, 9.9], [0.25, 0.25, 9.9], [-0.25, 0.25, 9.9]];
        corners.forEach((corner, i) => cameraEdges.push(0, 0, 10.5, ...corner, ...corner, ...corners[(i + 1) % 4]!));
        sourceHelper.setSegments(cameraEdges, 0.009);
        const hitMarkers = scenes.map(scene => {
          const transform = new CartesianTransform3D();
          const entity = new Entity('Closest hit').addComponent(transform)
            .addComponent(new Mesh3D(createSphere3D({ radius: 0.01, widthSegments: 10, heightSegments: 6 }), new BasicMaterial({ color: [1, 1, 1, 1] })));
          entity.disabled = true;
          scene.add(entity);
          return { entity, transform };
        });
        const triangleCount = snapshot.triangleIndices.length / 3;
        text('triangles', count(triangleCount));
        text('nodes', count(snapshot.nodes.length));
        text('leaves', count(snapshot.nodes.filter(node => node.left === null).length));
        text('tree-depth', Math.max(...snapshot.nodes.map(node => node.depth)));
        text('extrusion', `${PATH_RINGS} 路径环 × ${SHAPE_EDGES} 截面边`);
        document.body.dataset.ready = 'true';
        document.body.dataset.triangles = String(triangleCount);
        for (const button of [freezeButton, replayButton, nextButton, get<HTMLButtonElement>('sample')]) button.disabled = false;

        let lastTrace: RaycastBVHTrace | null = null;
        let frozen = false, replaying = false, nextReplayAt = 0, shownStep = 0, queryCount = 0;
        let pending: { x: number; y: number } | null = null;
        let lastPointer: { x: number; y: number } | null = null;
        const ray = new Ray();
        const viewProjection = mat4.identity() as Float32Array;
        const updateProjection = () => {
          sourceCamera.updateAspect(sourceCanvas.clientWidth / sourceCanvas.clientHeight);
          sourceTransform.updateWorldMatrix();
          mat4.multiply(sourceCamera.projectionMatrix, mat4.inverse(sourceTransform.worldMatrix), viewProjection);
        };
        const setFrozen = (value: boolean) => {
          frozen = value;
          freezeButton.textContent = value ? '恢复鼠标跟随' : '冻结当前射线';
          freezeButton.setAttribute('aria-pressed', String(value));
          document.body.dataset.frozen = String(value);
        };
        const showStep = (step: number) => {
          if (!lastTrace) return;
          shownStep = Math.min(step, lastTrace.steps.length);
          stepSlider.value = String(shownStep);
          const leaves = helper.show(lastTrace, shownStep);
          const detailLeaf = leaves.at(-1);
          drawLeafPreview(get<HTMLCanvasElement>('leaf-preview'), geometry, lastTrace.snapshot, detailLeaf);
          text('leaf-detail', detailLeaf ? `叶子 #${detailLeaf.id} · ${detailLeaf.end - detailLeaf.start} 个已检测三角形` : '等待到达叶子');
          const positions = testedTrianglePositions(geometry, lastTrace.snapshot, leaves);
          for (const overlay of triangleOverlays) overlay.setPositions(positions);
          text('shown-triangles', count(positions.length / 9));
          text('shown-leaves', leaves.length);
          text('progress', `${shownStep} / ${lastTrace.steps.length}`);
          const last = lastTrace.steps[shownStep - 1];
          if (!last) text('current-node', lastTrace.broadPhaseHit ? '等待访问根节点' : '物体包围盒未通过，未进入 BVH');
          else {
            const node = lastTrace.snapshot.nodes[last.nodeId]!;
            const state = !last.accepted ? '相离或被更近命中剪枝' : node.left === null ? `叶子 · 检测 ${node.end - node.start} 个三角形` : '内部节点 · 包围盒通过';
            text('current-node', `#${node.id} / 第 ${node.depth} 层 / ${state}`);
          }
          for (const marker of hitMarkers) {
            marker.entity.disabled = !lastTrace.hit || shownStep < lastTrace.steps.length;
            if (lastTrace.hit) marker.transform.setPosition(lastTrace.hit.point[0]!, lastTrace.hit.point[1]!, lastTrace.hit.point[2]!);
          }
          document.body.dataset.step = String(shownStep);
          document.body.dataset.shownTriangles = String(positions.length / 9);
        };
        const query = (pointer: { x: number; y: number }) => {
          updateProjection();
          ray.setFromCamera(pointer.x, pointer.y, sourceTransform.position, mat4.inverse(viewProjection) as Float32Array);
          const started = performance.now();
          lastTrace = inspector.trace(ray, identity);
          const elapsed = performance.now() - started;
          replaying = false;
          const end = vec3.add(ray.origin, vec3.mulScalar(ray.direction, 20));
          rayOverlay.setSegments([...ray.origin, ...end], 0.019);
          const aim = get('aim');
          aim.style.left = `${(pointer.x + 1) * 50}%`;
          aim.style.top = `${(1 - pointer.y) * 50}%`;
          text('query-time', elapsed < 0.001 ? '< 0.001 ms' : `${elapsed.toFixed(3)} ms`);
          text('box-tests', count(lastTrace.boundingBoxTests));
          text('triangle-tests', count(lastTrace.triangleTests));
          text('saved', `${(100 * (1 - lastTrace.triangleTests / triangleCount)).toFixed(2)}%`);
          text('status', `${lastTrace.hit ? '命中物体' : '未命中物体'} · 移动左侧鼠标可更新射线`);
          stepSlider.max = String(lastTrace.steps.length);
          stepSlider.disabled = lastTrace.steps.length === 0;
          replayButton.disabled = nextButton.disabled = lastTrace.steps.length === 0;
          document.body.dataset.query = String(++queryCount);
          document.body.dataset.hit = String(Boolean(lastTrace.hit));
          document.body.dataset.triangleTests = String(lastTrace.triangleTests);
          showStep(lastTrace.steps.length);
        };
        const sample = () => {
          updateProjection();
          const triangle = Math.floor(triangleCount * 0.28);
          const point = [0, 0, 0];
          for (let corner = 0; corner < 3; corner++) {
            const vertex = geometry.indices![triangle * 3 + corner]!;
            for (let axis = 0; axis < 3; axis++) point[axis]! += geometry.positions[vertex * 3 + axis]! / 3;
          }
          const projected = vec3.transformMat4(point, viewProjection);
          pending = lastPointer = { x: projected[0]!, y: projected[1]! };
          setFrozen(false);
          replaying = false;
        };
        sourceCanvas.addEventListener('pointermove', event => {
          const rect = sourceCanvas.getBoundingClientRect();
          lastPointer = { x: 2 * (event.clientX - rect.left) / rect.width - 1, y: 1 - 2 * (event.clientY - rect.top) / rect.height };
          if (!frozen) pending = lastPointer;
        }, { signal: events.signal });
        freezeButton.addEventListener('click', () => {
          setFrozen(!frozen);
          replaying = false;
          pending = frozen ? null : lastPointer;
        }, { signal: events.signal });
        replayButton.addEventListener('click', () => {
          if (!lastTrace?.steps.length) return;
          setFrozen(true);
          pending = null;
          showStep(0);
          replaying = true;
          nextReplayAt = performance.now() + 150;
        }, { signal: events.signal });
        nextButton.addEventListener('click', () => {
          setFrozen(true); replaying = false; pending = null;
          showStep(shownStep >= (lastTrace?.steps.length ?? 0) ? 0 : shownStep + 1);
        }, { signal: events.signal });
        stepSlider.addEventListener('input', () => {
          setFrozen(true); replaying = false; pending = null;
          showStep(Number(stepSlider.value));
        }, { signal: events.signal });
        const configureHelpers = () => {
          text('depth-value', depthSlider.value);
          helper.configure(Number(depthSlider.value), background.checked, rejected.checked);
        };
        for (const control of [depthSlider, background, rejected]) control.addEventListener('input', configureHelpers, { signal: events.signal });
        get('sample').addEventListener('click', sample, { signal: events.signal });
        observerEngine.on('update', () => {
          if (disposed) return;
          if (pending && !frozen) { const pointer = pending; pending = null; query(pointer); }
          if (replaying && performance.now() >= nextReplayAt) {
            showStep(shownStep + 1);
            nextReplayAt = performance.now() + 150;
            if (shownStep === lastTrace?.steps.length) replaying = false;
          }
        });
        sourceEngine.on('resize', () => { if (!frozen) pending = lastPointer; });
        sample();
      } catch (error) { fail(error); }
    };
    // Paint both views before optional CPU-heavy geometry/BVH generation.
    startupFrame = requestAnimationFrame(() => { startupFrame = requestAnimationFrame(setup); });
  } catch (error) { fail(error); }
}

void main();
