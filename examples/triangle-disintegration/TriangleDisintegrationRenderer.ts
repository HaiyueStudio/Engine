import type { HaiyueEngine } from '@haiyue/engine';
import type { Geometry3D } from '@haiyue/engine/geometry';
import {
  beginRenderCommandPass,
  type RenderCommandContext,
} from '@haiyue/engine/experimental';
import { mat4 } from 'wgpu-matrix';
import { requiredNumberAt } from '../arrayAccess';

const UNIFORM_FLOATS = 48;
const TRIANGLE_DATA_FLOATS = 12;
const DUST_PARTICLES_PER_TRIANGLE = 2;

const COMMON_WGSL = /* wgsl */`
struct SceneUniforms {
  viewProjection : mat4x4<f32>,
  model : mat4x4<f32>,
  cameraRight : vec4<f32>,
  cameraUp : vec4<f32>,
  params : vec4<f32>, // progress, time, scatter distance, triangle count
  light : vec4<f32>,
}

struct TriangleData {
  centerDelay : vec4<f32>,
  directionSpin : vec4<f32>,
  axisSeed : vec4<f32>,
}

@group(0) @binding(0) var<uniform> scene : SceneUniforms;
@group(0) @binding(1) var<storage, read> triangles : array<TriangleData>;

fn rotateAroundAxis(value: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let sine = sin(angle);
  let cosine = cos(angle);
  return value * cosine + cross(axis, value) * sine + axis * dot(axis, value) * (1.0 - cosine);
}

fn triangleProgress(delay: f32) -> f32 {
  return smoothstep(delay, min(1.0, delay + 0.30), scene.params.x);
}

fn triangleOffset(data: TriangleData, progress: f32) -> vec3<f32> {
  let scatter = data.directionSpin.xyz * (progress * progress * scene.params.z);
  let swirl = data.axisSeed.xyz * sin(progress * 9.0 + data.axisSeed.w * 6.28318) * progress * 0.38;
  let lift = vec3<f32>(0.0, progress * 1.2 - progress * progress * 0.18, 0.0);
  return scatter + swirl + lift;
}
`;

const MESH_WGSL = /* wgsl */`${COMMON_WGSL}
struct MeshInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @builtin(vertex_index) vertexIndex : u32,
}

struct MeshOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) effect : vec2<f32>,
}

@vertex
fn vs_main(input: MeshInput) -> MeshOutput {
  let data = triangles[input.vertexIndex / 3u];
  let progress = triangleProgress(data.centerDelay.w);
  let scale = 1.0 - smoothstep(0.48, 1.0, progress) * 0.84;
  let angle = progress * data.directionSpin.w;
  let local = rotateAroundAxis((input.position - data.centerDelay.xyz) * scale, data.axisSeed.xyz, angle);
  let displaced = data.centerDelay.xyz + local + triangleOffset(data, progress);
  let rotatedNormal = rotateAroundAxis(input.normal, data.axisSeed.xyz, angle);
  let world = scene.model * vec4<f32>(displaced, 1.0);

  var output : MeshOutput;
  output.position = scene.viewProjection * world;
  output.normal = normalize((scene.model * vec4<f32>(rotatedNormal, 0.0)).xyz);
  output.effect = vec2<f32>(progress, data.axisSeed.w);
  return output;
}

@fragment
fn fs_main(input: MeshOutput) -> @location(0) vec4<f32> {
  let progress = input.effect.x;
  let diffuse = 0.24 + max(dot(normalize(input.normal), normalize(scene.light.xyz)), 0.0) * 0.76;
  let intact = vec3<f32>(0.075, 0.34, 0.56) + vec3<f32>(0.12, 0.08, 0.02) * input.effect.y;
  let ash = vec3<f32>(0.24, 0.22, 0.20);
  let emberBand = smoothstep(0.015, 0.12, progress) * (1.0 - smoothstep(0.24, 0.52, progress));
  let ember = vec3<f32>(1.0, 0.24, 0.025) * emberBand * 1.8;
  let color = mix(intact * diffuse, ash * (0.42 + diffuse * 0.36), smoothstep(0.08, 0.62, progress)) + ember;
  let alpha = 1.0 - smoothstep(0.58, 0.98, progress);
  if (alpha < 0.015) { discard; }
  return vec4<f32>(color, alpha);
}
`;

