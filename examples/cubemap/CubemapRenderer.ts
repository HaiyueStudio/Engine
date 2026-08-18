import type { HaiyueEngine } from '@haiyue/engine';
import { createSphere3D, type Geometry3D } from '@haiyue/engine/geometry';
import {
  beginRenderCommandPass,
  type RenderCommandContext,
} from '@haiyue/engine/experimental';
import { mat4 } from 'wgpu-matrix';

const UNIFORM_FLOATS = 56;

const COMMON_WGSL = /* wgsl */`
struct SceneUniforms {
  inverseViewProjection : mat4x4<f32>,
  viewProjection : mat4x4<f32>,
  model : mat4x4<f32>,
  cameraPosition : vec4<f32>,
  params : vec4<f32>, // environment rotation, reflectivity, exposure, time
}

@group(0) @binding(0) var<uniform> scene : SceneUniforms;
@group(0) @binding(1) var environmentSampler : sampler;
@group(0) @binding(2) var environmentTexture : texture_cube<f32>;

fn rotateY(direction : vec3<f32>, angle : f32) -> vec3<f32> {
  let cosine = cos(angle);
  let sine = sin(angle);
  return vec3<f32>(
    cosine * direction.x - sine * direction.z,
    direction.y,
    sine * direction.x + cosine * direction.z,
  );
}
`;

const SKY_WGSL = /* wgsl */`${COMMON_WGSL}
struct SkyOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) clipPosition : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> SkyOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output : SkyOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.999999, 1.0);
  output.clipPosition = positions[vertexIndex];
  return output;
}

@fragment
fn fs_main(input : SkyOutput) -> @location(0) vec4<f32> {
  let farPoint = scene.inverseViewProjection * vec4<f32>(input.clipPosition, 1.0, 1.0);
  let worldPoint = farPoint.xyz / farPoint.w;
  let direction = rotateY(normalize(worldPoint - scene.cameraPosition.xyz), scene.params.x);
  let color = textureSample(environmentTexture, environmentSampler, direction).rgb * scene.params.z;
  let horizon = pow(1.0 - abs(direction.y), 5.0) * 0.09;
  return vec4<f32>(color + horizon * vec3<f32>(0.2, 0.36, 0.54), 1.0);
}
`;

const REFLECTION_WGSL = /* wgsl */`${COMMON_WGSL}
struct SphereInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
}

struct SphereOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) worldPosition : vec3<f32>,
  @location(1) normal : vec3<f32>,
}

@vertex
fn vs_main(input : SphereInput) -> SphereOutput {
  let world = scene.model * vec4<f32>(input.position, 1.0);
  var output : SphereOutput;
  output.position = scene.viewProjection * world;
  output.worldPosition = world.xyz;
  output.normal = normalize((scene.model * vec4<f32>(input.normal, 0.0)).xyz);
  return output;
}

@fragment
fn fs_main(input : SphereOutput) -> @location(0) vec4<f32> {
  let incident = normalize(input.worldPosition - scene.cameraPosition.xyz);
  let viewDirection = -incident;
  let normal = normalize(input.normal);
  let reflected = rotateY(reflect(incident, normal), scene.params.x);
  let environment = textureSample(environmentTexture, environmentSampler, reflected).rgb * scene.params.z;
  let fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(normal, viewDirection), 0.0), 5.0);
  let reflectionWeight = clamp(scene.params.y * (0.72 + fresnel * 0.28), 0.0, 1.0);
  let base = vec3<f32>(0.018, 0.028, 0.045);
  let color = mix(base, environment, reflectionWeight);
  let rim = fresnel * vec3<f32>(0.28, 0.52, 0.72);
  return vec4<f32>(color + rim, 1.0);
}
`;

export interface CubemapCamera {
  yaw: number;
  pitch: number;
  radius: number;
}

export interface CubemapFrameOptions {
  readonly camera: CubemapCamera;
  readonly environmentRotation: number;
  readonly reflectivity: number;
  readonly exposure: number;
  readonly timeSeconds: number;
}

export class CubemapRenderer {
  readonly sphereVertexCount: number;
  readonly sphereIndexCount: number;

  private readonly _uniformData = new Float32Array(UNIFORM_FLOATS);
  private readonly _view = mat4.identity() as Float32Array;
  private readonly _projection = mat4.identity() as Float32Array;
  private readonly _viewProjection = mat4.identity() as Float32Array;
  private readonly _inverseViewProjection = mat4.identity() as Float32Array;
  private readonly _model = mat4.identity() as Float32Array;
  private readonly _modelX = mat4.identity() as Float32Array;
  private readonly _modelY = mat4.identity() as Float32Array;
  private _destroyed = false;

  private constructor(
    private readonly _engine: HaiyueEngine,
    private readonly _uniformBuffer: GPUBuffer,
    private readonly _positionBuffer: GPUBuffer,
    private readonly _normalBuffer: GPUBuffer,
    private readonly _indexBuffer: GPUBuffer,
    private readonly _indexFormat: GPUIndexFormat,
    private readonly _bindGroup: GPUBindGroup,
    private readonly _skyPipeline: GPURenderPipeline,
    private readonly _reflectionPipeline: GPURenderPipeline,
    geometry: Geometry3D,
  ) {
    this.sphereVertexCount = geometry.vertexCount;
    this.sphereIndexCount = geometry.indices?.length ?? 0;
  }

