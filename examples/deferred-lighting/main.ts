import { Camera3D, CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D, type Geometry3D } from '@haiyue/engine';
import { AmbientLight, PointLight } from '@haiyue/engine/lighting';
import { ColorLinear } from '@haiyue/engine/color';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { createDeferredLightingProfile, type DeferredLightingProfile, type DeferredLightingDebugChannel } from '@haiyue/engine/experimental/renderer';
import { GaussianBlurPass, GrayscalePass, GtaoPass } from '@haiyue/engine/postprocess';
import { mountFrameGraphPanel } from './framegraph';
import { mat4, vec3 } from 'wgpu-matrix';
import { LIGHT_COUNTS, lightPosition, makeLights, parseCount, parsePath, type Vec3 } from './model';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);

async function main() {
  const params = new URLSearchParams(location.search), regression = params.get('regression') === '1';
  const canvas = $<HTMLCanvasElement>('canvas'), overlay = $<HTMLCanvasElement>('overlay'), debug = $<HTMLCanvasElement>('debug');
  const overlayContext = overlay.getContext('2d')!, debugContext = debug.getContext('2d')!;
  const powerPreference = params.get('powerPreference') === 'low-power' ? 'low-power' : 'high-performance';
  const engine = new HaiyueEngine({ canvas,
    ...(regression ? { gpu: { requestAdapter: () => navigator.gpu.requestAdapter({ powerPreference }), getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat() } } : {}), renderProfile: 'diagnostic', msaaSamples: 1, diagnostics: { enabled: true }, clearColor: { r: .015, g: .023, b: .04, a: 1 },
    devicePixelRatio: () => Math.min(1, 1280 / Math.max(canvas.clientWidth, 1), 720 / Math.max(canvas.clientHeight, 1)) });
  const lifetime = new AbortController();
  let destroyed = false, generation = 0, pending: AbortController | undefined, profile: DeferredLightingProfile | undefined;
  let control: OrbitControl | undefined, observer: ResizeObserver | undefined;
  let framegraph: ReturnType<typeof mountFrameGraphPanel> | undefined;
  let hudTimer: ReturnType<typeof setInterval> | undefined;
  let latestGpu: { ms: number; at: number; frame: number } | undefined;
  let time = 0, frameDelta = 0, lastDebug = 0, debugBusy = false, readyFrames = 0;
  const errors: string[] = [], disabled = new Set<number>();
  function dispose() {
    if (destroyed) return;
    destroyed = true; generation++; clearInterval(hudTimer); lifetime.abort(); pending?.abort(); observer?.disconnect(); control?.destroy(); framegraph?.dispose(); profile?.dispose(); engine.destroy();
    document.body.dataset.renderStatus = 'disposed';
  }
  window.addEventListener('pagehide', dispose, { signal: lifetime.signal });
  try { await engine.init(); } catch (error) { dispose(); throw error; }
  if (destroyed) { engine.destroy(); return; }
  engine.device.addEventListener('uncapturederror', event => { errors.push(event.error.message); fail(event.error.message); }, { signal: lifetime.signal });
  const scene = engine.createScene({ name: 'Deferred light laboratory',
    camera: { camera3D: { fov: Math.PI / 3, near: .1, far: 120 }, orbit: { radius: 29, theta: .2, phi: .32 * Math.PI, target: [0, 1, -1] } },
    render3D: { renderProfile: 'batched', toneMapping: 'reinhard' }, render2D: false, gui: false });
  engine.switchScene(scene);
  framegraph = mountFrameGraphPanel(scene.render3DSystem!, lifetime.signal);
  const effects = { blur: new GaussianBlurPass(), secondBlur: new GaussianBlurPass({ radius: 2 }), gray: new GrayscalePass(), ao: new GtaoPass(), occlusion: new GtaoPass({ displayMode: 'occlusion' }) };
  const camera = scene.cameraEntity.getComponent(Camera3D)!, orbit = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  control = new OrbitControl(canvas, orbit, { minRadius: 8, maxRadius: 48 });
  const material = (color: Vec3, metallic = .1, roughness = .65) => new PbrMaterial({ baseColor: new ColorLinear(...color), metallic, roughness });
  function mesh(name: string, geometry: Geometry3D, surface: PbrMaterial, position: Vec3) {
    const entity = new Entity(name).addComponent(new CartesianTransform3D({ position })).addComponent(new Mesh3D(geometry, surface)); scene.add(entity); return entity;
  }
  const neutral = material([.38, .42, .49]);
  mesh('Floor', createPlane3D({ width: 26, height: 24, normal: 'y' }), neutral, [0, 0, 0]);
  mesh('Back wall', createPlane3D({ width: 26, height: 7, normal: 'z' }), material([.25, .3, .4]), [0, 3.5, -12]);
  mesh('Left wall', createPlane3D({ width: 24, height: 7, normal: 'x' }), neutral, [-13, 3.5, 0]);
  const box = createBox3D({ width: 1.5, height: 1.7, depth: 1.5 }), sphere = createSphere3D({ radius: .85, widthSegments: 24, heightSegments: 16 });
  for (let z = 0; z < 4; z++) for (let x = 0; x < 7; x++) {
    mesh(`PBR ${x}:${z}`, (x + z) % 2 ? box : sphere, material([.5, .52, .55], x / 7, .15 + z * .22), [x * 3 - 9, .86, z * 4 - 8]);
  }
  mesh('Transparent PBR', createSphere3D({ radius: 1.35, widthSegments: 32, heightSegments: 20 }),
    new PbrMaterial({ baseColor: [.15, .7, .9, .3], metallic: .15, roughness: .2, alphaMode: 'blend' }), [3, 1.4, 7]);
  mesh('Emissive reference', createBox3D({ width: 2, height: .12, depth: 1 }),
    new PbrMaterial({ baseColor: [.1, .1, .1, 1], emissiveFactor: [.04, .2, .25] }), [-3, .08, 7]);
  scene.add(new Entity('Ambient').addComponent(new AmbientLight({ intensity: .08 })));
  const definitions = makeLights(); definitions[8]!.position = [6, 1.8, 4];
  const lights = definitions.map((definition, index) => {
    const transform = new CartesianTransform3D(), light = new PointLight({ color: new ColorLinear(...definition.color), intensity: 2, range: 3 });
    const entity = new Entity(`Point ${index + 1}`).addComponent(transform).addComponent(light); entity.disabled = true; scene.add(entity);
    return { entity, transform, light, position: definition.position };
  });
  select('count').innerHTML = LIGHT_COUNTS.map(count => `<option value="${count}">${count} 盏${count >= 512 ? ' · 压力' : ''}</option>`).join('');
  select('count').value = String(parseCount(params.get('count'))); select('path').value = parsePath(params.get('path'));
  input('motion').checked = !regression; input('selected').value = String(Math.min(9, Number(select('count').value)));
  select('distribution').value = params.get('overlap') === '1' ? 'overlap' : 'sparse';
  if (select('distribution').value === 'overlap') input('range').value = '30';
  function updateLights() {
    const count = Number(select('count').value), selected = Number(input('selected').value) - 1, overlap = select('distribution').value === 'overlap';
    const intensity = Number(input('intensity').value), range = Number(input('range').value);
    for (let i = 0; i < lights.length; i++) {
      const record = lights[i]!, definition = definitions[i]!;
      record.entity.disabled = i >= count || disabled.has(i) || (input('solo').checked && i !== selected);
      if (i >= count) continue;
      record.position = lightPosition(definition.position, definition.phase, time, overlap);
      record.transform.setTranslation(...record.position); record.light.intensity = intensity; record.light.range = range;
    }
  }
  function syncSelection() {
    const count = Number(select('count').value); input('selected').max = String(count);
    const selected = Math.max(1, Math.min(count, Math.round(Number(input('selected').value) || 1)));
    input('selected').value = String(selected); input('enabled').checked = !disabled.has(selected - 1); updateLights();
  }
  async function switchPath() {
    framegraph?.clear();
    const ticket = ++generation; pending?.abort(); pending = new AbortController(); profile?.dispose(); profile = undefined;
    scene.render3DSystem!.setRenderProfile('batched');
    latestGpu = undefined; document.body.dataset.renderStatus = 'loading'; $('status').textContent = '正在准备渲染路径…'; readyFrames = 0; debug.hidden = true;
    const path = parsePath(select('path').value);
    try {
      if (path !== 'forward') {
        const next = await createDeferredLightingProfile(scene.render3DSystem!, engine, { mode: path, signal: pending.signal, forceCulling: select('display').value === 'tiles' });
        if (destroyed || ticket !== generation) { next.dispose(); return; }
        profile = next;
      }
      if (ticket === generation && !destroyed) { document.body.dataset.renderStatus = 'ready'; engine.run(); updateHud(); }
    } catch (error) {
      if (destroyed || ticket !== generation || pending.signal.aborted) return;
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const on = (id: string, event: string, action: () => void) => $(id).addEventListener(event, action, { signal: lifetime.signal });
  on('path', 'change', () => { select('display').value = 'render'; void switchPath(); });
  on('fg-effects', 'change', () => {
    const mode = select('fg-effects').value;
    scene.render3DSystem!.passes = mode === 'ao-blur' ? [effects.ao, effects.blur, effects.secondBlur] : mode === 'cull' ? [effects.gray, effects.blur, effects.occlusion] : [];
    framegraph?.clear();
  });
  on('count', 'change', syncSelection); on('selected', 'change', syncSelection);
  on('enabled', 'change', () => { const i = Number(input('selected').value) - 1; if (input('enabled').checked) disabled.delete(i); else disabled.add(i); updateLights(); });
  for (const id of ['solo', 'intensity', 'range']) on(id, 'input', updateLights);
  on('distribution', 'change', () => { input('range').value = select('distribution').value === 'overlap' ? '30' : '3'; updateLights(); });
  on('display', 'change', () => { debug.hidden = true; if (select('path').value === 'tiled') void switchPath(); else updateHud(); });
  on('ninth', 'click', () => { select('count').value = '9'; input('selected').value = '9'; input('motion').checked = false; select('distribution').value = 'sparse'; input('range').value = '4'; time = 0; disabled.delete(8); input('solo').checked = true; syncSelection(); });
  on('reset', 'click', () => { time = 0; disabled.clear(); select('count').value = '128'; select('distribution').value = 'sparse'; input('range').value = '3'; input('intensity').value = '2'; input('solo').checked = false; input('motion').checked = !regression; orbit.radius = 29; orbit.theta = .2; orbit.phi = .32 * Math.PI; orbit.setTarget(0, 1, -1); syncSelection(); });
  let helperViewProjection = mat4.identity();
  function project(position: Vec3): [number, number] | null {
    const point = vec3.transformMat4(position, helperViewProjection);
    return point[2]! < 0 || point[2]! > 1 ? null : [(point[0]! * .5 + .5) * overlay.width, (.5 - point[1]! * .5) * overlay.height];
  }
  function drawHelpers() {
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) { overlay.width = canvas.width; overlay.height = canvas.height; }
    overlayContext.clearRect(0, 0, overlay.width, overlay.height);
    if (!input('helpers').checked || select('display').value !== 'render') return;
    helperViewProjection = mat4.multiply(camera.projectionMatrix, mat4.inverse(orbit.worldMatrix));
    const selected = Number(input('selected').value) - 1;
    lights.slice(0, Number(select('count').value)).forEach((record, index) => {
      const point = project(record.position); if (!point) return;
      const color = definitions[index]!.color;
      overlayContext.fillStyle = record.entity.disabled ? '#536175' : `rgb(${color.map(c => Math.round(c * 255)).join(',')})`;
      overlayContext.beginPath(); overlayContext.arc(...point, index === selected ? 5 : 2.3, 0, Math.PI * 2); overlayContext.fill();
      if (index !== selected) return;
      overlayContext.fillStyle = '#fff'; overlayContext.font = '13px system-ui'; overlayContext.fillText(`#${index + 1}${record.entity.disabled ? ' · OFF' : ''}`, point[0] + 10, point[1]);
      overlayContext.strokeStyle = '#ffffff80'; overlayContext.lineWidth = 1;
      for (let axis = 0; axis < 3; axis++) { overlayContext.beginPath(); let started = false;
        for (let step = 0; step <= 64; step++) { const angle = step / 64 * Math.PI * 2, position = [...record.position] as Vec3;
          position[(axis + 1) % 3]! += Math.cos(angle) * record.light.range; position[(axis + 2) % 3]! += Math.sin(angle) * record.light.range;
          const p = project(position); if (!p) { started = false; continue; } if (started) overlayContext.lineTo(...p); else { overlayContext.moveTo(...p); started = true; }
        } overlayContext.stroke();
      }
    });
  }
  async function drawDebug() {
    const channel = select('display').value;
    if (channel === 'render' || !profile || debugBusy) { if (channel === 'render' || !profile) debug.hidden = true; return; }
    debugBusy = true; const current = generation;
    try {
      const inverseViewProjection = mat4.inverse(mat4.multiply(camera.projectionMatrix, mat4.inverse(orbit.worldMatrix)));
      const image = await profile.readDebug((channel === 'position' ? 'depth' : channel) as DeferredLightingDebugChannel);
      if (destroyed || current !== generation || channel !== select('display').value) return;
      if (!image) { debug.hidden = true; $('debug-info').textContent = channel === 'tiles' ? '热力图需要 Tiled 路径；等待 GPU 分块结果。' : '当前视图没有可读回的 G-buffer。'; return; }
      if (channel === 'position' && image.depth) {
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          const index = y * image.width + x, depth = image.depth[index]!;
          if (depth >= 1) { image.pixels.set([0, 0, 0, 255], index * 4); continue; }
          const world = vec3.transformMat4([(x + .5) / image.width * 2 - 1, 1 - (y + .5) / image.height * 2, depth], inverseViewProjection);
          image.pixels.set([(world[0]! / 26 + .5) * 255, world[1]! / 8 * 255, (world[2]! / 24 + .5) * 255, 255], index * 4);
        }
      }
      debug.width = image.width; debug.height = image.height; debugContext.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0); debug.hidden = false;
      $('debug-info').textContent = channel === 'tiles' ? `GPU 实际列表 · 最大 ${image.maxLights} 灯/块 · ${image.fullListTiles} 块完整灯表回退（粉色）` : `${channel} · GPU 实际附件 · 2 Hz 异步读回；深度是非线性设备深度，材质 AO 不含屏幕空间 AO。`;
    } catch (error) { if (!destroyed && current === generation) fail(String(error)); }
    finally { debugBusy = false; }
  }
  function updateHud() {
    const diagnostics = getEngineDiagnosticsSnapshot(engine), frame = diagnostics.frame, stats = profile?.snapshot();
    if (frame.gpuMs !== undefined) latestGpu = { ms: frame.gpuMs, at: performance.now(), frame: frame.gpu?.frame ?? frame.frame };
    const count = Number(select('count').value), active = lights.slice(0, count).filter(light => !light.entity.disabled).length;
    $('eligible').textContent = `${active} / ${count}`;
    $('submitted').textContent = stats?.completeCoverage ? String(stats.submittedPoints) : '≤ 8 槽';
    $('cpu').textContent = `${frame.cpuMs.record.toFixed(2)} ms`;
    $('gpu').textContent = latestGpu && performance.now() - latestGpu.at < 3000 ? `${latestGpu.ms.toFixed(2)} ms · #${latestGpu.frame}` : engine.timestampQuerySupported ? '等待异步采样' : '设备不支持 timestamp';
    $('frame').textContent = `${frameDelta.toFixed(1)} ms`;
    $('memory').textContent = stats ? `${(stats.allocatedBytes / 1048576).toFixed(2)} MiB` : '0 MiB';
    const forward = !stats || !stats.completeCoverage;
    $('status').textContent = `${stats?.effective ?? 'forward'} · ${canvas.width}×${canvas.height} · ${active} 盏有效点光源`;
    $('notice').textContent = forward ? `Forward 最多 8 槽（含环境灯）；当前 ${active} 盏点光源可能被选择/截断。画面不等价，不能比较加速比。${stats?.reason ?? ''}` : '完整点光源列表 · 局部灯无阴影 · 实时诊断不代表 G05 性能达标。';
    $('details').textContent = JSON.stringify({ pointLights: { authored: count, disabled: count - active, eligible: active, submitted: stats?.completeCoverage ? stats.submittedPoints : null, capacityOverflow: stats?.completeCoverage ? 0 : 'Forward selection; see capacity warning' }, stats, counters: frame.counters, gpu: frame.gpu }, null, 2);
    $('result').textContent = JSON.stringify({ status: document.body.dataset.renderStatus, errors, count, active, stats, width: canvas.width, height: canvas.height, frames: readyFrames, timestampSupported: engine.timestampQuerySupported, adapter: engine.adapter ? { vendor: engine.adapter.info.vendor, architecture: engine.adapter.info.architecture, device: engine.adapter.info.device, description: engine.adapter.info.description } : null });
  }
  function fail(message: string) { document.body.dataset.renderStatus = 'failed'; $('status').textContent = `无法完成渲染：${message}`; $('result').textContent = JSON.stringify({ status: 'failed', errors: [...errors, message] }); engine.stop(); }
  engine.on('update', event => { frameDelta = event.detail.delta; if (input('motion').checked) { time += Math.min(frameDelta, 100) / 1000; updateLights(); } });
  engine.on('after-update', event => {
    if (destroyed) return; readyFrames++; drawHelpers(); framegraph?.afterFrame();
    
    if (event.detail.time - lastDebug > 500) { lastDebug = event.detail.time; void drawDebug(); }
  });
  engine.on('device-lost', () => { framegraph?.clear(); generation++; pending?.abort(); debug.hidden = true; });
  engine.on('device-restored', () => { void switchPath(); });
  engine.on('recovery-failed', event => fail(event.detail.error.message));
  observer = new ResizeObserver(() => { if (!destroyed) { engine.resizeToDisplaySize(); debug.hidden = true; } }); observer.observe(canvas);
  hudTimer = setInterval(() => { if (document.body.dataset.renderStatus === 'ready') updateHud(); }, 100);
  syncSelection(); engine.run(); await switchPath();
  Object.assign(window, { __deferredExample: { dispose, framegraph, whenSubmittedWorkDone: () => engine.device.queue.onSubmittedWorkDone(), snapshot: () => ({ ...JSON.parse($('result').textContent || '{}'), lifecycle: document.body.dataset.renderStatus, resources: getEngineDiagnosticsSnapshot(engine).gpuResources.totals }) } });
}
void main().catch(error => { document.body.dataset.renderStatus = 'failed'; $('status').textContent = `WebGPU 初始化失败：${String(error)}`; console.error(error); });
