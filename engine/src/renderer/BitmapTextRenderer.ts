import type { IEngine } from '../core/IEngine';
import { BitmapText } from '../components/BitmapText';
import { bitmapKerningKey, type BitmapFontData, type BitmapFontChar } from '../font/BitmapFontData';
import { BaseRenderer } from './BaseRenderer';
import { matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import { alignUp4 } from '../utils/align';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltin2dUiShader } from '../shader/BuiltinRenderShader';
import type { AssetHandle } from '../assets/AssetManager';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { getInstrumentedGPUResourceTracker } from '../core/GPUResourceTracker';
import { RecordedGpuResources } from './RecordedGpuResources';

// ── Text layout ───────────────────────────────────────────────────────────────

/**
 * Build an interleaved (x,y,z,u,v) vertex buffer for the given text string.
 * Y-axis points up; text advances along +X, newlines go in −Y direction.
 * Returns null if no visible glyphs.
 */
function buildTextMesh(
  text: string,
  font: BitmapFontData,
  scale: number,
  lineSpacing: number,
  letterSpacing: number,
): Float32Array | null {
  const glyphCount = countVisibleGlyphs(text, font);
  if (glyphCount === 0) return null;
  const verts = new Float32Array(glyphCount * 6 * 5);
  let offset = 0;
  let curX = 0;
  let curY = 0;
  let prevCode: number | null = null;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;

    if (ch === '\n') {
      curX = 0;
      curY -= font.lineHeight * scale * lineSpacing;
      prevCode = null;
      continue;
    }

    const g: BitmapFontChar | undefined =
      font.chars.get(code) ?? font.chars.get(63 /* '?' */);
    if (!g) { prevCode = code; continue; }

    // Kerning
    if (prevCode !== null) {
      const kern = font.kernings.get(bitmapKerningKey(prevCode, code)) ?? 0;
      curX += kern * scale;
    }

    if (g.width > 0 && g.height > 0) {
      const x0 = curX + g.xoffset * scale;
      const y0 = curY - g.yoffset * scale;
      const x1 = x0 + g.width  * scale;
      const y1 = y0 - g.height * scale;

      const u0 = g.x / font.scaleW;
      const v0 = g.y / font.scaleH;
      const u1 = (g.x + g.width)  / font.scaleW;
      const v1 = (g.y + g.height) / font.scaleH;

      // Two CCW triangles, cullMode:'none' so winding doesn't matter
      offset = writeTextVertex(verts, offset, x0, y0, u0, v0);
      offset = writeTextVertex(verts, offset, x1, y0, u1, v0);
      offset = writeTextVertex(verts, offset, x0, y1, u0, v1);
      offset = writeTextVertex(verts, offset, x1, y0, u1, v0);
      offset = writeTextVertex(verts, offset, x1, y1, u1, v1);
      offset = writeTextVertex(verts, offset, x0, y1, u0, v1);
    }

    curX += (g.xadvance + letterSpacing) * scale;
    prevCode = code;
  }

  return verts;
}

function countVisibleGlyphs(text: string, font: BitmapFontData): number {
  let count = 0;
  for (const ch of text) {
    if (ch === '\n') continue;
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    const glyph = font.chars.get(code) ?? font.chars.get(63);
    if (glyph && glyph.width > 0 && glyph.height > 0) count++;
  }
  return count;
}

function writeTextVertex(data: Float32Array, offset: number, x: number, y: number, u: number, v: number): number {
  data[offset++] = x;
  data[offset++] = y;
  data[offset++] = 0;
  data[offset++] = u;
  data[offset++] = v;
  return offset;
}

// ── GPU caches ────────────────────────────────────────────────────────────────

interface FontGPUData {
  texture: GPUTexture;
  sampler: GPUSampler;
  bindGroup2: GPUBindGroup;
  loaded: boolean;
  source: unknown;
  handle: AssetHandle<GPUTexture> | null;
  ownsTexture: boolean;
  controller: AbortController | null;
  generation: number;
  disposed: boolean;
}

