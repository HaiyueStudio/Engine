const PRESENT_SHADER = [
  'struct VertexOutput {',
  '  @builtin(position) position: vec4f,',
  '  @location(0) uv: vec2f,',
  '}',
  '@vertex',
  'fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {',
  '  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));',
  '  let position = positions[index];',
  '  var output: VertexOutput;',
  '  output.position = vec4f(position, 0.0, 1.0);',
  '  output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5);',
  '  return output;',
  '}',
  '@group(0) @binding(0) var sourceSampler: sampler;',
  '@group(0) @binding(1) var sourceTexture: texture_2d<f32>;',
  '@fragment',
  'fn fragment_main(input: VertexOutput) -> @location(0) vec4f {',
  '  return textureSample(sourceTexture, sourceSampler, input.uv);',
  '}',
].join('\n');

export class ProgressiveCanvasPresenter {
  private readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private width = 0;
  private height = 0;
  private destroyed = false;

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    pipeline: GPURenderPipeline,
  ) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.format = format;
    this.pipeline = pipeline;
    this.sampler = device.createSampler({
      label: 'ray-orbit-present-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  static async create(device: GPUDevice, canvas: HTMLCanvasElement): Promise<ProgressiveCanvasPresenter> {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('RAY_ORBIT_WEBGPU_CANVAS_UNAVAILABLE');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const module = device.createShaderModule({
      label: 'ray-orbit-present-shader',
      code: PRESENT_SHADER,
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(message => message.type === 'error');
    if (errors.length > 0) {
      throw new Error('RAY_ORBIT_PRESENT_SHADER_FAILED:' + errors.map(error => error.message).join('; '));
    }
    const pipeline = await device.createRenderPipelineAsync({
      label: 'ray-orbit-present-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex_main' },
      fragment: { module, entryPoint: 'fragment_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    return new ProgressiveCanvasPresenter(device, canvas, context, format, pipeline);
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return;
    if (width === this.width && height === this.height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });
    this.width = width;
    this.height = height;
  }

  present(source: GPUTexture): void {
    if (this.destroyed) return;
    const bindGroup = this.device.createBindGroup({
      label: 'ray-orbit-present-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: source.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder({ label: 'ray-orbit-present-frame' });
    const pass = encoder.beginRenderPass({
      label: 'ray-orbit-present-pass',
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.005, g: 0.008, b: 0.018, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.context.unconfigure();
  }
}
