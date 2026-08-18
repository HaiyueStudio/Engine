import type { IEngine } from '../core/IEngine';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { MeshHelper } from '../components/MeshHelper';
import { BaseRenderer } from './BaseRenderer';
import { matrixEquals } from './utils';
import type { LiveIdSet } from './utils';
import { alignUp4 } from '../utils/align';
import { requiredNumberAt } from '../math/arrayAccess';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { getBuiltinSimple3dShader } from '../shader/BuiltinSimple3dShader';

// ── CPU helpers ───────────────────────────────────────────────────────────────

/** 12 edges (24 vertex pairs) describing an axis-aligned box. */
function buildBoxLines(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): Float32Array {
  const data = new Float32Array(24 * 3);
  fillBoxLines(data, x0, y0, z0, x1, y1, z1);
  return data;
}

function fillBoxLines(
  data: Float32Array,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  const c: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
    [4, 5], [5, 6], [6, 7], [7, 4], // top face
    [0, 4], [1, 5], [2, 6], [3, 7], // pillars
  ];
  let i = 0;
  for (const [a, b] of edges) {
    const start = c[a];
    const end = c[b];
    if (!start || !end) throw new RangeError('Box edge references an unknown corner.');
    data[i++] = start[0]; data[i++] = start[1]; data[i++] = start[2];
    data[i++] = end[0]; data[i++] = end[1]; data[i++] = end[2];
  }
}