const DUST_WGSL = /* wgsl */`${COMMON_WGSL}
fn hash(value: f32) -> f32 {
  return fract(sin(value * 91.3458 + 17.173) * 47453.5453);
}

struct DustOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) effect : vec2<f32>,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
) -> DustOutput {
  let triangleIndex = instanceIndex / ${DUST_PARTICLES_PER_TRIANGLE}u;
  let lane = instanceIndex % ${DUST_PARTICLES_PER_TRIANGLE}u;
  let data = triangles[triangleIndex];
  let laneF = f32(lane);
  let delay = data.centerDelay.w + laneF * 0.018;
  let progress = smoothstep(delay, min(1.0, delay + 0.34), scene.params.x);
  let randomA = hash(data.axisSeed.w * 17.0 + laneF * 3.1);
  let randomB = hash(data.axisSeed.w * 29.0 + laneF * 7.7);
  let jitter = vec3<f32>(randomA - 0.5, randomB - 0.25, hash(randomA * 13.0) - 0.5);
  let localCenter = data.centerDelay.xyz
    + triangleOffset(data, progress) * (1.08 + laneF * 0.16)
    + jitter * progress * 0.62;
  let worldCenter = (scene.model * vec4<f32>(localCenter, 1.0)).xyz;
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let corner = corners[vertexIndex];
  let size = mix(0.025, 0.075, randomA) * (1.0 - progress * 0.72);
  let world = worldCenter + scene.cameraRight.xyz * corner.x * size + scene.cameraUp.xyz * corner.y * size;

  var output : DustOutput;
  output.position = scene.viewProjection * vec4<f32>(world, 1.0);
  output.local = corner;
  output.effect = vec2<f32>(progress, randomB);
  return output;
}

@fragment
fn fs_main(input: DustOutput) -> @location(0) vec4<f32> {
  let radial = 1.0 - smoothstep(0.12, 1.0, length(input.local));
  let life = smoothstep(0.025, 0.18, input.effect.x) * (1.0 - smoothstep(0.62, 1.0, input.effect.x));
  let color = mix(vec3<f32>(1.0, 0.28, 0.035), vec3<f32>(0.28, 0.25, 0.22), input.effect.x);
  let alpha = radial * life * mix(0.38, 0.92, input.effect.y);
  if (alpha < 0.01) { discard; }
  return vec4<f32>(color, alpha);
}
`;

const STAGE_WGSL = /* wgsl */`
struct SceneUniforms {
  viewProjection : mat4x4<f32>,
  model : mat4x4<f32>,
  cameraRight : vec4<f32>,
  cameraUp : vec4<f32>,
  params : vec4<f32>,
  light : vec4<f32>,
}
@group(0) @binding(0) var<uniform> scene : SceneUniforms;

struct StageOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) world : vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> StageOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-9.0, -9.0), vec2<f32>(9.0, -9.0), vec2<f32>(9.0, 9.0),
    vec2<f32>(-9.0, -9.0), vec2<f32>(9.0, 9.0), vec2<f32>(-9.0, 9.0),
  );
  let corner = corners[vertexIndex];
  let world = vec3<f32>(corner.x, -2.18, corner.y);
  var output : StageOutput;
  output.position = scene.viewProjection * vec4<f32>(world, 1.0);
  output.world = world;
  return output;
}

@fragment
fn fs_main(input: StageOutput) -> @location(0) vec4<f32> {
  let gridX = 1.0 - smoothstep(0.0, 0.035, abs(fract(input.world.x * 0.5 + 0.5) - 0.5));
  let gridZ = 1.0 - smoothstep(0.0, 0.035, abs(fract(input.world.z * 0.5 + 0.5) - 0.5));
  let grid = max(gridX, gridZ);
  let glow = exp(-length(input.world.xz) * 0.32);
  let base = vec3<f32>(0.012, 0.018, 0.028) + glow * vec3<f32>(0.018, 0.052, 0.075);
  return vec4<f32>(base + grid * vec3<f32>(0.018, 0.055, 0.075) * glow, 1.0);
}
`;

export interface DisintegrationCamera {
  yaw: number;
  pitch: number;
  radius: number;
}

export class TriangleDisintegrationRenderer {
  readonly triangleCount: number;
  readonly particleCount: number;

  private readonly _uniformData = new Float32Array(UNIFORM_FLOATS);
  private readonly _viewProjection = mat4.identity() as Float32Array;
  private readonly _view = mat4.identity() as Float32Array;
  private readonly _projection = mat4.identity() as Float32Array;
  private readonly _model = mat4.identity() as Float32Array;
  private readonly _modelX = mat4.identity() as Float32Array;
  private readonly _modelY = mat4.identity() as Float32Array;
  private _destroyed = false;