interface EntityGPUData {
  vertexBuf: GPUBuffer | null;
  vertexCount: number;
  modelBuf: GPUBuffer;
  modelSnapshot: Float32Array;
  paramBuf: GPUBuffer;
  paramColorSnapshot: [number, number, number, number];
  paramMode: number;
  paramThreshold: number;
  paramSmoothing: number;
  paramDirty: boolean;
  bindGroup1: GPUBindGroup;
  geometry: BitmapTextGeometryState | null;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class BitmapTextRenderer extends BaseRenderer {
  readonly type = 'bitmapText';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;

  private bgl0!: GPUBindGroupLayout; // camera
  private bgl1!: GPUBindGroupLayout; // model + text params
  private bgl2!: GPUBindGroupLayout; // texture + sampler

  private cameraBuf!: GPUBuffer;
  private cameraBindGroup!: GPUBindGroup;

  private defaultTex!: GPUTexture;
  private fontCache  = new Map<number, FontGPUData>();
  private entityCache = new Map<number, EntityGPUData>();
  private readonly _paramData = new ArrayBuffer(32);
  private readonly _paramDataF32 = new Float32Array(this._paramData);
  private readonly _paramDataU32 = new Uint32Array(this._paramData);

  private _initialized = false;
  private epoch = 0;
  private recorded!: RecordedGpuResources;
  private readonly legacyResources = new WeakSet<object>();
  private readonly cameraSnapshot = new Float32Array(16).fill(Number.NaN);

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this.engine = engine;
    this.epoch++;
    this.recorded = new RecordedGpuResources(engine.device);
    this.cameraSnapshot.fill(Number.NaN);
    this.clearPipelineCache();
    const { device } = engine;

    // Bind group layouts
    this.bgl0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.bgl1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX,   buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.bgl2 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const generated = getBuiltin2dUiShader(device, 'bitmap-text', [this.bgl0, this.bgl1, this.bgl2]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;

    // Camera uniform buffer (64 bytes)
    this.cameraBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const cameraBuf = this.cameraBuf;
    this._own(cameraBuf, () => cameraBuf.destroy());
    this.cameraBindGroup = this._createCameraBindGroup();

    // 1×1 white placeholder texture
    this.defaultTex = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const defaultTex = this.defaultTex;
    this._own(defaultTex, () => defaultTex.destroy());
    device.queue.writeTexture(
      { texture: this.defaultTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
  }

  private _createCameraBindGroup(): GPUBindGroup {
    return this._ownBindGroup(this.engine.device.createBindGroup({
      layout: this.bgl0,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuf } }],
    }));
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey();
    this.addPipelineWarmup(plan, key, 'Bitmap text', () => this._pipelineDescriptor(), this.engine.device);
  }

