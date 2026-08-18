import type { IEngine } from '../core/IEngine';
import { LineGeometry } from '../geometry/LineGeometry';
import { LineMaterial } from '../material/LineMaterial';
import { BaseRenderer } from './BaseRenderer';
import { matrixEquals, writeBuffer as wrtBuf } from './utils';
import type { LiveIdSet } from './utils';
import { alignUp16 } from '../utils/align';
import { encodeShaderPipelineKey } from './pipelineKey';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';

// Number of triangles for each round cap semicircle
const CAP_SEGS = 8;

/**
 * Vertex budget per polyline segment (between two adjacent points):
 *   - 2 triangles (quad) = 6 vertices for segment body
 *   - 2 caps × CAP_SEGS triangles × 3 vertices (only on butt the count is 0,
 *     but we always allocate the same budget and the shader outputs degenerate
 *     tris for butt caps)
 */
const VERTS_PER_SEG = 6 + CAP_SEGS * 3 * 2;

// ── GPU data cache ─────────────────────────────────────────────────────────

interface LineGPUData {
  pointsBuf: GPUBuffer;
  pointsBufCapacity: number; // in float32 elements
  bindGroup: GPUBindGroup;
  modelBuf: GPUBuffer;
  modelSnapshot: Float32Array;
  lineBuf: GPUBuffer;
  lastColor: [number, number, number, number];
  lastWidth: number;
  lastScreenSpace: number;
  lastCapRound: number;
  lastNumPoints: number;
  lineDirty: boolean;
}

// ── Renderer ──────────────────────────────────────────────────────────────

export class Line3DRenderer extends BaseRenderer {
  readonly type = 'line3d';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private shader!: GPUShaderModule;
  private shaderKey = '';
  private pipelineLayout!: GPUPipelineLayout;

  private bgl!: GPUBindGroupLayout;

  /** 96-byte camera uniform shared across all lines this frame */
  private cameraBuf!: GPUBuffer;
  private readonly _cameraData = new Float32Array(24);
  private readonly _cameraDataBytes = this._cameraData.buffer as ArrayBuffer;
  private readonly _lineData = new ArrayBuffer(32);
  private readonly _lineDataF32 = new Float32Array(this._lineData);
  private readonly _lineDataU32 = new Uint32Array(this._lineData);

  /** per-(geometry,entity) GPU data */
  private lineCache = new Map<string, LineGPUData>();

  private _initialized = false;

  constructor() {
    super();
  }

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this.clearPipelineCache();
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;

    // Single bind group layout:
    // 0 = camera uniform (96 bytes)
    // 1 = line params uniform (32 bytes)
    // 2 = model matrix uniform (64 bytes)
    // 3 = points storage buffer
    this.bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const generated = getBuiltinSpecializedRenderingShader(device, 'line3d', [this.bgl]);
    this.shader = generated.module;
    this.shaderKey = generated.pass.canonicalHash;
    this.pipelineLayout = generated.pipelineLayout;

