import * as dat from 'dat.gui';
import { BasicMaterial, Camera3D, CartesianTransform3D, ColorSRGB, Entity, Geometry3D, Mesh3D, OrbitControl, SphericalTransform3D, HaiyueEngine, createBox3D, createSphere3D } from '@haiyue/engine';
import { MeshHelper } from '@haiyue/engine/components';
import { createInlineCSGWorkerClient } from '@haiyue/engine/geometry';
import type {
  CSGOperation,
  CSGPreparedGeometry,
  CSGWorker,
} from '@haiyue/engine/geometry';

const params = {
  operation: 'subtract' as CSGOperation,
  wireframe: true,
  showSphere: true,
  boxX: 0,
  boxY: 0,
  boxZ: 0,
  sphereX: 0.75,
  sphereY: 0.35,
  sphereZ: 0.35,
};

function getTriangleCount(geometry: Geometry3D): number {
  return geometry.indices ? Math.floor(geometry.indices.length / 3) : Math.floor(geometry.positions.length / 9);
}

function translationMatrix(x: number, y: number, z: number): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

interface ResponsivenessProbe {
  arm(): void;
}

function createResponsivenessProbe(): ResponsivenessProbe | null {
  if (!new URLSearchParams(location.search).has('csgE2E')) return null;
  let armed = false;
  let lastFrame = performance.now();
  let maxFrameGap = 0;
  let frameCount = 0;
  let longTaskCount = 0;

  const publish = (): void => {
    document.documentElement.dataset.csgProbe = armed ? 'armed' : 'warming';
    document.documentElement.dataset.csgFrameCount = String(frameCount);
    document.documentElement.dataset.csgMaxFrameGapMs = maxFrameGap.toFixed(2);
    document.documentElement.dataset.csgLongTaskCount = String(longTaskCount);
  };
  const frame = (now: number): void => {
    if (armed) {
      maxFrameGap = Math.max(maxFrameGap, now - lastFrame);
      frameCount++;
      publish();
    }
    lastFrame = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (
    typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes.includes('longtask')
  ) {
    const observer = new PerformanceObserver(list => {
      if (!armed) return;
      longTaskCount += list.getEntries().filter(entry => entry.duration > 50).length;
      publish();
    });
    observer.observe({ type: 'longtask' });
  }

  publish();
  return {
    arm(): void {
      requestAnimationFrame(() => requestAnimationFrame(now => {
        maxFrameGap = 0;
        frameCount = 0;
        longTaskCount = 0;
        lastFrame = now;
        armed = true;
        publish();
      }));
    },
  };
}

function createE2EBurstButton(run: () => void): HTMLButtonElement | null {
  if (!new URLSearchParams(location.search).has('csgE2E')) return null;
  const button = document.createElement('button');
  button.id = 'csg-e2e-burst';
  button.type = 'button';
  button.disabled = true;
  button.textContent = 'Run 20× CSG burst';
  button.style.cssText = 'position:fixed;left:16px;top:16px;z-index:10';
  button.addEventListener('click', run);
  document.body.append(button);
  return button;
}

async function main() {
  const responsivenessProbe = createResponsivenessProbe();
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const operationEl = document.getElementById('operation')!;
  const trianglesEl = document.getElementById('triangles')!;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.03, g: 0.05, b: 0.08, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  const spherical = new SphericalTransform3D({
    radius: 8,
    theta: Math.PI / 4,
    phi: Math.PI / 3,
    target: [0, 0, 0],
  });
  camera.addComponent(spherical);

  const scene = engine.createScene({
    name: 'CSG',
    camera,
    render3D: { msaaSamples: 4 },
    pipelineLabel: 'CSG.render',
  });
  const world = scene.world;

  new OrbitControl(canvas, spherical, { minRadius: 3, maxRadius: 18 });

  const material = new BasicMaterial({ color: new ColorSRGB(0.22, 0.72, 1.0) });
  const previewMaterial = new BasicMaterial({
    color: new ColorSRGB(1.0, 0.58, 0.18, 0.22),
    blending: 'normal',
    depthWrite: false,
  });

  const boxSource = createBox3D({ width: 3.2, height: 3.2, depth: 3.2 });
  const sphereSource = createSphere3D({ radius: 1.9, widthSegments: 20, heightSegments: 12 });

  const resultEntity = new Entity('CSG Result');
  resultEntity.addComponent(new CartesianTransform3D());
  const resultMesh = new Mesh3D(boxSource, material);
  resultEntity.addComponent(resultMesh);
  let helper = new MeshHelper({ mode: 'wireframe', color: [0.75, 0.92, 1.0, 1.0] });
  resultEntity.addComponent(helper);
  world.addEntity(resultEntity);

  const cutterEntity = new Entity('Cutter Preview');
  const cutterTransform = new CartesianTransform3D({
    position: [params.sphereX, params.sphereY, params.sphereZ],
  });
  cutterEntity.addComponent(cutterTransform);
  cutterEntity.addComponent(new Mesh3D(sphereSource, previewMaterial));
  world.addEntity(cutterEntity);

  let workerClient: CSGWorker | null = null;
  let baseHandle: CSGPreparedGeometry | null = null;
  let cutterHandle: CSGPreparedGeometry | null = null;
  let requestGeneration = 0;

  function syncWireframe(): void {
    if (params.wireframe) {
      if (!resultEntity.getComponent(MeshHelper)) {
        helper = new MeshHelper({ mode: 'wireframe', color: [0.75, 0.92, 1.0, 1.0] });
        resultEntity.addComponent(helper);
      }
    } else {
      resultEntity.removeComponent(MeshHelper);
    }
  }

  function syncCutterPreview(): void {
    cutterTransform.setPosition(params.sphereX, params.sphereY, params.sphereZ);
    cutterEntity.disabled = !params.showSphere;
  }

  async function updateCSG(): Promise<void> {
    const generation = ++requestGeneration;
    document.documentElement.dataset.csgRequestedGeneration = String(generation);
    syncCutterPreview();
    operationEl.textContent = params.operation.charAt(0).toUpperCase() + params.operation.slice(1);
    if (!workerClient || !baseHandle || !cutterHandle) {
      trianglesEl.textContent = 'Preparing worker…';
      return;
    }

    const start = performance.now();
    trianglesEl.textContent = 'Computing in worker…';
    try {
      const geometry = await workerClient.compute(
        {
          geometry: baseHandle,
          transform: translationMatrix(params.boxX, params.boxY, params.boxZ),
        },
        {
          geometry: cutterHandle,
          transform: translationMatrix(params.sphereX, params.sphereY, params.sphereZ),
        },
        params.operation,
      );
      if (generation !== requestGeneration) return;
      resultMesh.geometry = geometry;
      const duration = performance.now() - start;
      trianglesEl.textContent = `${getTriangleCount(geometry)} triangles · ${duration.toFixed(2)}ms round-trip`;
      document.documentElement.dataset.csgWorker = 'ready';
      document.documentElement.dataset.csgGeneration = String(generation);
      const diagnostics = workerClient.diagnostics;
      document.documentElement.dataset.csgComputeRequests = String(diagnostics.computeRequestsPosted);
      document.documentElement.dataset.csgSuperseded = String(diagnostics.supersededComputeCount);
      document.documentElement.dataset.csgPending = String(diagnostics.pendingRequestCount);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (generation !== requestGeneration) return;
      document.documentElement.dataset.csgWorker = 'error';
      trianglesEl.textContent = error instanceof Error ? error.message : String(error);
      console.error(error);
    }
  }

  const gui = new dat.GUI({ width: 300 });
  gui.add(params, 'operation', ['union', 'subtract', 'intersect']).name('Operation').onChange(() => { void updateCSG(); });
  gui.add(params, 'wireframe').name('Wireframe').onChange(syncWireframe);
  gui.add(params, 'showSphere').name('Show sphere').onChange(syncCutterPreview);

  const boxFolder = gui.addFolder('Box Position');
  boxFolder.add(params, 'boxX', -2.5, 2.5, 0.05).name('X').onChange(() => { void updateCSG(); });
  boxFolder.add(params, 'boxY', -2.5, 2.5, 0.05).name('Y').onChange(() => { void updateCSG(); });
  boxFolder.add(params, 'boxZ', -2.5, 2.5, 0.05).name('Z').onChange(() => { void updateCSG(); });
  boxFolder.open();

  const sphereFolder = gui.addFolder('Sphere Position');
  sphereFolder.add(params, 'sphereX', -2.5, 2.5, 0.05).name('X').onChange(() => { void updateCSG(); });
  sphereFolder.add(params, 'sphereY', -2.5, 2.5, 0.05).name('Y').onChange(() => { void updateCSG(); });
  sphereFolder.add(params, 'sphereZ', -2.5, 2.5, 0.05).name('Z').onChange(() => { void updateCSG(); });
  sphereFolder.open();

  const burstButton = createE2EBurstButton(() => {
    for (let index = 0; index < 20; index++) {
      params.sphereX = -1.5 + index * 0.15;
      void updateCSG();
    }
  });
  syncCutterPreview();
  document.documentElement.dataset.csgWorker = 'preparing';
  engine.switchScene(scene);
  engine.run();

  try {
    const geometryModuleUrl = new URL('../../engine/dist/geometry.js', import.meta.url).href;
    workerClient = createInlineCSGWorkerClient(geometryModuleUrl, { name: 'haiyue-csg' });
    [baseHandle, cutterHandle] = await Promise.all([
      workerClient.prepareGeometry(boxSource),
      workerClient.prepareGeometry(sphereSource),
    ]);
    await updateCSG();
    if (burstButton) burstButton.disabled = false;
    responsivenessProbe?.arm();
  } catch (error) {
    document.documentElement.dataset.csgWorker = 'unavailable';
    trianglesEl.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }

  window.addEventListener('beforeunload', () => workerClient?.dispose(), { once: true });
}

main().catch(console.error);