  private constructor(
    private readonly _engine: HaiyueEngine,
    private readonly _geometry: Geometry3D,
    private readonly _positionBuffer: GPUBuffer,
    private readonly _normalBuffer: GPUBuffer,
    private readonly _triangleBuffer: GPUBuffer,
    private readonly _uniformBuffer: GPUBuffer,
    private readonly _bindGroup: GPUBindGroup,
    private readonly _stagePipeline: GPURenderPipeline,
    private readonly _meshPipeline: GPURenderPipeline,
    private readonly _dustPipeline: GPURenderPipeline,
  ) {
    this.triangleCount = _geometry.vertexCount / 3;
    this.particleCount = this.triangleCount * DUST_PARTICLES_PER_TRIANGLE;
  }

  static async create(engine: HaiyueEngine, geometry: Geometry3D): Promise<TriangleDisintegrationRenderer> {
    if (geometry.indices !== null || geometry.vertexCount === 0 || geometry.vertexCount % 3 !== 0) {
      throw new Error('Triangle disintegration requires a non-empty separated triangle geometry.');
    }
    if (!geometry.normals) throw new Error('Triangle disintegration requires vertex normals.');

    const { device } = engine;
    const triangleData = createTriangleData(geometry);
    const positionBuffer = createGpuBuffer(device, 'TriangleDisintegration.positions', geometry.positions, GPUBufferUsage.VERTEX);
    const normalBuffer = createGpuBuffer(device, 'TriangleDisintegration.normals', geometry.normals, GPUBufferUsage.VERTEX);
    const triangleBuffer = createGpuBuffer(device, 'TriangleDisintegration.triangles', triangleData, GPUBufferUsage.STORAGE);
    const uniformBuffer = device.createBuffer({
      label: 'TriangleDisintegration.uniforms',
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'TriangleDisintegration.bindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: 'TriangleDisintegration.pipelineLayout',
      bindGroupLayouts: [bindGroupLayout],
    });
    const bindGroup = device.createBindGroup({
      label: 'TriangleDisintegration.bindGroup',
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: triangleBuffer } },
      ],
    });
    const colorTarget: GPUColorTargetState = {
      format: engine.format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    };
    const depthFormat = engine.getDepthFormat();
    const meshModule = device.createShaderModule({ label: 'TriangleDisintegration.meshShader', code: MESH_WGSL });
    const dustModule = device.createShaderModule({ label: 'TriangleDisintegration.dustShader', code: DUST_WGSL });
    const stageModule = device.createShaderModule({ label: 'TriangleDisintegration.stageShader', code: STAGE_WGSL });
    const common = {
      layout: pipelineLayout,
      primitive: { topology: 'triangle-list' as const, cullMode: 'back' as const },
      multisample: { count: engine.msaaSamples },
    };
    const [stagePipeline, meshPipeline, dustPipeline] = await Promise.all([
      device.createRenderPipelineAsync({
        ...common,
        label: 'TriangleDisintegration.stagePipeline',
        vertex: { module: stageModule, entryPoint: 'vs_main' },
        fragment: { module: stageModule, entryPoint: 'fs_main', targets: [{ format: engine.format }] },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        ...common,
        label: 'TriangleDisintegration.meshPipeline',
        vertex: {
          module: meshModule,
          entryPoint: 'vs_main',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          ],
        },
        fragment: { module: meshModule, entryPoint: 'fs_main', targets: [colorTarget] },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        ...common,
        label: 'TriangleDisintegration.dustPipeline',
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        vertex: { module: dustModule, entryPoint: 'vs_main' },
        fragment: {
          module: dustModule,
          entryPoint: 'fs_main',
          targets: [{
            format: engine.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          }],
        },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
      }),
    ]);

    return new TriangleDisintegrationRenderer(
      engine,
      geometry,
      positionBuffer,
      normalBuffer,
      triangleBuffer,
      uniformBuffer,
      bindGroup,
      stagePipeline,
      meshPipeline,
      dustPipeline,
    );
  }

  update(progress: number, timeSeconds: number, camera: DisintegrationCamera): void {
    if (this._destroyed) return;
    const target: readonly [number, number, number] = [0, -0.05, 0];
    const cosPitch = Math.cos(camera.pitch);
    const eye: [number, number, number] = [
      target[0] + Math.sin(camera.yaw) * cosPitch * camera.radius,
      target[1] + Math.sin(camera.pitch) * camera.radius,
      target[2] + Math.cos(camera.yaw) * cosPitch * camera.radius,
    ];
    mat4.lookAt(eye, target, [0, 1, 0], this._view);
    mat4.perspective(
      Math.PI / 4.2,
      Math.max(1, this._engine.width) / Math.max(1, this._engine.height),
      0.1,
      100,
      this._projection,
    );
    mat4.multiply(this._projection, this._view, this._viewProjection);
    mat4.rotationX(-0.12, this._modelX);
    mat4.rotationY(0.42 + Math.sin(timeSeconds * 0.22) * 0.045, this._modelY);
    mat4.multiply(this._modelY, this._modelX, this._model);

    const forward = normalize3([
      target[0] - eye[0],
      target[1] - eye[1],
      target[2] - eye[2],
    ]);
    const right = normalize3(cross3(forward, [0, 1, 0]));
    const up = normalize3(cross3(right, forward));
    this._uniformData.set(this._viewProjection, 0);
    this._uniformData.set(this._model, 16);
    this._uniformData.set([right[0], right[1], right[2], 0], 32);
    this._uniformData.set([up[0], up[1], up[2], 0], 36);
    this._uniformData.set([Math.min(1, Math.max(0, progress)), timeSeconds, 5.7, this.triangleCount], 40);
    this._uniformData.set([0.38, 0.82, 0.52, 0], 44);
    this._engine.device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData);
  }

  record(context: RenderCommandContext): void {
    if (this._destroyed) return;
    const { passEncoder: pass, ownsPass } = beginRenderCommandPass(context);
    pass.setBindGroup(0, this._bindGroup);
    pass.setPipeline(this._stagePipeline);
    pass.draw(6);
    pass.setPipeline(this._meshPipeline);
    pass.setVertexBuffer(0, this._positionBuffer);
    pass.setVertexBuffer(1, this._normalBuffer);
    pass.draw(this._geometry.vertexCount);
    pass.setPipeline(this._dustPipeline);
    pass.draw(6, this.particleCount);
    if (ownsPass) pass.end();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._positionBuffer.destroy();
    this._normalBuffer.destroy();
    this._triangleBuffer.destroy();
    this._uniformBuffer.destroy();
  }
}