    // 96-byte camera buffer
    this.cameraBuf = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey();
    this.addPipelineWarmup(plan, key, 'Line 3D', () => this._pipelineDescriptor(), this.engine.device);
  }

  /** Call once per frame before issuing draw calls. */
  updateCamera(
    viewProj: Float32Array,
    camPos: Float32Array,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    const f32 = this._cameraData;
    f32.set(viewProj, 0);       // offset 0, 16 floats
    f32.set(camPos, 16);        // offset 64 bytes
    // pad at 19
    f32[20] = viewportWidth;
    f32[21] = viewportHeight;
    // pad 22-23
    this.engine.device.queue.writeBuffer(this.cameraBuf, 0, this._cameraDataBytes);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    for (const [key, data] of this.lineCache) {
      const entityId = Number(key.slice(key.indexOf(':') + 1));
      if (!liveEntities.has(entityId)) {
        this._destroyLineData(data);
        this.lineCache.delete(key);
      }
    }
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    for (const [key, data] of this.lineCache) {
      const geometryId = Number(key.slice(0, key.indexOf(':')));
      if (!liveGeometries.has(geometryId)) {
        this._destroyLineData(data);
        this.lineCache.delete(key);
      }
    }
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: LineGeometry,
    material: LineMaterial,
    worldMatrix: Float32Array,
  ): void {
    const { device } = this.engine;
    const numPoints = geometry.pointCount;
    if (numPoints < 2) return;

    const numSegs = geometry.topology === 'segments' ? Math.floor(numPoints / 2) : numPoints - 1;
    const vertexCount = numSegs * VERTS_PER_SEG;

    const cacheKey = `${geometry.id}:${entityId}`;
    let gpuData = this.lineCache.get(cacheKey);

    // ── Allocate / reallocate points storage buffer ───────────────────────
    const neededFloats = numPoints * 3;
    if (!gpuData || gpuData.pointsBufCapacity < neededFloats) {
      if (gpuData) {
        gpuData.pointsBuf.destroy();
        gpuData.modelBuf.destroy();
        gpuData.lineBuf.destroy();
      }

      const pointsBuf = device.createBuffer({
        size: alignUp16(neededFloats * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const modelBuf = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // line params uniform (32 bytes): color(16) + width(4) + screenSpace(4) + capType(4) + numPoints(4)
      const lineBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const bindGroup = device.createBindGroup({
        layout: this.bgl,
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuf } },
          { binding: 1, resource: { buffer: lineBuf } },
          { binding: 2, resource: { buffer: modelBuf } },
          { binding: 3, resource: { buffer: pointsBuf } },
        ],
      });

      gpuData = {
        pointsBuf,
        pointsBufCapacity: neededFloats,
        bindGroup,
        modelBuf,
        modelSnapshot: new Float32Array(16),
        lineBuf,
        lastColor: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        lastWidth: Number.NaN,
        lastScreenSpace: -1,
        lastCapRound: -1,
        lastNumPoints: -1,
        lineDirty: true,
      };
      this.lineCache.set(cacheKey, gpuData);

      wrtBuf(device.queue, pointsBuf, 0, geometry.points);
      geometry.dirty = false;
    }

    // ── Update line params ────────────────────────────────────────────────
    const screenSpace = material.screenSpace ? 1 : 0;
    const capRound = (material.cap === 'round' ? 1 : 0) | (geometry.topology === 'segments' ? 2 : 0);
    const lf = this._lineDataF32;
    material.color.writeSRGB(lf, 0);
    if (
      gpuData.lineDirty ||
      gpuData.lastColor[0] !== lf[0] ||
      gpuData.lastColor[1] !== lf[1] ||
      gpuData.lastColor[2] !== lf[2] ||
      gpuData.lastColor[3] !== lf[3] ||
      gpuData.lastWidth !== material.width ||
      gpuData.lastScreenSpace !== screenSpace ||
      gpuData.lastCapRound !== capRound ||
      gpuData.lastNumPoints !== numPoints
    ) {
      const lineData = this._lineData;
      const lu = this._lineDataU32;
      lf[4] = material.width;
      lu[5] = screenSpace;
      lu[6] = capRound;
      lu[7] = numPoints;
      device.queue.writeBuffer(gpuData.lineBuf, 0, lineData);
      gpuData.lastColor[0] = lf[0]!;
      gpuData.lastColor[1] = lf[1]!;
      gpuData.lastColor[2] = lf[2]!;
      gpuData.lastColor[3] = lf[3]!;
      gpuData.lastWidth = material.width;
      gpuData.lastScreenSpace = screenSpace;
      gpuData.lastCapRound = capRound;
      gpuData.lastNumPoints = numPoints;
      gpuData.lineDirty = false;
    }

    // ── Update model matrix ───────────────────────────────────────────────
    if (!matrixEquals(gpuData.modelSnapshot, worldMatrix)) {
      wrtBuf(device.queue, gpuData.modelBuf, 0, worldMatrix);
      gpuData.modelSnapshot.set(worldMatrix);
    }

    // ── Update points if dirty ────────────────────────────────────────────
    if (geometry.dirty) {
      wrtBuf(device.queue, gpuData.pointsBuf, 0, geometry.points);
      geometry.dirty = false;
    }

    // ── Draw ──────────────────────────────────────────────────────────────
    passEncoder.setPipeline(this._getPipeline());
    passEncoder.setBindGroup(0, gpuData.bindGroup);
    passEncoder.draw(vertexCount);
  }

  private _getPipeline(): GPURenderPipeline {
    const key = this._pipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this._pipelineDescriptor()));
  }

  private _pipelineKey(): string {
    return encodeShaderPipelineKey(
      (this.reverseZ ? 1 : 0) | ((this.msaaSamples > 1 ? 1 : 0) << 1),
      this.shaderKey,
    );
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      layout: this.pipelineLayout,
      vertex: { module: this.shader, entryPoint: 'vs_main' },
      fragment: { module: this.shader, entryPoint: 'fs_main', targets: [{ format: this.engine.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: true,
        depthCompare: this.reverseZ ? 'greater' : 'less',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  destroy(): void {
    this.cameraBuf?.destroy();
    for (const d of this.lineCache.values()) {
      this._destroyLineData(d);
    }
    this.lineCache.clear();
    this.clearPipelineCache();
  }

  private _destroyLineData(data: LineGPUData): void {
    data.pointsBuf.destroy();
    data.modelBuf.destroy();
    data.lineBuf.destroy();
  }
}
