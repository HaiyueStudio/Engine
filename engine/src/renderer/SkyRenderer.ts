import type { IEngine } from '../core/IEngine';
import { Sky } from '../components/Sky';
import { BaseRenderer } from './BaseRenderer';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { getBuiltinSimple3dShader } from '../shader/BuiltinSimple3dShader';

export class SkyRenderer extends BaseRenderer {
  readonly type = 'sky';

  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly cameraDynamicOffset = new Uint32Array(1);
  private skyBindGroupLayout!: GPUBindGroupLayout;
  private skyBindGroup!: GPUBindGroup;
  private skyUniformBuffer!: GPUBuffer;
  private shaderModule!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private initialized = false;
  private uniformData = new Float32Array(12);

  prepare(engine: IEngine): void {
    if (this.initialized) return;
    this.clearPipelineCache();
    this.initialized = true;
    this.engine = engine;

    const { device } = engine;
    this.sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this.skyBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.skyUniformBuffer = device.createBuffer({
      label: 'SkyRenderer.params',
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.skyBindGroup = device.createBindGroup({
      layout: this.skyBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
    });
    const generated = getBuiltinSimple3dShader(device, 'sky', [
      this.sceneFrameBinding.bindGroupLayout,
      this.skyBindGroupLayout,
    ]);
    this.shaderModule = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
  }

  beginView(sceneFrame: SceneFrameUniformSnapshot): void {
    this.cameraDynamicOffset[0] = this.sceneFrameBinding.upload(sceneFrame);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    sky: Sky,
  ): void {
    const uniformData = this.uniformData;
    const [sx, sy, sz] = sky.sunPosition;
    uniformData[0] = sx;
    uniformData[1] = sy;
    uniformData[2] = sz;
    uniformData[3] = 0;
    uniformData[4] = sky.turbidity;
    uniformData[5] = sky.rayleigh;
    uniformData[6] = sky.mieCoefficient;
    uniformData[7] = sky.mieDirectionalG;
    uniformData[8] = sky.exposure;
    uniformData[9] = 0;
    uniformData[10] = 0;
    uniformData[11] = 0;
    this.engine.device.queue.writeBuffer(this.skyUniformBuffer, 0, uniformData);

    passEncoder.setPipeline(this.getPipeline());
    passEncoder.setBindGroup(0, this.sceneFrameBinding.bindGroup, this.cameraDynamicOffset);
    passEncoder.setBindGroup(1, this.skyBindGroup);
    passEncoder.draw(3, 1, 0, 0);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey();
    this.addPipelineWarmup(plan, key, 'Procedural sky', () => this._pipelineDescriptor(), this.engine.device);
  }

  private getPipeline(): GPURenderPipeline {
    const key = this._pipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this._pipelineDescriptor()));
  }

  private _pipelineKey(): number {
    return (this.reverseZ ? 1 : 0) | ((this.msaaSamples > 1 ? 1 : 0) << 1);
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
      const { format } = this.engine;
      return {
        layout: this.pipelineLayout,
        vertex: {
          module: this.shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: this.shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format }],
        },
        primitive: {
          topology: 'triangle-list',
          cullMode: 'none',
        },
        depthStencil: {
          format: this.engine.getDepthFormat(this.reverseZ),
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
        multisample: { count: this.msaaSamples },
      };
  }

  releaseEntitiesNotIn(_liveEntities: ReadonlySet<number> | ReadonlyMap<number, unknown>): void {}

  releaseGeometriesNotIn(_liveGeometries: ReadonlySet<number> | ReadonlyMap<number, unknown>): void {}

  releaseMaterialsNotIn(_liveMaterials: ReadonlySet<number> | ReadonlyMap<number, unknown>): void {}

  destroy(): void {
    this.sceneFrameBinding?.destroy();
    this.skyUniformBuffer?.destroy();
    this.clearPipelineCache();
  }
}
