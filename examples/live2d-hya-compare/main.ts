import { parseAnimation, type ParsedAnimation } from '@haiyue/animation-spec';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData, type ParsedDeformableMesh2DData } from '@haiyue/animation-spec/deformable2d';
import { combineCubismCaptureClips, CubismCaptureConversionError, convertCubismCaptureToHya, listCubismModel3Motions, sampleCubismMotion3, type CubismDrawableCapture, type CubismModel3MotionReference, type CubismMotion3 } from '@haiyue/animation-spec/live2d';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { createDeformableMesh2DRuntimeExtension } from '@haiyue/extensions/deformable-animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { ANIMATION_COMPARE_BACKGROUND_HEX, ANIMATION_COMPARE_CLEAR_COLOR, resolveAnimationCompareZoom } from '../animationCompareTheme';

interface Bounds { x: number; y: number; width: number; height: number }
interface FeatureCoverage { maskReferenceCount: number; invertedMaskDrawableCount: number; additiveDrawableCount: number; multiplicativeDrawableCount: number }
interface ReferenceDrawable {
  id: string;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  opacity: number;
  textureIndex: number;
  order: number;
  blendMode: 'normal' | 'additive' | 'multiplicative';
  masks: readonly string[];
  maskMode: 'alpha' | 'alpha-inverted';
}
interface LoadedCoreMotion extends CubismModel3MotionReference { readonly label: string; readonly motion: CubismMotion3 }
interface CoreClipRange { readonly start: number; readonly duration: number; readonly frameCount: number }
interface PlaybackAction { readonly id: string; readonly label: string; readonly range: CoreClipRange }
interface CoreSession { core: any; moc: any; model: any; motion: CubismMotion3 | null; motions: readonly LoadedCoreMotion[]; selectedMotionId: string | null; clipRanges: ReadonlyMap<string, CoreClipRange>; textureFiles: readonly File[]; parameterDefaults: Float32Array; partDefaults: Float32Array; parameterIndex: Map<string, number>; partIndex: Map<string, number>; canvasWidth: number; canvasHeight: number; canvasOriginX: number; canvasOriginY: number; pixelsPerUnit: number; textures: ImageBitmap[] }

