import { mat4, vec3 } from 'wgpu-matrix';
import {
  HaiyueEngine, Entity, Camera3D, CartesianTransform3D, SphericalTransform3D,
  Mesh3D, createSphere3D, PbrMaterial, BasicMaterial, OrbitControl, DirectionalLight,
} from '@haiyue/engine';
import { AmbientLight } from '@haiyue/engine/lighting';
import { createCylinder3D } from '@haiyue/engine/geometry';
import { Ray, type RayHit, type RayIntersectMeshOptions } from '@haiyue/engine/math';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const output = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
const formatCount = (value: number) => value.toLocaleString('en-US');
const formatTime = (ms: number) => ms < 0.001 ? '< 0.001 ms' : `${ms.toFixed(3)} ms`;
const geometry = createSphere3D({ radius: 1.6, widthSegments: 192, heightSegments: 96 });
const worldMatrix = mat4.identity() as Float32Array;
const triangleCount = (geometry.indices?.length ?? geometry.positions.length / 3) / 3;
const rayCount = 6000;
const colors = { on: [0.25, 1, 0.72, 1], off: [1, 0.61, 0.25, 1] } as const;
type Measurement = { ms: number; hit: RayHit | null; stats: NonNullable<RayIntersectMeshOptions['stats']> };

function measure(ray: Ray, useBVH: boolean): Measurement {
  const stats = { triangleTests: 0, boundingBoxTests: 0 };
  // Ray reuses hit buffers. Separate output storage preserves both results for comparison.
  const result: RayHit = { distance: 0, point: new Float32Array(3), normal: new Float32Array(3) };
  const options = { useBVH, stats };
  const start = performance.now();
  const hit = ray.intersectMesh(geometry, worldMatrix, options, result);
  return { ms: performance.now() - start, hit, stats };
}

