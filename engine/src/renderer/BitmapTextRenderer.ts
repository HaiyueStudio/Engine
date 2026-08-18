import type { IEngine } from '../core/IEngine';
import { BitmapText } from '../components/BitmapText';
import { bitmapKerningKey, type BitmapFontData, type BitmapFontChar } from '../font/BitmapFontData';
import { BaseRenderer } from './BaseRenderer';
import { matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import { alignUp4 } from '../utils/align';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltin2dUiShader } from '../shader/BuiltinRenderShader';

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

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this.engine = engine;
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
    this.cameraBindGroup = device.createBindGroup({
      layout: this.bgl0,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuf } }],
    });

    // 1×1 white placeholder texture
    this.defaultTex = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.defaultTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey();
    this.addPipelineWarmup(plan, key, 'Bitmap text', () => this._pipelineDescriptor(), this.engine.device);
  }

  updateCamera(viewProj: Float32Array): void {
    wrtBuf(this.engine.device.queue, this.cameraBuf, 0, viewProj);
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
    if (!fontData) {
      fontData = this._initFontGPUData();
      this.fontCache.set(font.id, fontData);
      this._loadFontAtlasAsync(font, fontData);
    }

    // ── Per-entity GPU data ───────────────────────────────────────────────────
    let entData = this.entityCache.get(entityId);
    if (!entData) {
      const modelBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const paramBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bindGroup1 = device.createBindGroup({
        layout: this.bgl1,
        entries: [
          { binding: 0, resource: { buffer: modelBuf } },
          { binding: 1, resource: { buffer: paramBuf } },
        ],
      });
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
      };
      this.entityCache.set(entityId, entData);
    }

    // ── Rebuild vertex buffer if text dirty ───────────────────────────────────
    if (component.dirty || entData.vertexBuf === null) {
      entData.vertexBuf?.destroy();
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
        wrtBuf(device.queue, entData.vertexBuf, 0, mesh);
        entData.vertexCount = mesh.length / 5;
      }

      component.clearDirty();
    }

    if (!entData.vertexBuf || entData.vertexCount === 0) return;

    // ── Update uniforms ───────────────────────────────────────────────────────
    if (!matrixEquals(entData.modelSnapshot, worldMatrix)) {
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
    const bindGroup2 = device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: this.defaultTex.createView() },
        { binding: 1, resource: sampler },
      ],
    });
    return { texture: this.defaultTex, sampler, bindGroup2, loaded: false };
  }

  private _rebuildFontBindGroup(fontData: FontGPUData): void {
    fontData.bindGroup2 = this.engine.device.createBindGroup({
      layout: this.bgl2,
      entries: [
        { binding: 0, resource: fontData.texture.createView() },
        { binding: 1, resource: fontData.sampler },
      ],
    });
  }

  private async _loadFontAtlasAsync(font: BitmapFontData, fontData: FontGPUData): Promise<void> {
    if (fontData.loaded) return;

    try {
      let src: HTMLCanvasElement | ImageBitmap | HTMLImageElement | null = null;

      if (font.pageImages && font.pageImages.length > 0) {
        src = font.pageImages[0] ?? null;
      } else if (font.pages[0]) {
        const res = await fetch(font.pages[0]);
        const blob = await res.blob();
        src = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      }

      if (!src) return;

      const width  = src instanceof HTMLCanvasElement ? src.width  : (src as ImageBitmap | HTMLImageElement).width;
      const height = src instanceof HTMLCanvasElement ? src.height : (src as ImageBitmap | HTMLImageElement).height;

      const { device } = this.engine;
      const texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      device.queue.copyExternalImageToTexture(
        { source: src as ImageBitmap | HTMLCanvasElement | HTMLImageElement },
        { texture },
        [width, height],
      );

      fontData.texture = texture;
      fontData.loaded = true;
      this._rebuildFontBindGroup(fontData);
    } catch (e) {
      console.warn('BitmapTextRenderer: failed to load font atlas:', e);
    }
  }

  destroy(): void {
    this.cameraBuf?.destroy();
    this.defaultTex?.destroy();
    this.destroyCacheEntries(this.fontCache, f => this._destroyFontData(f));
    this.destroyCacheEntries(this.entityCache, e => this._destroyEntityData(e));
  }

  private _destroyFontData(data: FontGPUData): void {
    if (data.texture !== this.defaultTex) data.texture.destroy();
  }

  private _destroyEntityData(data: EntityGPUData): void {
    data.vertexBuf?.destroy();
    data.modelBuf.destroy();
    data.paramBuf.destroy();
  }
}