function createTriangleData(geometry: Geometry3D): Float32Array {
  const triangleCount = geometry.vertexCount / 3;
  const data = new Float32Array(triangleCount * TRIANGLE_DATA_FLOATS);
  const positions = geometry.positions;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const vertexOffset = triangle * 9;
    const center: [number, number, number] = [
      (requiredNumberAt(positions, vertexOffset, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 3, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 6, 'separated positions')) / 3,
      (requiredNumberAt(positions, vertexOffset + 1, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 4, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 7, 'separated positions')) / 3,
      (requiredNumberAt(positions, vertexOffset + 2, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 5, 'separated positions')
        + requiredNumberAt(positions, vertexOffset + 8, 'separated positions')) / 3,
    ];
    const randomA = hash(triangle, 1);
    const randomB = hash(triangle, 2);
    const randomC = hash(triangle, 3);
    const outward = normalize3(center);
    const direction = normalize3([
      1.2 + randomA * 0.95 + outward[0] * 0.38,
      0.28 + randomB * 0.72 + outward[1] * 0.22,
      (randomC - 0.5) * 0.9 + outward[2] * 0.38,
    ]);
    const axis = normalize3([
      randomB * 2 - 1,
      randomC * 2 - 1,
      randomA * 2 - 1,
    ]);
    const sweep = (center[0] / 3.4 + 0.5) * 0.58
      + (center[1] / 3.4 + 0.5) * 0.08
      + randomC * 0.17;
    const delay = Math.min(0.76, Math.max(0.025, sweep));
    const spin = (4.5 + randomB * 7.5) * (randomA > 0.5 ? 1 : -1);
    const offset = triangle * TRIANGLE_DATA_FLOATS;
    data.set([
      center[0], center[1], center[2], delay,
      direction[0], direction[1], direction[2], spin,
      axis[0], axis[1], axis[2], randomA,
    ], offset);
  }
  return data;
}

function createGpuBuffer(
  device: GPUDevice,
  label: string,
  data: Float32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, data.byteLength),
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

function hash(index: number, salt: number): number {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 0.000_001
    ? [value[0] / length, value[1] / length, value[2] / length]
    : [0, 1, 0];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
