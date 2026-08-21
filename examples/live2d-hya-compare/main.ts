import { parseAnimation, type ParsedAnimation } from '@haiyue/animation-spec';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData, type ParsedDeformableMesh2DData } from '@haiyue/animation-spec/deformable2d';
import { CubismCaptureConversionError, convertCubismCaptureToHya, sampleCubismMotion3, type CubismDrawableCapture, type CubismMotion3 } from '@haiyue/animation-spec/live2d';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { createDeformableMesh2DRuntimeExtension } from '@haiyue/extensions/deformable-animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { ANIMATION_COMPARE_BACKGROUND_HEX, ANIMATION_COMPARE_CLEAR_COLOR, resolveAnimationCompareZoom } from '../animationCompareTheme';

interface Bounds { x: number; y: number; width: number; height: number }
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
}
interface CoreSession { core: any; moc: any; model: any; motion: CubismMotion3 | null; parameterDefaults: Float32Array; partDefaults: Float32Array; parameterIndex: Map<string, number>; partIndex: Map<string, number>; canvasWidth: number; canvasHeight: number; canvasOriginX: number; canvasOriginY: number; pixelsPerUnit: number; textures: ImageBitmap[] }

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
  let playing = true;
  let lastTick = performance.now();
  let autoZoom = 1;
  let objectUrls: string[] = [];

  bindControls();
  await loadBundledSample();

  engine.on('after-update', () => {
    const now = performance.now();
    const delta = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (playing && player) currentTime = (currentTime + delta) % duration;
    player?.seek(currentTime);
    drawReference();
    const timeline = query<HTMLInputElement>('#timeline');
    if (document.activeElement !== timeline) timeline.value = String(currentTime);
    query<HTMLOutputElement>('#time').textContent = `${currentTime.toFixed(2)} / ${duration.toFixed(2)}s`;
    const result = query<HTMLElement>('#result');
    if (!result.dataset.status && hyaRenderer.stats.visualCount > 0) {
      result.dataset.status = 'passed';
      result.textContent = JSON.stringify({ status: 'passed', hya: hyaRenderer.stats, reference: coreSession ? 'official-cubism-core' : 'captured-mesh-fixture', comparisonBackground: ANIMATION_COMPARE_BACKGROUND_HEX, bounds, autoZoom });
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
    replaceReferenceTextures([texture]);
    const parsed = parseAnimation(hya, { extensions: createDeformableMesh2DFormatRegistry() });
    installHya(parsed);
    configureFromData(bakedData);
    query<HTMLElement>('#reference-mode').textContent = 'Capture mesh reference';
    setStatus('默认 sample 已加载；选择本地 SDK runtime 目录可启用官方 Cubism Core 对照。', 'success');
  }

  async function loadLicensedDirectory(files: FileList): Promise<void> {
    setStatus('加载官方 Cubism Core 并读取本地模型…', 'working');
    const fileMap = new Map(Array.from(files, file => [normalizePath(file.webkitRelativePath || file.name), file]));
    const modelEntry = [...fileMap.entries()].find(([path]) => path.toLowerCase().endsWith('.model3.json'));
    if (!modelEntry) throw new Error('所选目录中没有 .model3.json。');
    const [modelPath, modelFile] = modelEntry;
    const model3 = JSON.parse(await modelFile.text());
    const references = model3.FileReferences;
    if (!references?.Moc || !Array.isArray(references.Textures)) throw new Error('model3.json 缺少 Moc 或 Textures。');
    await loadScript(query<HTMLInputElement>('#core-url').value);
    const core = (globalThis as any).Live2DCubismCore;
    if (!core?.Moc || !core?.Model) throw new Error('脚本没有提供 Live2DCubismCore。');
    const mocFile = requiredRelativeFile(fileMap, modelPath, references.Moc);
    const moc = core.Moc.fromArrayBuffer(await mocFile.arrayBuffer());
    if (!moc) throw new Error('Cubism Core 拒绝了该 moc3。');
    const model = core.Model.fromMoc(moc);
    if (!model) { moc.release?.(); throw new Error('Cubism Core 无法创建模型。'); }
    const motionReference = firstMotionReference(references.Motions);
    const motion = motionReference ? JSON.parse(await requiredRelativeFile(fileMap, modelPath, motionReference).text()) as CubismMotion3 : null;
    const textureFiles: File[] = (references.Textures as string[]).map(path => requiredRelativeFile(fileMap, modelPath, path));
    const textures = await Promise.all(textureFiles.map((file: File) => createImageBitmap(file, { colorSpaceConversion: 'none' })));
    const ppu = Number(model.canvasinfo.PixelsPerUnit);
    disposeCoreSession();
    coreSession = {
      core, moc, model, motion,
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
    const capture = captureCoreClip(coreSession, textureFiles);
    const converted = convertCubismCaptureToHya(capture);
    releaseObjectUrls();
    const dataUrl = URL.createObjectURL(new Blob([converted.data], { type: 'application/vnd.haiyue.deformable-mesh-2d' }));
    objectUrls.push(dataUrl);
    const textureUrls = textureFiles.map((file: File) => { const url = URL.createObjectURL(file); objectUrls.push(url); return url; });
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
    installHya(parsed);
    configureFromData(bakedData);
    query<HTMLElement>('#reference-mode').textContent = 'Official Cubism Core evaluator';
    const maskCount = bakedData.drawables.reduce((sum, drawable) => sum + drawable.masks.length, 0);
    setStatus(`官方 Core 已加载 · ${bakedData.drawables.length} drawables · ${capture.frames.length} baked frames${maskCount ? ` · ${maskCount} 个 mask references` : ''}`, 'success');
  }

  function installHya(animation: ParsedAnimation): void {
    if (playerEntity) scene.remove(playerEntity);
    modelTransform = new Transform2D();
    player = new Animation2DComponent(animation, { autoplay: false, loop: true, runtimeExtensions });
    playerEntity = new Entity('Compared HYA model').addComponent(modelTransform).addComponent(player);
    scene.add(playerEntity);
    duration = animation.duration;
    currentTime = 0;
    query<HTMLInputElement>('#timeline').max = String(duration);
  }

  function configureFromData(data: ParsedDeformableMesh2DData): void {
    sourceWidth = data.canvasWidth;
    sourceHeight = data.canvasHeight;
    bounds = dataBounds(data);
    autoZoom = clamp(0.82 * Math.min(sourceWidth / Math.max(1, bounds.width), sourceHeight / Math.max(1, bounds.height)), 0.1, 12);
    camera.setViewportFit({ designWidth: sourceWidth, designHeight: sourceHeight, viewportMode: 'fit' });
    camera.resize(hyaCanvas.clientWidth || hyaCanvas.width, hyaCanvas.clientHeight || hyaCanvas.height);
    query<HTMLInputElement>('#zoom').value = '1'; query<HTMLInputElement>('#pan-x').value = '0'; query<HTMLInputElement>('#pan-y').value = '0'; applyView();
  }

  function drawReference(): void {
    if (coreSession) {
      applyCoreMotion(coreSession, currentTime);
      referenceRenderer.render(captureCoreReferenceDrawables(coreSession), coreSession.textures, sourceWidth, sourceHeight, bounds, viewSettings());
    } else if (bakedData) {
      referenceRenderer.render(sampleBakedDrawables(bakedData, currentTime), referenceTextures, sourceWidth, sourceHeight, bounds, viewSettings());
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
  float coverage = u_opacity * maskCoverage;
  outColor = vec4(color.rgb * coverage, color.a * coverage);
}`);
    this.position = gl.getAttribLocation(this.program, 'a_position'); this.uv = gl.getAttribLocation(this.program, 'a_uv');
    this.uniforms = Object.fromEntries([
      'u_center', 'u_view', 'u_pan', 'u_zoom', 'u_target_size', 'u_opacity', 'u_use_mask', 'u_output_mask', 'u_texture', 'u_mask',
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

function sampleBakedDrawables(data: ParsedDeformableMesh2DData, time: number): ReferenceDrawable[] { const frame = findFrame(data.times, time), next = Math.min(frame + 1, data.times.length - 1), progress = next === frame ? 0 : (time - data.times[frame]!) / (data.times[next]! - data.times[frame]!); return data.drawables.map(drawable => { const stride = drawable.vertexCount * 2, positions = new Float32Array(stride); for (let i = 0; i < stride; i++) positions[i] = mix(drawable.positions[frame * stride + i]!, drawable.positions[next * stride + i]!, progress); return { id: drawable.id, positions, uvs: drawable.uvs, indices: drawable.indices, opacity: mix(drawable.opacities[frame]!, drawable.opacities[next]!, progress), textureIndex: drawable.textureIndex, order: drawable.renderOrders[frame]!, blendMode: drawable.blendMode, masks: drawable.masks }; }); }
function captureCoreReferenceDrawables(session: CoreSession): ReferenceDrawable[] { const d = session.model.drawables, ids = Array.from(d.ids, String); return ids.map((id, index) => { const positions = new Float32Array(d.vertexPositions[index].length); for (let i = 0; i < positions.length; i += 2) { positions[i] = session.canvasOriginX + d.vertexPositions[index][i] * session.pixelsPerUnit; positions[i + 1] = session.canvasOriginY - d.vertexPositions[index][i + 1] * session.pixelsPerUnit; } const flags = d.constantFlags[index]; return { id, positions, uvs: Float32Array.from(d.vertexUvs[index]), indices: Uint32Array.from(d.indices[index]), opacity: d.opacities[index], textureIndex: d.textureIndices[index], order: d.renderOrders[index], blendMode: session.core.Utils.hasBlendAdditiveBit(flags) ? 'additive' : session.core.Utils.hasBlendMultiplicativeBit(flags) ? 'multiplicative' : 'normal', masks: Array.from(d.masks[index] ?? [], (mask: number) => ids[mask]!) }; }); }
function captureCoreClip(session: CoreSession, textures: File[]): CubismDrawableCapture { const duration = session.motion?.Meta.Duration ?? 1, steps = Math.max(1, Math.ceil(duration * 30)), frames = []; for (let frame = 0; frame <= steps; frame++) { const time = duration * frame / steps; applyCoreMotion(session, time); const d = session.model.drawables, ids = Array.from(d.ids, String); frames.push({ time, drawables: ids.map((id, index) => { const flags = d.constantFlags[index]; return { id, textureIndex: d.textureIndices[index], renderOrder: d.renderOrders[index], opacity: d.opacities[index], blendMode: session.core.Utils.hasBlendAdditiveBit(flags) ? 'additive' as const : session.core.Utils.hasBlendMultiplicativeBit(flags) ? 'multiplicative' as const : 'normal' as const, culling: !session.core.Utils.hasIsDoubleSidedBit(flags), masks: Array.from(d.masks[index] ?? [], (mask: number) => ids[mask]!), positions: centerCorePositions(session, d.vertexPositions[index]), uvs: Array.from(d.vertexUvs[index]) as number[], indices: Array.from(d.indices[index]) as number[] }; }) }); } return { format: 'live2d-cubism-drawable-capture', version: 1, name: 'Browser comparison capture', canvas: { width: session.canvasWidth, height: session.canvasHeight, pixelsPerUnit: session.pixelsPerUnit, coordinateSystem: 'model-y-up' }, duration, frameRate: steps / duration, textures: textures.map((file, index) => ({ id: `texture-${index}`, uri: file.name })), frames }; }
function centerCorePositions(session: CoreSession, source: ArrayLike<number>): number[] { const positions = Array.from(source); const offsetX = (session.canvasOriginX - session.canvasWidth / 2) / session.pixelsPerUnit, offsetY = (session.canvasHeight / 2 - session.canvasOriginY) / session.pixelsPerUnit; for (let index = 0; index < positions.length; index += 2) { positions[index]! += offsetX; positions[index + 1]! += offsetY; } return positions; }
function applyCoreMotion(session: CoreSession, time: number): void { session.model.parameters.values.set(session.parameterDefaults); session.model.parts.opacities.set(session.partDefaults); if (session.motion) { const sample = sampleCubismMotion3(session.motion, time); for (const [id, value] of sample.parameters) { const index = session.parameterIndex.get(id); if (index !== undefined) session.model.parameters.values[index] = value; } for (const [id, value] of sample.partOpacities) { const index = session.partIndex.get(id); if (index !== undefined) session.model.parts.opacities[index] = value; } } session.model.update(); }
function dataBounds(data: ParsedDeformableMesh2DData): Bounds { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const drawable of data.drawables) for (let i = 0; i < drawable.positions.length; i += 2) { minX = Math.min(minX, drawable.positions[i]!); minY = Math.min(minY, drawable.positions[i + 1]!); maxX = Math.max(maxX, drawable.positions[i]!); maxY = Math.max(maxY, drawable.positions[i + 1]!); } return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: data.canvasWidth, height: data.canvasHeight }; }
function findFrame(times: Float32Array, time: number): number { let index = 0; while (index + 1 < times.length && times[index + 1]! <= time) index++; return index; }
function firstMotionReference(motions: unknown): string | null { if (!motions || typeof motions !== 'object') return null; for (const entries of Object.values(motions as Record<string, unknown>)) if (Array.isArray(entries) && typeof entries[0]?.File === 'string') return entries[0].File; return null; }
function requiredRelativeFile(files: Map<string, File>, modelPath: string, relative: string): File { const resolved = normalizePath(new URL(relative, `https://local/${modelPath}`).pathname.slice(1)); const file = files.get(resolved); if (!file) throw new Error(`模型目录缺少 ${relative}`); return file; }
function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, ''); }
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

void main().catch(error => { const result = document.querySelector<HTMLElement>('#result'); if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); } console.error(error); });