/** Deduplicated edge list for a triangle mesh. */
function buildWireframeLines(geo: Geometry3D): Float32Array {
  const pos = geo.positions;
  const idx = geo.indices;
  const verts: number[] = [];

  if (idx) {
    const seen = new Set<number>();
    const vertexCount = geo.vertexCount;
    const addEdge = (a: number, b: number) => {
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      if (seen.has(key)) return;
      seen.add(key);
      verts.push(
        requiredNumberAt(pos, a * 3, 'geometry positions'),
        requiredNumberAt(pos, a * 3 + 1, 'geometry positions'),
        requiredNumberAt(pos, a * 3 + 2, 'geometry positions'),
        requiredNumberAt(pos, b * 3, 'geometry positions'),
        requiredNumberAt(pos, b * 3 + 1, 'geometry positions'),
        requiredNumberAt(pos, b * 3 + 2, 'geometry positions'),
      );
    };
    for (let t = 0; t < idx.length; t += 3) {
      const a = requiredNumberAt(idx, t, 'geometry indices');
      const b = requiredNumberAt(idx, t + 1, 'geometry indices');
      const c = requiredNumberAt(idx, t + 2, 'geometry indices');
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
  } else {
    for (let t = 0; t < pos.length; t += 9) {
      verts.push(
        requiredNumberAt(pos, t), requiredNumberAt(pos, t + 1), requiredNumberAt(pos, t + 2),
        requiredNumberAt(pos, t + 3), requiredNumberAt(pos, t + 4), requiredNumberAt(pos, t + 5),
        requiredNumberAt(pos, t + 3), requiredNumberAt(pos, t + 4), requiredNumberAt(pos, t + 5),
        requiredNumberAt(pos, t + 6), requiredNumberAt(pos, t + 7), requiredNumberAt(pos, t + 8),
        requiredNumberAt(pos, t + 6), requiredNumberAt(pos, t + 7), requiredNumberAt(pos, t + 8),
        requiredNumberAt(pos, t), requiredNumberAt(pos, t + 1), requiredNumberAt(pos, t + 2),
      );
    }
  }
  return new Float32Array(verts);
}

// ── GPU data caches ───────────────────────────────────────────────────────────

interface EntityGPU {
  objBuf: GPUBuffer;   // 96 bytes: model(64) + color(16) + lineWidth/pad(16)
  objBG:  GPUBindGroup;
  objectData: Float32Array;
  objectModelSnapshot: Float32Array;
  objectColorSnapshot: [number, number, number, number];
  objectLineWidth: number;
  objectDirty: boolean;
  aabbVertBuf: GPUBuffer; // 288 bytes, updated each frame for AABB mode
  aabbLines: Float32Array;
  aabbMatrixSnapshot: Float32Array;
  aabbGeometryVersion: number;
}

interface GeoGPU {
  vertBuf:   GPUBuffer;
  segmentCount: number;
}

const IDENTITY_MAT4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

// ── Renderer ──────────────────────────────────────────────────────────────────

export class MeshHelperRenderer extends BaseRenderer {
  reverseZ    = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;

  private bgl0!: GPUBindGroupLayout;
  private bgl1!: GPUBindGroupLayout;

  private _sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly _cameraDynamicOffset = new Uint32Array(1);

  private _entityCache  = new Map<number, EntityGPU>();
  private _obbGeoCache  = new Map<number, GeoGPU>();
  private _wireGeoCache = new Map<number, GeoGPU>();
  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this.engine = engine;
    const { device } = engine;

    this._sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.bgl0 = this._sceneFrameBinding.bindGroupLayout;

    this.bgl1 = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const generated = getBuiltinSimple3dShader(device, 'mesh-helper', [this.bgl0, this.bgl1]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;

  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey();
    this.addPipelineWarmup(plan, key, 'Mesh helper', () => this._pipelineDescriptor(), this.engine.device);
  }

  beginView(sceneFrame: SceneFrameUniformSnapshot): void {
    this._cameraDynamicOffset[0] = this._sceneFrameBinding.upload(sceneFrame);
  }

  releaseEntitiesNotIn(liveEntities: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this._entityCache, liveEntities, data => {
      data.objBuf.destroy();
      data.aabbVertBuf.destroy();
    });
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this.releaseCacheEntriesNotIn(this._obbGeoCache, liveGeometries, data => data.vertBuf.destroy());
    this.releaseCacheEntriesNotIn(this._wireGeoCache, liveGeometries, data => data.vertBuf.destroy());
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId:    number,
    geometry:    Geometry3D,
    helper:      MeshHelper,
    worldMatrix: Float32Array,
  ): void {
    const { device } = this.engine;

    // ── Ensure per-entity GPU data ───────────────────────────────────────────
    let ent = this._entityCache.get(entityId);
    if (!ent) {
      const objBuf = device.createBuffer({
        size:  96, // mat4(64) + vec4(16) + lineWidth/pad(16)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const aabbVertBuf = device.createBuffer({
        size:  288, // 24 * 3 * 4
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const objBG = device.createBindGroup({
        layout: this.bgl1,
        entries: [{ binding: 0, resource: { buffer: objBuf } }],
      });
      ent = {
        objBuf,
        objBG,
        objectData: new Float32Array(24),
        objectModelSnapshot: new Float32Array(16),
        objectColorSnapshot: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        objectLineWidth: Number.NaN,
        objectDirty: true,
        aabbVertBuf,
        aabbLines: new Float32Array(24 * 3),
        aabbMatrixSnapshot: new Float32Array(16),
        aabbGeometryVersion: -1,
      };
      this._entityCache.set(entityId, ent);
    }

    // ── Pick vertex buffer and model matrix ───────────────────────────────────
    let vertBuf: GPUBuffer;
    let segmentCount: number;
    let modelMatrix: Float32Array;

    if (helper.mode === 'aabb') {
      const aabbDirty = ent.aabbGeometryVersion !== geometry.version || !matrixEquals(ent.aabbMatrixSnapshot, worldMatrix);
      if (aabbDirty) {
        // Compute tight world AABB by transforming ALL vertex positions.
        // Transforming only the 8 local-bbox corners overestimates for curved geometry.
        const pos = geometry.positions;
        let wx0 = Infinity,  wy0 = Infinity,  wz0 = Infinity;
        let wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
          const x = requiredNumberAt(pos, i, 'geometry positions');
          const y = requiredNumberAt(pos, i + 1, 'geometry positions');
          const z = requiredNumberAt(pos, i + 2, 'geometry positions');
          const rw = requiredNumberAt(worldMatrix, 3, 'world matrix') * x
            + requiredNumberAt(worldMatrix, 7, 'world matrix') * y
            + requiredNumberAt(worldMatrix, 11, 'world matrix') * z
            + requiredNumberAt(worldMatrix, 15, 'world matrix');
          const invW = rw === 0 ? 1 : 1 / rw;
          const wx = (requiredNumberAt(worldMatrix, 0, 'world matrix') * x + requiredNumberAt(worldMatrix, 4, 'world matrix') * y + requiredNumberAt(worldMatrix, 8, 'world matrix') * z + requiredNumberAt(worldMatrix, 12, 'world matrix')) * invW;
          const wy = (requiredNumberAt(worldMatrix, 1, 'world matrix') * x + requiredNumberAt(worldMatrix, 5, 'world matrix') * y + requiredNumberAt(worldMatrix, 9, 'world matrix') * z + requiredNumberAt(worldMatrix, 13, 'world matrix')) * invW;
          const wz = (requiredNumberAt(worldMatrix, 2, 'world matrix') * x + requiredNumberAt(worldMatrix, 6, 'world matrix') * y + requiredNumberAt(worldMatrix, 10, 'world matrix') * z + requiredNumberAt(worldMatrix, 14, 'world matrix')) * invW;
          if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
          if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
          if (wz < wz0) wz0 = wz; if (wz > wz1) wz1 = wz;
        }
        fillBoxLines(ent.aabbLines, wx0, wy0, wz0, wx1, wy1, wz1);
        device.queue.writeBuffer(
          ent.aabbVertBuf,
          0,
          ent.aabbLines.buffer as ArrayBuffer,
          ent.aabbLines.byteOffset,
          ent.aabbLines.byteLength,
        );
        ent.aabbMatrixSnapshot.set(worldMatrix);
        ent.aabbGeometryVersion = geometry.version;
      }
      vertBuf    = ent.aabbVertBuf;
      segmentCount = 12;
      modelMatrix = IDENTITY_MAT4;

    } else if (helper.mode === 'obb') {
      let geo = this._obbGeoCache.get(geometry.id);
      if (!geo) {
        const bbox = geometry.getBoundingBox();
        const lines = buildBoxLines(
          requiredNumberAt(bbox.min, 0, 'bounding box minimum'),
          requiredNumberAt(bbox.min, 1, 'bounding box minimum'),
          requiredNumberAt(bbox.min, 2, 'bounding box minimum'),
          requiredNumberAt(bbox.max, 0, 'bounding box maximum'),
          requiredNumberAt(bbox.max, 1, 'bounding box maximum'),
          requiredNumberAt(bbox.max, 2, 'bounding box maximum'),
        );
        const buf = device.createBuffer({
          size:  lines.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buf, 0, lines.buffer as ArrayBuffer, lines.byteOffset, lines.byteLength);
        geo = { vertBuf: buf, segmentCount: 12 };
        this._obbGeoCache.set(geometry.id, geo);
      }
      vertBuf    = geo.vertBuf;
      segmentCount = geo.segmentCount;
      modelMatrix = worldMatrix;

    } else {
      // wireframe
      let geo = this._wireGeoCache.get(geometry.id);
      if (!geo) {
        const lines = buildWireframeLines(geometry);
        if (lines.length === 0) return;
        const buf = device.createBuffer({
          size: alignUp4(lines.byteLength),
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buf, 0, lines.buffer as ArrayBuffer, lines.byteOffset, lines.byteLength);
        geo = { vertBuf: buf, segmentCount: lines.length / 6 };
        this._wireGeoCache.set(geometry.id, geo);
      }
      vertBuf    = geo.vertBuf;
      segmentCount = geo.segmentCount;
      modelMatrix = worldMatrix;
    }

    if (segmentCount === 0) return;

    // ── Write object uniform (model + color + line) ──────────────────────────
    const lineWidth = Math.max(1, helper.lineWidth);
    const objectData = ent.objectData;
    helper.color.writeSRGB(objectData, 16);
    const colorChanged =
      ent.objectColorSnapshot[0] !== objectData[16] ||
      ent.objectColorSnapshot[1] !== objectData[17] ||
      ent.objectColorSnapshot[2] !== objectData[18] ||
      ent.objectColorSnapshot[3] !== objectData[19];
    const objectChanged =
      ent.objectDirty ||
      colorChanged ||
      ent.objectLineWidth !== lineWidth ||
      !matrixEquals(ent.objectModelSnapshot, modelMatrix);
    if (objectChanged) {
      objectData.set(modelMatrix, 0);
      objectData[20] = lineWidth;
      objectData[21] = 0;
      objectData[22] = 0;
      objectData[23] = 0;
      device.queue.writeBuffer(ent.objBuf, 0, objectData.buffer as ArrayBuffer, objectData.byteOffset, objectData.byteLength);
      ent.objectModelSnapshot.set(modelMatrix);
      ent.objectColorSnapshot[0] = objectData[16]!;
      ent.objectColorSnapshot[1] = objectData[17]!;
      ent.objectColorSnapshot[2] = objectData[18]!;
      ent.objectColorSnapshot[3] = objectData[19]!;
      ent.objectLineWidth = lineWidth;
      ent.objectDirty = false;
    }

    // ── Draw ─────────────────────────────────────────────────────────────────
    const pipeline = this._getPipeline();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    passEncoder.setBindGroup(1, ent.objBG);
    passEncoder.setVertexBuffer(0, vertBuf);
    passEncoder.draw(18, segmentCount);
  }

  private _getPipeline(): GPURenderPipeline {
    const key = this._pipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this._pipelineDescriptor()));
  }

  private _pipelineKey(): string {
    return `mesh-helper|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 24,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.engine.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
      multisample: { count: this.msaaSamples },
    };
  }

  destroy(): void {
    this._sceneFrameBinding?.destroy();
    this.clearPipelineCache();
    this.destroyCacheEntries(this._entityCache, e => {
      e.objBuf.destroy();
      e.aabbVertBuf.destroy();
    });
    this.destroyCacheEntries(this._obbGeoCache, g => g.vertBuf.destroy());
    this.destroyCacheEntries(this._wireGeoCache, g => g.vertBuf.destroy());
  }
}