async function main(): Promise<void> {
  const hyaCanvas = query<HTMLCanvasElement>('#hya-canvas');
  const referenceCanvas = query<HTMLCanvasElement>('#reference-canvas');
  const engine = new HaiyueEngine({ canvas: hyaCanvas, clearColor: ANIMATION_COMPARE_CLEAR_COLOR });
  await engine.init();
  const cameraEntity = new Entity('Live2D comparison camera');
  const camera = new Camera2D({ width: 512, height: 512, designWidth: 512, designHeight: 512, viewportMode: 'fit' });
  cameraEntity.addComponent(camera);
  const scene = engine.createScene({ name: 'Live2D HYA comparison', camera: { type: '2d', entity: cameraEntity }, view: { clearColor: ANIMATION_COMPARE_CLEAR_COLOR }, render3D: false, render2D: false, gui: false, pipelineLabel: 'Live2DHyaCompare.render' });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const hyaRenderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 128 });
  scene.addSystem(hyaRenderer);
  engine.switchScene(scene);
  engine.run();
  const referenceRenderer = new ReferenceMeshRenderer(referenceCanvas);
  const runtimeExtensions = new Animation2DExtensionRegistry();
  runtimeExtensions.register(createDeformableMesh2DRuntimeExtension({ onStatus(status) { query<HTMLElement>('#runtime-state').textContent = status.state; if (status.error) setStatus(status.error, 'error'); } }));

  let playerEntity: Entity | null = null;
  let player: Animation2DComponent | null = null;
  let modelTransform: Transform2D | null = null;
  let bakedData: ParsedDeformableMesh2DData | null = null;
  let referenceTextures: ImageBitmap[] = [];
  let coreSession: CoreSession | null = null;
  let bounds: Bounds = { x: 0, y: 0, width: 512, height: 512 };
  let sourceWidth = 512;
  let sourceHeight = 512;
  let duration = 2;
  let currentTime = 0;
  let playbackOffset = 0;
  let playing = true;
  let lastTick = performance.now();
  let autoZoom = 1;
  let objectUrls: string[] = [];
  let playbackActions: readonly PlaybackAction[] = [];
  let selectedActionId: string | null = null;
  let playerInstallCount = 0;
  let featureCoverage: FeatureCoverage = { maskReferenceCount: 0, invertedMaskDrawableCount: 0, additiveDrawableCount: 0, multiplicativeDrawableCount: 0 };
  let smokeSwitchPending = new URLSearchParams(location.search).get('actionSmoke') === '1';

  bindControls();
  await loadBundledSample();
  const localModel = localModelQuery();
  if (localModel) await loadMountedModel(localModel.mount, localModel.files);

  engine.on('after-update', () => {
    const now = performance.now();
    const delta = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (playing && player) currentTime = (currentTime + delta) % duration;
    player?.seek(playbackOffset + currentTime);
    drawReference();
    const timeline = query<HTMLInputElement>('#timeline');
    if (document.activeElement !== timeline) timeline.value = String(currentTime);
    query<HTMLOutputElement>('#time').textContent = `${currentTime.toFixed(2)} / ${duration.toFixed(2)}s`;
    if (smokeSwitchPending && hyaRenderer.stats.visualCount > 0 && playbackActions.length > 1) {
      smokeSwitchPending = false;
      selectPlaybackAction(playbackActions[1]!.id);
      return;
    }
    const result = query<HTMLElement>('#result');
    if (!result.dataset.status && hyaRenderer.stats.visualCount > 0) {
      result.dataset.status = 'passed';
      result.textContent = JSON.stringify({ status: 'passed', hya: hyaRenderer.stats, reference: coreSession ? 'official-cubism-core' : 'captured-mesh-fixture', comparisonBackground: ANIMATION_COMPARE_BACKGROUND_HEX, bounds, autoZoom, actionCount: playbackActions.length, selectedActionId, playerInstallCount, featureCoverage });
    }
  });

  async function loadBundledSample(): Promise<void> {
    setStatus('加载仓库内 MIT capture fixture…', 'working');
    disposeCoreSession();
    releaseObjectUrls();
    const [hya, data, texture] = await Promise.all([
      fetch('./samples/mascot.hya').then(requireOk).then(response => response.arrayBuffer()),
      fetch('./samples/mascot.hydm').then(requireOk).then(response => response.arrayBuffer()),
      loadBitmap('./samples/mascot.png'),
    ]);
    bakedData = decodeDeformableMesh2DData(data);
    featureCoverage = summarizeDeformableFeatures(bakedData);
    replaceReferenceTextures([texture]);
    const parsed = parseAnimation(hya, { extensions: createDeformableMesh2DFormatRegistry() });
    const midpoint = parsed.duration / 2;
    playbackActions = Object.freeze([
      { id: 'sample:first', label: 'MIT Sample · 动作 A', range: { start: 0, duration: midpoint, frameCount: frameCountInRange(bakedData.times, 0, midpoint) } },
      { id: 'sample:second', label: 'MIT Sample · 动作 B', range: { start: midpoint, duration: parsed.duration - midpoint, frameCount: frameCountInRange(bakedData.times, midpoint, parsed.duration) } },
    ]);
    selectedActionId = playbackActions[0]!.id;
    updateActionSelector(playbackActions);
    installHya(parsed, playbackActions[0]!.range.start, playbackActions[0]!.range.duration);
    configureFromData(bakedData);
    query<HTMLElement>('#reference-mode').textContent = 'Capture mesh reference';
    setStatus('默认 sample 已加载；选择本地 SDK runtime 目录可启用官方 Cubism Core 对照。', 'success');
  }

  async function loadMountedModel(mount: string, paths: readonly string[]): Promise<void> {
    const base = new URL(mount.endsWith('/') ? mount : `${mount}/`, location.href);
    if (base.origin !== location.origin) throw new Error('Local model mount must use the comparison page origin.');
    const files = await Promise.all(paths.map(async path => {
      const normalized = normalizePath(path);
      if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`Invalid local model path: ${path}`);
      const response = await fetch(new URL(normalized, base));
      requireOk(response);
      const file = new File([await response.blob()], normalized.split('/').pop()!, { type: response.headers.get('content-type') ?? '' });
      Object.defineProperty(file, 'webkitRelativePath', { value: `runtime/${normalized}` });
      return file;
    }));
    await loadLicensedDirectory(files);
  }

  async function loadLicensedDirectory(files: FileList | readonly File[]): Promise<void> {
    setStatus('加载官方 Cubism Core 并读取本地模型…', 'working');
    const fileMap = new Map(Array.from(files, file => [normalizePath(file.webkitRelativePath || file.name), file]));
    const modelEntry = [...fileMap.entries()].find(([path]) => path.toLowerCase().endsWith('.model3.json'));
    if (!modelEntry) throw new Error('所选目录中没有 .model3.json。');
    const [modelPath, modelFile] = modelEntry;
    const model3 = JSON.parse(await modelFile.text());
    const references = model3.FileReferences;
    if (!references?.Moc || !Array.isArray(references.Textures)) throw new Error('model3.json 缺少 Moc 或 Textures。');
    const motionReferences = listCubismModel3Motions(references.Motions);
    const groupCounts = new Map<string, number>();
    for (const reference of motionReferences) groupCounts.set(reference.group, (groupCounts.get(reference.group) ?? 0) + 1);
    const motions: LoadedCoreMotion[] = await Promise.all(motionReferences.map(async reference => ({
      ...reference,
      label: formatMotionLabel(reference, groupCounts.get(reference.group) ?? 1),
      motion: JSON.parse(await requiredRelativeFile(fileMap, modelPath, reference.file).text()) as CubismMotion3,
    })));
    await loadScript(query<HTMLInputElement>('#core-url').value);
    const core = (globalThis as any).Live2DCubismCore;
    if (!core?.Moc || !core?.Model) throw new Error('脚本没有提供 Live2DCubismCore。');
    const mocFile = requiredRelativeFile(fileMap, modelPath, references.Moc);
    const moc = core.Moc.fromArrayBuffer(await mocFile.arrayBuffer());
    if (!moc) throw new Error('Cubism Core 拒绝了该 moc3。');
    const model = core.Model.fromMoc(moc);
    if (!model) { moc.release?.(); throw new Error('Cubism Core 无法创建模型。'); }
    const textureFiles: File[] = (references.Textures as string[]).map(path => requiredRelativeFile(fileMap, modelPath, path));
    const textures = await Promise.all(textureFiles.map((file: File) => createImageBitmap(file, { colorSpaceConversion: 'none' })));
    const ppu = Number(model.canvasinfo.PixelsPerUnit);
    disposeCoreSession();
    const selectedMotion = motions[0] ?? null;
    coreSession = {
      core, moc, model, motion: selectedMotion?.motion ?? null,
      motions,
      selectedMotionId: selectedMotion?.id ?? null,
      clipRanges: new Map(),
      textureFiles,
      parameterDefaults: Float32Array.from(model.parameters.defaultValues),
      partDefaults: Float32Array.from(model.parts.opacities),
      parameterIndex: new Map(Array.from(model.parameters.ids, (id: unknown, index: number) => [String(id), index])),
      partIndex: new Map(Array.from(model.parts.ids, (id: unknown, index: number) => [String(id), index])),
      canvasWidth: Number(model.canvasinfo.CanvasWidth),
      canvasHeight: Number(model.canvasinfo.CanvasHeight),
      canvasOriginX: Number(model.canvasinfo.CanvasOriginX),
      canvasOriginY: Number(model.canvasinfo.CanvasOriginY),
      pixelsPerUnit: ppu,
      textures,
    };
    const actionSet = captureCoreActionSet(coreSession, textureFiles);
    coreSession.clipRanges = actionSet.ranges;
    playbackActions = Object.freeze(motions.map(motion => ({ id: motion.id, label: motion.label, range: actionSet.ranges.get(motion.id)! })));
    selectedActionId = selectedMotion?.id ?? null;
    updateActionSelector(playbackActions);
    installCoreCapture(actionSet.capture, true);
  }

  function installCoreCapture(capture: CubismDrawableCapture, resetView: boolean): void {
    if (!coreSession) throw new Error('Cubism Core 模型尚未加载。');
    const result = query<HTMLElement>('#result');
    delete result.dataset.status;
    result.textContent = '';
    const converted = convertCubismCaptureToHya(capture);
    featureCoverage = {
      maskReferenceCount: converted.report.maskReferenceCount,
      invertedMaskDrawableCount: converted.report.invertedMaskDrawableCount,
      additiveDrawableCount: converted.report.additiveDrawableCount,
      multiplicativeDrawableCount: converted.report.multiplicativeDrawableCount,
    };
    releaseObjectUrls();
    const dataUrl = URL.createObjectURL(new Blob([converted.data], { type: 'application/vnd.haiyue.deformable-mesh-2d' }));
    objectUrls.push(dataUrl);
    const textureUrls = coreSession.textureFiles.map((file: File) => { const url = URL.createObjectURL(file); objectUrls.push(url); return url; });
    const resources = converted.document.resources ?? [];
    const imageResourceIds = resources.filter(resource => resource.type === 'image').map(resource => resource.id);
    const document = {
      ...converted.document,
      resources: resources.map(resource => resource.id === 'deformable-mesh-data'
        ? { ...resource, uri: dataUrl }
        : resource.type === 'image'
          ? { ...resource, uri: textureUrls[imageResourceIds.indexOf(resource.id)]! }
          : resource),
    };
    const parsed = parseAnimation(document, { extensions: createDeformableMesh2DFormatRegistry() });
    bakedData = decodeDeformableMesh2DData(converted.data);
    replaceReferenceTextures([]);
    const selectedRange = coreSession.selectedMotionId ? coreSession.clipRanges.get(coreSession.selectedMotionId) : undefined;
    installHya(parsed, selectedRange?.start ?? 0, selectedRange?.duration ?? parsed.duration);
    configureFromData(bakedData, resetView);
    query<HTMLElement>('#reference-mode').textContent = 'Official Cubism Core evaluator';
    const maskCount = bakedData.drawables.reduce((sum, drawable) => sum + drawable.masks.length, 0);
    const selectedMotion = coreSession.motions.find(item => item.id === coreSession?.selectedMotionId);
    const motionSummary = selectedMotion ? ` · 动作：${selectedMotion.label}` : ' · 静态姿势（无 Motion3）';
    const blendSummary = ` · additive ${featureCoverage.additiveDrawableCount} · multiplicative ${featureCoverage.multiplicativeDrawableCount}`;
    setStatus(`官方 Core 已加载 · ${coreSession.motions.length} 个动作 · ${bakedData.drawables.length} drawables · ${capture.frames.length} baked frames${motionSummary}${maskCount ? ` · ${maskCount} 个 mask references` : ''}${blendSummary}`, 'success');
  }

  function installHya(animation: ParsedAnimation, clipStart = 0, clipDuration = animation.duration): void {
    if (playerEntity) scene.remove(playerEntity);
    modelTransform = new Transform2D();
    player = new Animation2DComponent(animation, { autoplay: false, loop: true, runtimeExtensions });
    playerEntity = new Entity('Compared HYA model').addComponent(modelTransform).addComponent(player);
    scene.add(playerEntity);
    playerInstallCount++;
    playbackOffset = clipStart;
    duration = clipDuration;
    currentTime = 0;
    query<HTMLInputElement>('#timeline').max = String(duration);
    query<HTMLInputElement>('#timeline').value = '0';
    player.seek(playbackOffset);
  }

  function configureFromData(data: ParsedDeformableMesh2DData, resetView = true): void {
    sourceWidth = data.canvasWidth;
    sourceHeight = data.canvasHeight;
    bounds = dataBounds(data);
    autoZoom = clamp(0.82 * Math.min(sourceWidth / Math.max(1, bounds.width), sourceHeight / Math.max(1, bounds.height)), 0.1, 12);
    camera.setViewportFit({ designWidth: sourceWidth, designHeight: sourceHeight, viewportMode: 'fit' });
    camera.resize(hyaCanvas.clientWidth || hyaCanvas.width, hyaCanvas.clientHeight || hyaCanvas.height);
    if (resetView) { query<HTMLInputElement>('#zoom').value = '1'; query<HTMLInputElement>('#pan-x').value = '0'; query<HTMLInputElement>('#pan-y').value = '0'; }
    applyView();
  }

  function selectPlaybackAction(id: string): void {
    const selected = playbackActions.find(action => action.id === id);
    if (!selected || selectedActionId === selected.id) return;
    if (coreSession) {
      const motion = coreSession.motions.find(candidate => candidate.id === selected.id);
      if (!motion) throw new Error(`动作“${selected.label}”没有对应的 Motion3。`);
      coreSession.motion = motion.motion;
      coreSession.selectedMotionId = motion.id;
    }
    selectedActionId = selected.id;
    query<HTMLSelectElement>('#motion-select').value = selected.id;
    playbackOffset = selected.range.start;
    duration = selected.range.duration;
    currentTime = 0;
    const timeline = query<HTMLInputElement>('#timeline');
    timeline.max = String(duration);
    timeline.value = '0';
    player?.seek(playbackOffset);
    drawReference();
    const result = query<HTMLElement>('#result');
    delete result.dataset.status;
    result.textContent = '';
    setStatus(`动作已无缝切换：${selected.label} · 复用同一 HYA 实例与纹理 · ${selected.range.frameCount} clip frames`, 'success');
  }

  function drawReference(): void {
    if (coreSession) {
      applyCoreMotion(coreSession, currentTime);
      referenceRenderer.render(captureCoreReferenceDrawables(coreSession), coreSession.textures, sourceWidth, sourceHeight, bounds, viewSettings());
    } else if (bakedData) {
      referenceRenderer.render(sampleBakedDrawables(bakedData, playbackOffset + currentTime), referenceTextures, sourceWidth, sourceHeight, bounds, viewSettings());
    }
  }

  function bindControls(): void {
    query<HTMLButtonElement>('#play').addEventListener('click', () => { playing = !playing; query<HTMLButtonElement>('#play').textContent = playing ? '暂停' : '播放'; });
    query<HTMLInputElement>('#timeline').addEventListener('input', event => { currentTime = Number((event.currentTarget as HTMLInputElement).value); player?.seek(currentTime); drawReference(); });
    for (const id of ['zoom', 'pan-x', 'pan-y']) query<HTMLInputElement>(`#${id}`).addEventListener('input', applyView);
    query<HTMLButtonElement>('#fit').addEventListener('click', () => { query<HTMLInputElement>('#zoom').value = '1'; query<HTMLInputElement>('#pan-x').value = '0'; query<HTMLInputElement>('#pan-y').value = '0'; applyView(); });
    const directory = query<HTMLInputElement>('#model-directory');
    query<HTMLButtonElement>('#choose-model').addEventListener('click', () => directory.click());
    directory.addEventListener('change', () => { if (directory.files?.length) void loadLicensedDirectory(directory.files).catch(error => setStatus(formatLoadError(error), 'error')); });
    query<HTMLButtonElement>('#bundled').addEventListener('click', () => void loadBundledSample().catch(error => setStatus(formatLoadError(error), 'error')));
    query<HTMLSelectElement>('#motion-select').addEventListener('change', event => { try { selectPlaybackAction((event.currentTarget as HTMLSelectElement).value); } catch (error) { setStatus(formatLoadError(error), 'error'); } });
  }

  function updateActionSelector(actions: readonly PlaybackAction[]): void {
    const selector = query<HTMLSelectElement>('#motion-select');
    selector.replaceChildren();
    if (actions.length === 0) {
      selector.append(new Option('静态姿势（无 Motion3）', ''));
      selector.disabled = true;
      return;
    }
    for (const action of actions) selector.append(new Option(action.label, action.id, false, action.id === selectedActionId));
    selector.disabled = false;
  }

  function applyView(): void {
    if (!modelTransform) return;
    const { zoom, panX, panY } = viewSettings();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    modelTransform.setScale(zoom).setPosition(zoom * (sourceWidth / 2 - centerX) + panX, zoom * (centerY - sourceHeight / 2) - panY);
    query<HTMLOutputElement>('#view-value').textContent = `${zoom.toFixed(2)}× · ${panX.toFixed(0)}, ${panY.toFixed(0)}`;
  }
  function viewSettings(): { zoom: number; panX: number; panY: number } { return { zoom: resolveAnimationCompareZoom(autoZoom, Number(query<HTMLInputElement>('#zoom').value)), panX: Number(query<HTMLInputElement>('#pan-x').value), panY: Number(query<HTMLInputElement>('#pan-y').value) }; }
  function replaceReferenceTextures(textures: ImageBitmap[]): void { for (const texture of referenceTextures) { referenceRenderer.releaseTexture(texture); texture.close(); } referenceTextures = textures; }
  function disposeCoreSession(): void { if (!coreSession) return; coreSession.model.release?.(); coreSession.moc.release?.(); for (const texture of coreSession.textures) { referenceRenderer.releaseTexture(texture); texture.close(); } coreSession = null; }
  function releaseObjectUrls(): void { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = []; }
  window.addEventListener('beforeunload', () => { disposeCoreSession(); replaceReferenceTextures([]); releaseObjectUrls(); referenceRenderer.destroy(); engine.destroy(); }, { once: true });
}

class ReferenceMeshRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly position: number;
  private readonly uv: number;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly textureCache = new WeakMap<ImageBitmap, WebGLTexture>();
  private maskTexture: WebGLTexture | null = null;
  private maskFramebuffer: WebGLFramebuffer | null = null;
  private maskWidth = 0;
  private maskHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('Reference view requires WebGL2.');
    this.gl = gl;
    this.program = createProgram(gl, `#version 300 es
in vec2 a_position;
in vec2 a_uv;
uniform vec2 u_center;
uniform vec2 u_view;
uniform vec2 u_pan;
uniform float u_zoom;
out vec2 v_uv;
void main() {
  vec2 p = (a_position - u_center) * u_zoom + u_pan;
  gl_Position = vec4(2.0 * p.x / u_view.x, -2.0 * p.y / u_view.y, 0.0, 1.0);
  v_uv = a_uv;
}`, `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_mask;
uniform vec2 u_target_size;
uniform float u_opacity;
uniform float u_use_mask;
uniform float u_invert_mask;
uniform float u_output_mask;
out vec4 outColor;
void main() {
  vec4 color = texture(u_texture, v_uv);
  float sourceAlpha = color.a * u_opacity;
  if (u_output_mask > 0.5) {
    outColor = vec4(sourceAlpha);
    return;
  }
  float maskCoverage = u_use_mask > 0.5
    ? texture(u_mask, gl_FragCoord.xy / u_target_size).a
    : 1.0;
  if (u_use_mask > 0.5 && u_invert_mask > 0.5) maskCoverage = 1.0 - maskCoverage;
  float coverage = u_opacity * maskCoverage;
  outColor = vec4(color.rgb * coverage, color.a * coverage);
}`);
    this.position = gl.getAttribLocation(this.program, 'a_position'); this.uv = gl.getAttribLocation(this.program, 'a_uv');
    this.uniforms = Object.fromEntries([
      'u_center', 'u_view', 'u_pan', 'u_zoom', 'u_target_size', 'u_opacity', 'u_use_mask', 'u_invert_mask', 'u_output_mask', 'u_texture', 'u_mask',
    ].map(name => [name, requiredUniform(gl, this.program, name)]));
  }

  render(drawables: ReferenceDrawable[], images: ImageBitmap[], sourceWidth: number, sourceHeight: number, bounds: Bounds, view: { zoom: number; panX: number; panY: number }): void {
    const gl = this.gl; const width = Math.max(1, this.canvas.clientWidth); const height = Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.ensureMaskTarget(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(ANIMATION_COMPARE_CLEAR_COLOR.r, ANIMATION_COMPARE_CLEAR_COLOR.g, ANIMATION_COMPARE_CLEAR_COLOR.b, ANIMATION_COMPARE_CLEAR_COLOR.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    const sourceAspect = sourceWidth / sourceHeight, displayAspect = width / height;
    const viewWidth = displayAspect > sourceAspect ? sourceHeight * displayAspect : sourceWidth;
    const viewHeight = displayAspect > sourceAspect ? sourceHeight : sourceWidth / displayAspect;
    gl.uniform2f(this.uniforms.u_center!, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    gl.uniform2f(this.uniforms.u_view!, viewWidth, viewHeight);
    gl.uniform2f(this.uniforms.u_pan!, view.panX, view.panY);
    gl.uniform2f(this.uniforms.u_target_size!, width, height);
    gl.uniform1f(this.uniforms.u_zoom!, view.zoom);
    gl.uniform1i(this.uniforms.u_texture!, 0);
    gl.uniform1i(this.uniforms.u_mask!, 1);
    const byId = new Map(drawables.map(drawable => [drawable.id, drawable]));
    for (const drawable of [...drawables].sort((a, b) => a.order - b.order)) {
      const image = images[drawable.textureIndex]; if (!image || drawable.opacity <= 0) continue;
      const usesMask = drawable.masks.length > 0 && this.renderMask(drawable.masks, byId, images, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      this.setBlendMode(drawable.blendMode);
      this.drawDrawable(drawable, image, usesMask, false);
    }
  }

  destroy(): void {
    this.gl.deleteProgram(this.program);
    if (this.maskFramebuffer) this.gl.deleteFramebuffer(this.maskFramebuffer);
    if (this.maskTexture) this.gl.deleteTexture(this.maskTexture);
    this.maskFramebuffer = null;
    this.maskTexture = null;
  }

  releaseTexture(image: ImageBitmap): void { const texture = this.textureCache.get(image); if (!texture) return; this.gl.deleteTexture(texture); this.textureCache.delete(image); }

  private renderMask(maskIds: readonly string[], byId: ReadonlyMap<string, ReferenceDrawable>, images: readonly ImageBitmap[], width: number, height: number): boolean {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let rendered = false;
    for (const id of maskIds) {
      const mask = byId.get(id);
      const image = mask ? images[mask.textureIndex] : undefined;
      if (!mask || !image || mask.opacity <= 0) continue;
      this.drawDrawable(mask, image, false, true);
      rendered = true;
    }
    return rendered;
  }

  private drawDrawable(drawable: ReferenceDrawable, image: ImageBitmap, useMask: boolean, outputMask: boolean): void {
    const gl = this.gl;
    const positionBuffer = gl.createBuffer()!, uvBuffer = gl.createBuffer()!, indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawable.positions, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawable.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.uv);
    gl.vertexAttribPointer(this.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, drawable.indices, gl.STATIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture(image));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, useMask ? this.maskTexture : null);
    gl.uniform1f(this.uniforms.u_opacity!, drawable.opacity);
    gl.uniform1f(this.uniforms.u_use_mask!, useMask ? 1 : 0);
    gl.uniform1f(this.uniforms.u_invert_mask!, useMask && drawable.maskMode === 'alpha-inverted' ? 1 : 0);
    gl.uniform1f(this.uniforms.u_output_mask!, outputMask ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, drawable.indices.length, gl.UNSIGNED_INT, 0);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(uvBuffer);
    gl.deleteBuffer(indexBuffer);
  }

  private setBlendMode(mode: ReferenceDrawable['blendMode']): void {
    const gl = this.gl;
    if (mode === 'additive') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    else if (mode === 'multiplicative') gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private ensureMaskTarget(width: number, height: number): void {
    if (this.maskTexture && this.maskFramebuffer && this.maskWidth === width && this.maskHeight === height) return;
    const gl = this.gl;
    if (this.maskFramebuffer) gl.deleteFramebuffer(this.maskFramebuffer);
    if (this.maskTexture) gl.deleteTexture(this.maskTexture);
    this.maskTexture = gl.createTexture();
    this.maskFramebuffer = gl.createFramebuffer();
    if (!this.maskTexture || !this.maskFramebuffer) throw new Error('Reference renderer could not allocate its mask target.');
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Reference renderer mask framebuffer is incomplete.');
    this.maskWidth = width;
    this.maskHeight = height;
  }

  private texture(image: ImageBitmap): WebGLTexture {
    let texture = this.textureCache.get(image);
    if (texture) return texture;
    const gl = this.gl;
    texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.textureCache.set(image, texture);
    return texture;
  }
}

function sampleBakedDrawables(data: ParsedDeformableMesh2DData, time: number): ReferenceDrawable[] { const frame = findFrame(data.times, time), next = Math.min(frame + 1, data.times.length - 1), progress = next === frame ? 0 : (time - data.times[frame]!) / (data.times[next]! - data.times[frame]!); return data.drawables.map(drawable => { const stride = drawable.vertexCount * 2, positions = new Float32Array(stride); for (let i = 0; i < stride; i++) positions[i] = mix(drawable.positions[frame * stride + i]!, drawable.positions[next * stride + i]!, progress); return { id: drawable.id, positions, uvs: drawable.uvs, indices: drawable.indices, opacity: mix(drawable.opacities[frame]!, drawable.opacities[next]!, progress), textureIndex: drawable.textureIndex, order: drawable.renderOrders[frame]!, blendMode: drawable.blendMode, masks: drawable.masks, maskMode: drawable.maskMode }; }); }
function captureCoreReferenceDrawables(session: CoreSession): ReferenceDrawable[] { const d = session.model.drawables, ids = Array.from(d.ids, String); return ids.map((id, index) => { const positions = new Float32Array(d.vertexPositions[index].length); for (let i = 0; i < positions.length; i += 2) { positions[i] = session.canvasOriginX + d.vertexPositions[index][i] * session.pixelsPerUnit; positions[i + 1] = session.canvasOriginY - d.vertexPositions[index][i + 1] * session.pixelsPerUnit; } const flags = d.constantFlags[index]; return { id, positions, uvs: normalizeCoreUvs(d.vertexUvs[index]), indices: Uint32Array.from(d.indices[index]), opacity: d.opacities[index], textureIndex: d.textureIndices[index], order: d.renderOrders[index], blendMode: session.core.Utils.hasBlendAdditiveBit(flags) ? 'additive' : session.core.Utils.hasBlendMultiplicativeBit(flags) ? 'multiplicative' : 'normal', masks: Array.from(d.masks[index] ?? [], (mask: number) => ids[mask]!), maskMode: coreInvertedMask(session.core, flags) ? 'alpha-inverted' : 'alpha' }; }); }
function captureCoreActionSet(session: CoreSession, textures: readonly File[]): { readonly capture: CubismDrawableCapture; readonly ranges: ReadonlyMap<string, CoreClipRange> } {
  if (session.motions.length === 0) return { capture: captureCoreClip(session, textures, null), ranges: new Map() };
  const combined = combineCubismCaptureClips(session.motions.map(motion => ({
    id: motion.id,
    name: motion.label,
    capture: captureCoreClip(session, textures, motion.motion),
  })), { name: 'Browser comparison action set' });
  return {
    capture: combined.capture,
    ranges: new Map(combined.clips.map(clip => [clip.id, clip])),
  };
}
function captureCoreClip(session: CoreSession, textures: readonly File[], motion: CubismMotion3 | null = session.motion): CubismDrawableCapture { const duration = motion?.Meta.Duration ?? 1, steps = Math.max(1, Math.ceil(duration * 30)), frames = []; for (let frame = 0; frame <= steps; frame++) { const time = duration * frame / steps; applyCoreMotion(session, time, motion); const d = session.model.drawables, ids = Array.from(d.ids, String); frames.push({ time, drawables: ids.map((id, index) => { const flags = d.constantFlags[index]; return { id, textureIndex: d.textureIndices[index], renderOrder: d.renderOrders[index], opacity: d.opacities[index], blendMode: session.core.Utils.hasBlendAdditiveBit(flags) ? 'additive' as const : session.core.Utils.hasBlendMultiplicativeBit(flags) ? 'multiplicative' as const : 'normal' as const, culling: !session.core.Utils.hasIsDoubleSidedBit(flags), masks: Array.from(d.masks[index] ?? [], (mask: number) => ids[mask]!), invertedMask: coreInvertedMask(session.core, flags), positions: centerCorePositions(session, d.vertexPositions[index]), uvs: Array.from(d.vertexUvs[index]) as number[], indices: Array.from(d.indices[index]) as number[] }; }) }); } return { format: 'live2d-cubism-drawable-capture', version: 1, name: 'Browser comparison capture', canvas: { width: session.canvasWidth, height: session.canvasHeight, pixelsPerUnit: session.pixelsPerUnit, coordinateSystem: 'model-y-up', uvOrigin: 'bottom-left' }, duration, frameRate: steps / duration, textures: textures.map((file, index) => ({ id: `texture-${index}`, uri: file.name })), frames }; }
function coreInvertedMask(core: any, flags: number): boolean { return typeof core.Utils.hasIsInvertedMaskBit === 'function' && core.Utils.hasIsInvertedMaskBit(flags); }
function centerCorePositions(session: CoreSession, source: ArrayLike<number>): number[] { const positions = Array.from(source); const offsetX = (session.canvasOriginX - session.canvasWidth / 2) / session.pixelsPerUnit, offsetY = (session.canvasHeight / 2 - session.canvasOriginY) / session.pixelsPerUnit; for (let index = 0; index < positions.length; index += 2) { positions[index]! += offsetX; positions[index + 1]! += offsetY; } return positions; }
function normalizeCoreUvs(source: ArrayLike<number>): Float32Array { const uvs = Float32Array.from(source); for (let index = 1; index < uvs.length; index += 2) uvs[index] = 1 - uvs[index]!; return uvs; }
function applyCoreMotion(session: CoreSession, time: number, motion: CubismMotion3 | null = session.motion): void { session.model.parameters.values.set(session.parameterDefaults); session.model.parts.opacities.set(session.partDefaults); if (motion) { const sample = sampleCubismMotion3(motion, time); for (const [id, value] of sample.parameters) { const index = session.parameterIndex.get(id); if (index !== undefined) session.model.parameters.values[index] = value; } for (const [id, value] of sample.partOpacities) { const index = session.partIndex.get(id); if (index !== undefined) session.model.parts.opacities[index] = value; } } session.model.update(); }
function dataBounds(data: ParsedDeformableMesh2DData): Bounds { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const drawable of data.drawables) for (let i = 0; i < drawable.positions.length; i += 2) { minX = Math.min(minX, drawable.positions[i]!); minY = Math.min(minY, drawable.positions[i + 1]!); maxX = Math.max(maxX, drawable.positions[i]!); maxY = Math.max(maxY, drawable.positions[i + 1]!); } return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: data.canvasWidth, height: data.canvasHeight }; }
function summarizeDeformableFeatures(data: ParsedDeformableMesh2DData): FeatureCoverage { return { maskReferenceCount: data.drawables.reduce((sum, drawable) => sum + drawable.masks.length, 0), invertedMaskDrawableCount: data.drawables.filter(drawable => drawable.maskMode === 'alpha-inverted').length, additiveDrawableCount: data.drawables.filter(drawable => drawable.blendMode === 'additive').length, multiplicativeDrawableCount: data.drawables.filter(drawable => drawable.blendMode === 'multiplicative').length }; }
function frameCountInRange(times: Float32Array, start: number, end: number): number { let count = 0; for (const time of times) if (time >= start && time <= end) count++; return count; }
function findFrame(times: Float32Array, time: number): number { let index = 0; while (index + 1 < times.length && times[index + 1]! <= time) index++; return index; }
function formatMotionLabel(motion: CubismModel3MotionReference, groupCount: number): string { const filename = motion.file.replaceAll('\\', '/').split('/').pop()?.replace(/\.motion3\.json$/iu, '') ?? motion.file; return `${motion.group}${groupCount > 1 ? ` ${motion.index + 1}` : ''} · ${filename}`; }
function requiredRelativeFile(files: Map<string, File>, modelPath: string, relative: string): File { const resolved = normalizePath(new URL(relative, `https://local/${modelPath}`).pathname.slice(1)); const file = files.get(resolved); if (!file) throw new Error(`模型目录缺少 ${relative}`); return file; }
function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, ''); }
function localModelQuery(): { mount: string; files: readonly string[] } | null { const parameters = new URLSearchParams(location.search), mount = parameters.get('localModelMount'), encoded = parameters.get('localModelFiles'); if (!mount || !encoded) return null; const files = encoded.split('|').map(value => normalizePath(value)).filter(Boolean); if (files.length === 0) throw new Error('Local model query did not list files.'); return { mount, files }; }
async function loadBitmap(url: string): Promise<ImageBitmap> { return createImageBitmap(await fetch(url).then(requireOk).then(response => response.blob()), { colorSpaceConversion: 'none' }); }
function loadScript(src: string): Promise<void> { if ((globalThis as any).Live2DCubismCore) return Promise.resolve(); return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = () => resolve(); script.onerror = () => reject(new Error(`无法加载 Cubism Core：${src}`)); document.head.append(script); }); }
function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram { const compile = (type: number, source: string) => { const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed'); return shader; }; const program = gl.createProgram()!; gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed'); return program; }
function requiredUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(`Missing shader uniform ${name}`); return value; }
function mix(a: number, b: number, t: number): number { return a + (b - a) * clamp(t, 0, 1); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function requireOk(response: Response): Response { if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`); return response; }
function setStatus(message: string, kind: string): void { const node = query<HTMLElement>('#status'); node.textContent = message; node.dataset.kind = kind; }
function formatLoadError(error: unknown): string {
  if (!(error instanceof CubismCaptureConversionError)) return error instanceof Error ? error.message : String(error);
  const diagnostic = error.diagnostics.find(item => item.severity === 'error') ?? error.diagnostics[0];
  return diagnostic ? `${error.message} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}` : error.message;
}
function query<T extends Element>(selector: string): T { const element = document.querySelector<T>(selector); if (!element) throw new ReferenceError(`Missing ${selector}`); return element; }

void main().catch(error => { const result = document.querySelector<HTMLElement>('#result'); if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: formatLoadError(error) }); } console.error(error); });