  updateCamera(viewProj: Float32Array): void {
    if (matrixEquals(this.cameraSnapshot, viewProj)) return;
    if (this.recorded.pending(this.cameraBuf)) {
      const previous = this.cameraBuf;
      const buffer = this.engine.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.cameraBuf = this._own(buffer, () => buffer.destroy());
      this.recorded.retire(this.cameraBindGroup);
      this.cameraBindGroup = this._createCameraBindGroup();
      this.recorded.retire(previous);
    }
    wrtBuf(this.engine.device.queue, this.cameraBuf, 0, viewProj);
    this.cameraSnapshot.set(viewProj);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.entityCache, liveEntities, data => this._destroyEntityData(data));
  }

  releaseFontsNotIn(liveFonts: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this.fontCache, liveFonts, data => this._destroyFontData(data));
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    component: BitmapText,
    worldMatrix: Float32Array,
  ): void {
    const { device } = this.engine;
    const { font } = component;

    // ── Font / atlas GPU data ─────────────────────────────────────────────────
    let fontData = this.fontCache.get(font.id);
    const source = font.pageImages?.[0] ?? font.pages[0] ?? null;
    if (!fontData || fontData.source !== source) {
      if (fontData) this._destroyFontData(fontData);
      fontData = this._initFontGPUData();
      fontData.source = source;
      this.fontCache.set(font.id, fontData);
      this._loadFontAtlasAsync(font, fontData);
    }

    // ── Per-entity GPU data ───────────────────────────────────────────────────
    let entData = this.entityCache.get(entityId);
    if (!entData) {
      const modelBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const paramBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._own(modelBuf, () => modelBuf.destroy());
      this._own(paramBuf, () => paramBuf.destroy());
      const bindGroup1 = this._ownBindGroup(device.createBindGroup({
        layout: this.bgl1,
        entries: [
          { binding: 0, resource: { buffer: modelBuf } },
          { binding: 1, resource: { buffer: paramBuf } },
        ],
      }));
      entData = {
        vertexBuf: null,
        vertexCount: 0,
        modelBuf,
        modelSnapshot: new Float32Array(16),
        paramBuf,
        paramColorSnapshot: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        paramMode: -1,
        paramThreshold: Number.NaN,
        paramSmoothing: Number.NaN,
        paramDirty: true,
        bindGroup1,
        geometry: null,
      };
      this.entityCache.set(entityId, entData);
    }

    // ── Rebuild vertex buffer if text dirty ───────────────────────────────────
    if (!bitmapTextGeometryMatches(entData.geometry, component)) {
      if (entData.vertexBuf) this.recorded.retire(entData.vertexBuf);
      entData.vertexBuf = null;
      entData.vertexCount = 0;

      const scale = component.fontSize / font.size;
      const mesh = buildTextMesh(
        component.text,
        font,
        scale,
        component.lineSpacing,
        component.letterSpacing,
      );

      if (mesh) {
        entData.vertexBuf = device.createBuffer({
          size: alignUp4(mesh.byteLength),
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        const vertexBuf = entData.vertexBuf;
        this._own(vertexBuf, () => vertexBuf.destroy());
        wrtBuf(device.queue, vertexBuf, 0, mesh);
        entData.vertexCount = mesh.length / 5;
      }

      entData.geometry = captureBitmapTextGeometry(component);
    }
    // Preserve the public flag, but each consumer owns its own geometry identity.
    component.clearDirty();

    if (!entData.vertexBuf || entData.vertexCount === 0) return;

    // ── Update uniforms ───────────────────────────────────────────────────────
    if (!matrixEquals(entData.modelSnapshot, worldMatrix)) {
      if (this.recorded.pending(entData.modelBuf)) {
        const previous = entData.modelBuf;
        const buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        entData.modelBuf = this._own(buffer, () => buffer.destroy());
        this._rebuildEntityBindGroup(entData);
        this.recorded.retire(previous);
      }
      wrtBuf(device.queue, entData.modelBuf, 0, worldMatrix);
      entData.modelSnapshot.set(worldMatrix);
    }

    const modeIndex = component.mode === 'msdf' ? 2 : component.mode === 'sdf' ? 1 : 0;
    const pf = this._paramDataF32;
    component.color.writeSRGB(pf, 0);
    const colorChanged =
      entData.paramColorSnapshot[0] !== pf[0] ||
      entData.paramColorSnapshot[1] !== pf[1] ||
      entData.paramColorSnapshot[2] !== pf[2] ||
      entData.paramColorSnapshot[3] !== pf[3];
    const paramChanged =
      entData.paramDirty ||
      colorChanged ||
      entData.paramMode !== modeIndex ||
      entData.paramThreshold !== component.threshold ||
      entData.paramSmoothing !== component.smoothing;
    if (paramChanged) {
      const pBuf = this._paramData;
      const pu = this._paramDataU32;
      pu[4] = modeIndex;
      pf[5] = component.threshold;
      pf[6] = component.smoothing;
      pf[7] = 0;
      if (this.recorded.pending(entData.paramBuf)) {
        const previous = entData.paramBuf;
        const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        entData.paramBuf = this._own(buffer, () => buffer.destroy());
        this._rebuildEntityBindGroup(entData);
        this.recorded.retire(previous);
      }
      device.queue.writeBuffer(entData.paramBuf, 0, pBuf);
      entData.paramColorSnapshot[0] = pf[0]!;
      entData.paramColorSnapshot[1] = pf[1]!;
      entData.paramColorSnapshot[2] = pf[2]!;
      entData.paramColorSnapshot[3] = pf[3]!;
      entData.paramMode = modeIndex;
      entData.paramThreshold = component.threshold;
      entData.paramSmoothing = component.smoothing;
      entData.paramDirty = false;
    }

    // Pin immutable versions until this recording submits or is cancelled.
    for (const resource of [this.cameraBuf, this.cameraBindGroup, entData.vertexBuf, entData.modelBuf,
      entData.paramBuf, entData.bindGroup1, fontData.bindGroup2, fontData.handle ?? fontData.texture]) this._retain(resource);

    // ── Draw ──────────────────────────────────────────────────────────────────
    passEncoder.setPipeline(this._getPipeline());
    passEncoder.setBindGroup(0, this.cameraBindGroup);
    passEncoder.setBindGroup(1, entData.bindGroup1);
    passEncoder.setBindGroup(2, fontData.bindGroup2);
    passEncoder.setVertexBuffer(0, entData.vertexBuf);
    passEncoder.draw(entData.vertexCount);
  }

  private _getPipeline(): GPURenderPipeline {
    const key = this._pipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this._pipelineDescriptor()));
  }

  private _pipelineKey(): string {
    return `bitmap-text|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    const alphaBlend: GPUBlendComponent = {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    };
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.engine.format,
          blend: { color: alphaBlend, alpha: alphaBlend },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: false,
        depthCompare: this.reverseZ ? 'greater' : 'less',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  private _initFontGPUData(): FontGPUData {
    const { device } = this.engine;
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const bindGroup2 = this._ownBindGroup(device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: this.defaultTex.createView() },
        { binding: 1, resource: sampler },
      ],
    }));
    return { texture: this.defaultTex, sampler, bindGroup2, loaded: false, source: null,
      handle: null, ownsTexture: false, controller: null, generation: 0, disposed: false };
  }

  private _rebuildFontBindGroup(fontData: FontGPUData): void {
    const previous = fontData.bindGroup2;
    fontData.bindGroup2 = this._ownBindGroup(this.engine.device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: fontData.texture.createView() },
        { binding: 1, resource: fontData.sampler },
      ],
    }));
    this.recorded.retire(previous);
  }

  private async _loadFontAtlasAsync(font: BitmapFontData, fontData: FontGPUData): Promise<void> {
    if (fontData.loaded || fontData.disposed || !this._initialized) return;
    fontData.controller?.abort();
    const controller = new AbortController();
    fontData.controller = controller;
    const generation = ++fontData.generation;
    const epoch = this.epoch;
    const { device, assetManager } = this.engine;
    const current = () => this._initialized && this.epoch === epoch && !fontData.disposed
      && !controller.signal.aborted && fontData.generation === generation;
    let ownedBitmap: ImageBitmap | null = null;
    let pendingTexture: GPUTexture | null = null;
    try {
      const source = font.pageImages?.[0] ?? font.pages[0] ?? null;
      if (!source) return;
      if (assetManager) {
        const handle = await assetManager.loadTexture(source, { format: 'rgba8unorm', signal: controller.signal });
        if (!current()) { handle.release(); return; }
        fontData.handle = this._own(handle, () => handle.release());
        fontData.texture = handle.value;
      } else {
        let image: HTMLCanvasElement | ImageBitmap | HTMLImageElement;
        if (typeof source === 'string') {
          const response = await fetch(source, { signal: controller.signal });
          if (!current()) return;
          if (!response.ok) throw new EngineError(EngineErrorCode.AssetLoadFailed, `Font atlas request failed: ${response.status}`);
          const blob = await response.blob();
          if (!current()) return;
          ownedBitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
          image = ownedBitmap;
        } else image = source;
        if (!current()) return;
        const texture = device.createTexture({ size: [image.width, image.height], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        pendingTexture = this._own(texture, () => texture.destroy());
        device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
        fontData.texture = texture;
        fontData.ownsTexture = true;
        pendingTexture = null;
      }
      fontData.loaded = true;
      this._rebuildFontBindGroup(fontData);
    } catch (error) {
      if (current()) console.warn('BitmapTextRenderer: failed to load font atlas:', error);
    } finally {
      ownedBitmap?.close();
      if (pendingTexture) this.recorded.retire(pendingTexture);
    }
  }

  private _own<T extends object>(resource: T, destroy: () => void): T {
    const device = this.engine.device;
    const legacy = this.legacyResources;
    return this.recorded.own(resource, () => {
      if (!legacy.has(resource)) { destroy(); return; }
      try { void device.queue.onSubmittedWorkDone().then(destroy, destroy); }
      catch { destroy(); }
    });
  }

  private _ownBindGroup(group: GPUBindGroup): GPUBindGroup {
    const tracker = getInstrumentedGPUResourceTracker(this.engine.device);
    return this._own(group, () => tracker?.untrackObject(group));
  }

  private _retain(resource: object): void {
    const context = bitmapTextRecordings.get(this);
    if (context?.afterSubmit) this.recorded.retain(resource, context);
    else this.legacyResources.add(resource);
  }

  private _rebuildEntityBindGroup(data: EntityGPUData): void {
    const previous = data.bindGroup1;
    data.bindGroup1 = this._ownBindGroup(this.engine.device.createBindGroup({ layout: this.bgl1,
      entries: [{ binding: 0, resource: { buffer: data.modelBuf } },
        { binding: 1, resource: { buffer: data.paramBuf } }] }));
    this.recorded.retire(previous);
  }

  destroy(): void {
    if (!this._initialized) return;
    this._initialized = false;
    this.epoch++;
    this.destroyCacheEntries(this.fontCache, f => this._destroyFontData(f));
    this.destroyCacheEntries(this.entityCache, e => this._destroyEntityData(e));
    this.recorded.retireAll();
    this.clearPipelineCache();
  }

  private _destroyFontData(data: FontGPUData): void {
    if (data.disposed) return;
    data.disposed = true;
    data.generation++;
    data.controller?.abort();
    data.controller = null;
    if (data.handle) this.recorded.retire(data.handle);
    else if (data.ownsTexture) this.recorded.retire(data.texture);
    this.recorded.retire(data.bindGroup2);
    data.handle = null;
  }

  private _destroyEntityData(data: EntityGPUData): void {
    if (data.vertexBuf) this.recorded.retire(data.vertexBuf);
    this.recorded.retire(data.modelBuf);
    this.recorded.retire(data.paramBuf);
    this.recorded.retire(data.bindGroup1);
    data.geometry = null;
  }
}

const bitmapTextRecordings = new WeakMap<BitmapTextRenderer, RenderCommandContext>();
/** Private system-to-renderer adapter, deliberately absent from package exports. */
export function withBitmapTextRecording<T>(renderer: BitmapTextRenderer, context: RenderCommandContext, record: () => T): T {
  const previous = bitmapTextRecordings.get(renderer);
  bitmapTextRecordings.set(renderer, context);
  try { return record(); }
  finally { if (previous) bitmapTextRecordings.set(renderer, previous); else bitmapTextRecordings.delete(renderer); }
}

interface BitmapTextGeometryState {
  component: BitmapText;
  font: BitmapFontData;
  text: string;
  fontSize: number;
  lineSpacing: number;
  letterSpacing: number;
  fontInputs: readonly number[];
}

function bitmapTextGeometryMatches(state: BitmapTextGeometryState | null, text: BitmapText): boolean {
  if (!state || state.component !== text || state.font !== text.font || state.text !== text.text
    || state.fontSize !== text.fontSize || state.lineSpacing !== text.lineSpacing || state.letterSpacing !== text.letterSpacing) return false;
  let index = 0;
  let equal = true;
  visitBitmapFontInputs(text.font, text.text, value => { if (!Object.is(state.fontInputs[index++], value)) equal = false; });
  return equal && index === state.fontInputs.length;
}

function captureBitmapTextGeometry(text: BitmapText): BitmapTextGeometryState {
  const fontInputs: number[] = [];
  visitBitmapFontInputs(text.font, text.text, value => fontInputs.push(value));
  return { component: text, font: text.font, text: text.text, fontSize: text.fontSize,
    lineSpacing: text.lineSpacing, letterSpacing: text.letterSpacing, fontInputs };
}

/** Font data is publicly mutable; compare only the metrics actually used by this string. */
function visitBitmapFontInputs(font: BitmapFontData, text: string, visit: (value: number) => void): void {
  visit(font.size); visit(font.lineHeight); visit(font.scaleW); visit(font.scaleH);
  let previous: number | null = null;
  for (const char of text) {
    if (char === '\n') { previous = null; continue; }
    const code = char.codePointAt(0)!;
    const glyph = font.chars.get(code) ?? font.chars.get(63);
    if (!glyph) visit(Number.NaN);
    else {
      visit(glyph.x); visit(glyph.y); visit(glyph.width); visit(glyph.height);
      visit(glyph.xoffset); visit(glyph.yoffset); visit(glyph.xadvance);
      visit(previous === null ? 0 : font.kernings.get(bitmapKerningKey(previous, code)) ?? 0);
    }
    previous = code;
  }
}