  static async create(engine: HaiyueEngine, cubeView: GPUTextureView): Promise<CubemapRenderer> {
    const geometry = createSphere3D({ radius: 1.32, widthSegments: 64, heightSegments: 36 });
    if (!geometry.normals || !geometry.indices) {
      throw new Error('Cubemap reflection sphere requires normals and indices.');
    }
    const { device } = engine;
    const uniformBuffer = device.createBuffer({
      label: 'CubemapExample.uniforms',
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const positionBuffer = createGpuBuffer(device, 'CubemapExample.positions', geometry.positions, GPUBufferUsage.VERTEX);
    const normalBuffer = createGpuBuffer(device, 'CubemapExample.normals', geometry.normals, GPUBufferUsage.VERTEX);
    const indexBuffer = createGpuBuffer(device, 'CubemapExample.indices', geometry.indices, GPUBufferUsage.INDEX);
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'CubemapExample.bindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
      ],
    });
    const bindGroup = device.createBindGroup({
      label: 'CubemapExample.bindGroup',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: device.createSampler({
          label: 'CubemapExample.sampler',
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
          addressModeW: 'clamp-to-edge',
        }) },
        { binding: 2, resource: cubeView },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: 'CubemapExample.pipelineLayout',
      bindGroupLayouts: [bindGroupLayout],
    });
    const skyModule = device.createShaderModule({ label: 'CubemapExample.skyShader', code: SKY_WGSL });
    const reflectionModule = device.createShaderModule({ label: 'CubemapExample.reflectionShader', code: REFLECTION_WGSL });
    const [skyPipeline, reflectionPipeline] = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'CubemapExample.skyPipeline',
        layout: pipelineLayout,
        vertex: { module: skyModule, entryPoint: 'vs_main' },
        fragment: { module: skyModule, entryPoint: 'fs_main', targets: [{ format: engine.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
          format: engine.getDepthFormat(),
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
        multisample: { count: engine.msaaSamples },
      }),
      device.createRenderPipelineAsync({
        label: 'CubemapExample.reflectionPipeline',
        layout: pipelineLayout,
        vertex: {
          module: reflectionModule,
          entryPoint: 'vs_main',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          ],
        },
        fragment: { module: reflectionModule, entryPoint: 'fs_main', targets: [{ format: engine.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: {
          format: engine.getDepthFormat(),
          depthWriteEnabled: true,
          depthCompare: 'less',
        },
        multisample: { count: engine.msaaSamples },
      }),
    ]);

    return new CubemapRenderer(
      engine,
      uniformBuffer,
      positionBuffer,
      normalBuffer,
      indexBuffer,
      geometry.indices instanceof Uint16Array ? 'uint16' : 'uint32',
      bindGroup,
      skyPipeline,
      reflectionPipeline,
      geometry,
    );
  }

  update(options: CubemapFrameOptions): void {
    if (this._destroyed) return;
    const { camera } = options;
    const cosPitch = Math.cos(camera.pitch);
    const eye: [number, number, number] = [
      Math.sin(camera.yaw) * cosPitch * camera.radius,
      Math.sin(camera.pitch) * camera.radius,
      Math.cos(camera.yaw) * cosPitch * camera.radius,
    ];
    mat4.lookAt(eye, [0, 0, 0], [0, 1, 0], this._view);
    mat4.perspective(
      Math.PI / 3.25,
      Math.max(1, this._engine.width) / Math.max(1, this._engine.height),
      0.1,
      80,
      this._projection,
    );
    mat4.multiply(this._projection, this._view, this._viewProjection);
    mat4.inverse(this._viewProjection, this._inverseViewProjection);
    mat4.rotationX(-0.08 + Math.sin(options.timeSeconds * 0.45) * 0.04, this._modelX);
    mat4.rotationY(options.timeSeconds * 0.12, this._modelY);
    mat4.multiply(this._modelY, this._modelX, this._model);

    this._uniformData.set(this._inverseViewProjection, 0);
    this._uniformData.set(this._viewProjection, 16);
    this._uniformData.set(this._model, 32);
    this._uniformData.set([eye[0], eye[1], eye[2], 1], 48);
    this._uniformData.set([
      options.environmentRotation,
      Math.min(1, Math.max(0, options.reflectivity)),
      Math.max(0, options.exposure),
      options.timeSeconds,
    ], 52);
    this._engine.device.queue.writeBuffer(
      this._uniformBuffer,
      0,
      this._uniformData.buffer as ArrayBuffer,
      this._uniformData.byteOffset,
      this._uniformData.byteLength,
    );
  }

  record(context: RenderCommandContext): void {
    if (this._destroyed) return;
    const { passEncoder: pass, ownsPass } = beginRenderCommandPass(context);
    pass.setBindGroup(0, this._bindGroup);
    pass.setPipeline(this._skyPipeline);
    pass.draw(3);
    pass.setPipeline(this._reflectionPipeline);
    pass.setVertexBuffer(0, this._positionBuffer);
    pass.setVertexBuffer(1, this._normalBuffer);
    pass.setIndexBuffer(this._indexBuffer, this._indexFormat);
    pass.drawIndexed(this.sphereIndexCount);
    if (ownsPass) pass.end();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._uniformBuffer.destroy();
    this._positionBuffer.destroy();
    this._normalBuffer.destroy();
    this._indexBuffer.destroy();
  }
}

type GeometryBufferData = Float32Array | Uint16Array | Uint32Array;

function createGpuBuffer(
  device: GPUDevice,
  label: string,
  data: GeometryBufferData,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    buffer,
    0,
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength,
  );
  return buffer;
}