async function main(): Promise<void> {
  const engine = new HaiyueEngine({
    canvas, clearColor: { r: 0.025, g: 0.04, b: 0.065, a: 1 }, msaaSamples: 4,
  });
  const events = new AbortController();
  let disposed = false;
  let frame = 0;
  let benchmarkFrame = 0;
  let orbit: OrbitControl | undefined;
  const dispose = () => {
    disposed = true;
    events.abort();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(benchmarkFrame);
    orbit?.dispose();
    engine.destroy();
  };
  window.addEventListener('pagehide', dispose, { once: true, signal: events.signal });
  try {
    await engine.init();
    if (disposed) return;
    const cameraComponent = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 });
    const cameraTransform = new SphericalTransform3D({ radius: 7, theta: 0, phi: Math.PI / 2, target: [0, 0, 0] });
    const camera = new Entity('Camera').addComponent(cameraComponent).addComponent(cameraTransform);
    const scene = engine.createScene({ name: 'RaycastBVH', camera, render3D: true, pipelineLabel: 'RaycastBVH.render' });
    orbit = new OrbitControl(canvas, cameraTransform, { minRadius: 4, maxRadius: 12 });
    scene.add(new Entity('HighPolySphere')
      .addComponent(new CartesianTransform3D())
      .addComponent(new Mesh3D(geometry, new PbrMaterial({ baseColor: [0.16, 0.4, 0.7, 1], metallic: 0.12, roughness: 0.55 }))));
    scene.add(new Entity('Key light').addComponent(new DirectionalLight({ direction: [-0.6, -0.8, -1], intensity: 3 })));
    scene.add(new Entity('Ambient light').addComponent(new AmbientLight({ intensity: 0.6 })));

    // Thin cylinders share the surface's depth pass and remain visible from every viewing angle.
    const lineGeometry = createCylinder3D({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8 });
    const normalMaterial = new BasicMaterial({ color: colors.on });
    const makeLine = (name: string, material: BasicMaterial) => {
      const transform = new CartesianTransform3D();
      const mesh = new Mesh3D(lineGeometry, material);
      mesh.disabled = true;
      scene.add(new Entity(name).addComponent(transform).addComponent(mesh));
      return { transform, mesh };
    };
    const normalLine = makeLine('Hit face normal', normalMaterial);
    const tangentMaterial = new BasicMaterial({ color: [1, 1, 1, 1] });
    const tangentLines = [makeLine('Hit tangent', tangentMaterial), makeLine('Hit bitangent', tangentMaterial)];
    const placeLine = (line: ReturnType<typeof makeLine>, point: number[], axis: ArrayLike<number>, length: number, radius: number) => {
      line.transform.setPosition(...point as [number, number, number]);
      line.transform.setScale(radius, length, radius);
      line.transform.setRotation(Math.acos(Math.max(-1, Math.min(1, axis[1]!))), Math.atan2(axis[0]!, axis[2]!), 0);
    };
    const markerTransform = new CartesianTransform3D();
    const markerMaterial = new BasicMaterial({ color: colors.on });
    const marker = new Mesh3D(createSphere3D({ radius: 0.035, widthSegments: 12, heightSegments: 8 }), markerMaterial);
    marker.disabled = true;
    scene.add(new Entity('Hit point').addComponent(markerTransform).addComponent(marker));
    // A small tangent cross makes even a normal pointing straight at the camera legible.

    let lastComparison: { on: Measurement; off: Measurement } | undefined;
    let clickCount = 0;
    let ready = false;
    const updateMarker = () => {
      const mode = modeSelect.value === 'off' ? 'off' : 'on';
      const hit = lastComparison?.[mode].hit;
      normalLine.mesh.disabled = marker.disabled = !hit;
      for (const line of tangentLines) line.mesh.disabled = !hit;
      normalMaterial.color = markerMaterial.color = colors[mode];
      output('normal-label', `${mode === 'on' ? '绿色 · BVH 开启' : '橙色 · BVH 关闭'} · 三角形面法线`);
      if (!hit) return;
      const point = Array.from(hit.point);
      const normal = Array.from(hit.normal);
      placeLine(normalLine, point.map((v, i) => v + normal[i]! * 0.425), normal, 0.85, 0.012);
      markerTransform.setPosition(point[0]!, point[1]!, point[2]!);
      const tangent = vec3.normalize(vec3.cross(normal, Math.abs(normal[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
      const bitangent = vec3.cross(normal, tangent);
      [tangent, bitangent].forEach((axis, i) => {
        placeLine(tangentLines[i]!, point.map((v, j) => v + normal[j]! * 0.008), axis, 0.18, 0.006);
      });
      output('hit-point', point.map(v => v.toFixed(3)).join(', '));
      output('hit-normal', normal.map(v => v.toFixed(3)).join(', '));
    };

    const pick = (ndcX: number, ndcY: number, preview = false) => {
      if (!ready) return;
      cameraComponent.updateAspect(canvas.clientWidth / canvas.clientHeight);
      cameraTransform.updateWorldMatrix();
      const view = mat4.inverse(cameraTransform.worldMatrix);
      const inverseViewProjection = mat4.inverse(mat4.multiply(cameraComponent.projectionMatrix, view)) as Float32Array;
      const ray = new Ray().setFromCamera(ndcX, ndcY, cameraTransform.eyePosition, inverseViewProjection);
      // Alternate measurement order to avoid always favoring the second run.
      const firstBVH = clickCount % 2 === 0;
      const first = measure(ray, firstBVH);
      const second = measure(ray, !firstBVH);
      const on = firstBVH ? first : second;
      const off = firstBVH ? second : first;
      lastComparison = { on, off };
      for (const [id, value] of Object.entries(lastComparison)) {
        output(`${id}-time`, formatTime(value.ms));
        output(`${id}-triangles`, formatCount(value.stats.triangleTests));
        output(`${id}-boxes`, formatCount(value.stats.boundingBoxTests));
        (document.getElementById(`${id}-bar`) as HTMLElement).style.width = `${100 * value.stats.triangleTests / triangleCount}%`;
      }
      const same = on.hit && off.hit
        ? Math.abs(on.hit.distance - off.hit.distance) < 1e-4 && vec3.distance(on.hit.point, off.hit.point) < 1e-4
          && vec3.distance(on.hit.normal, off.hit.normal) < 1e-3
        : on.hit === off.hit;
      output('click-status', `${preview ? '初始演示 · 点击球体重新测量' : `点击 #${++clickCount}`} · ${on.hit ? '命中' : '未命中'}`);
      output('agreement', same ? '两种模式命中结果一致' : '两种模式命中结果不一致');
      output('reduction', off.stats.triangleTests > 0
        ? `少检测 ${(100 * (1 - on.stats.triangleTests / off.stats.triangleTests)).toFixed(2)}% 的三角形`
        : '射线被物体包围盒排除，无需检测三角形');
      if (!on.hit) { output('hit-point', '—'); output('hit-normal', '—'); }
      updateMarker();
      document.body.dataset.ready = 'true';
      document.body.dataset.hit = String(Boolean(on.hit));
      document.body.dataset.agreement = String(same);
    };

    let pointerStart: { x: number; y: number; id: number } | undefined;
    canvas.addEventListener('pointerdown', event => {
      pointerStart = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined;
    }, { signal: events.signal });
    canvas.addEventListener('pointerup', event => {
      const start = pointerStart;
      pointerStart = undefined;
      if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const rect = canvas.getBoundingClientRect();
      pick(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height);
    }, { signal: events.signal });
    canvas.addEventListener('pointercancel', () => { pointerStart = undefined; }, { signal: events.signal });
    modeSelect.addEventListener('change', updateMarker, { signal: events.signal });

    runButton.addEventListener('click', () => {
      runButton.disabled = true;
      let index = 0;
      const totals = { on: { ms: 0, hits: 0 }, off: { ms: 0, hits: 0 } };
      const batch = () => {
        if (disposed) return;
        const end = Math.min(index + 24, rayCount);
        for (; index < end; index++) {
          const x = ((index % 100) / 99 - 0.5) * 2.7;
          const y = (Math.floor(index / 100) / 59 - 0.5) * 2.7;
          const ray = new Ray();
          ray.origin.set([x, y, 5]);
          ray.direction.set(vec3.normalize([-x * 0.14, -y * 0.14, -5]));
          for (const mode of index % 2 ? ['off', 'on'] as const : ['on', 'off'] as const) {
            const start = performance.now();
            const hit = ray.intersectMesh(geometry, worldMatrix, { useBVH: mode === 'on' });
            totals[mode].ms += performance.now() - start;
            if (hit) totals[mode].hits++;
          }
        }
        runButton.textContent = `批量测试 ${Math.round(index / rayCount * 100)}%`;
        if (index < rayCount) { benchmarkFrame = requestAnimationFrame(batch); return; }
        output('bvh-on', `${totals.on.ms.toFixed(2)} ms · ${totals.on.hits} 命中`);
        output('bvh-off', `${totals.off.ms.toFixed(2)} ms · ${totals.off.hits} 命中`);
        output('speedup', totals.on.ms > 0 ? `${(totals.off.ms / totals.on.ms).toFixed(2)}×` : '低于计时精度');
        runButton.textContent = '运行 6,000 条射线测试';
        runButton.disabled = false;
      };
      benchmarkFrame = requestAnimationFrame(batch);
    }, { signal: events.signal });

    output('triangles', formatCount(triangleCount));
    engine.switchScene(scene);
    engine.run();
    // Show the scene before building the cached BVH. Construction is measured separately.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const warmupRay = new Ray();
        warmupRay.origin.set([0.4, 0.3, 5]);
        warmupRay.direction.set([0, 0, -1]);
        const start = performance.now();
        warmupRay.intersectMesh(geometry, worldMatrix, { useBVH: true });
        output('build-time', formatTime(performance.now() - start));
        ready = true;
        pick(0.23, 0.16, true);
        runButton.disabled = false;
      });
    });
  } catch (error) {
    if (disposed) return;
    dispose();
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  document.body.dataset.ready = 'error';
  output('click-status', `初始化失败：${error instanceof Error ? error.message : String(error)}`);
});
