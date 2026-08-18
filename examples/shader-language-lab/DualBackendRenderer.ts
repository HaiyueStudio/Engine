import { SHADER_LANGUAGE_SHOWCASE } from './generated/showcase.generated';
import { packReflectedUniforms, paintRgbaPixels } from './RuntimeSupport';

const WIDTH = 384;
const HEIGHT = 384;
const TEXTURE_SIZE = 64;

type UniformLayout = typeof SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.uniformBlocks[number];

export interface ShowcaseUniformState {
  time: number;
  noiseScale: number;
  noiseStrength: number;
  gradientBias: number;
  scanStrength: number;
  vignetteStrength: number;
  tintA: readonly [number, number, number, number];
  tintB: readonly [number, number, number, number];
}

export interface BackendEvidence {
  readonly webgpuCompilationErrorCount: number;
  readonly webgpuValidationErrorCount: number;
  readonly webglCompileErrorCount: number;
  readonly webglLinkErrorCount: number;
}

export interface PixelDifference {
  readonly maxChannelDelta: number;
  readonly meanAbsoluteDelta: number;
  readonly changedPixelRatio: number;
  readonly changedPixelCount: number;
}

export interface DualBackendFrame {
  readonly difference: PixelDifference;
  readonly uniformWriteCount: number;
  readonly pipelineRebuildCount: number;
}

export class DualBackendRenderer {
  readonly evidence: BackendEvidence;
  private uniformWriteCount = 0;
  private readonly webgpu: WebGpuShowcaseRenderer;
  private readonly webgl2: WebGl2ShowcaseRenderer;
  private readonly differenceContext: CanvasRenderingContext2D;

  private constructor(
    webgpu: WebGpuShowcaseRenderer,
    webgl2: WebGl2ShowcaseRenderer,
    differenceContext: CanvasRenderingContext2D,
  ) {
    this.webgpu = webgpu;
    this.webgl2 = webgl2;
    this.differenceContext = differenceContext;
    this.evidence = Object.freeze({
      webgpuCompilationErrorCount: webgpu.compilationErrorCount,
      webgpuValidationErrorCount: webgpu.validationErrorCount,
      webglCompileErrorCount: webgl2.compileErrorCount,
      webglLinkErrorCount: webgl2.linkErrorCount,
    });
  }

  static async create(
    webgpuCanvas: HTMLCanvasElement,
    webglCanvas: HTMLCanvasElement,
    differenceCanvas: HTMLCanvasElement,
  ): Promise<DualBackendRenderer> {
    configureCanvas(webgpuCanvas);
    configureCanvas(webglCanvas);
    configureCanvas(differenceCanvas);
    const differenceContext = differenceCanvas.getContext('2d', { alpha: false });
    if (!differenceContext) throw new Error('Difference canvas 2D context is unavailable.');
    const texture = createHighFrequencyTexture();
    const [webgpu, webgl2] = await Promise.all([
      WebGpuShowcaseRenderer.create(webgpuCanvas, texture),
      Promise.resolve(WebGl2ShowcaseRenderer.create(webglCanvas, texture)),
    ]);
    return new DualBackendRenderer(webgpu, webgl2, differenceContext);
  }

  async render(state: ShowcaseUniformState): Promise<DualBackendFrame> {
    const [webgpuPixels, webglPixels] = await Promise.all([
      this.webgpu.render(state),
      Promise.resolve(this.webgl2.render(state)),
    ]);
    this.uniformWriteCount += 2;
    const difference = comparePixels(webgpuPixels, webglPixels);
    paintDifference(this.differenceContext, webgpuPixels, webglPixels);
    return Object.freeze({ difference, uniformWriteCount: this.uniformWriteCount, pipelineRebuildCount: 0 });
  }

  dispose(): void {
    this.webgpu.dispose();
    this.webgl2.dispose();
  }
}

class WebGpuShowcaseRenderer {
  readonly compilationErrorCount: number;
  get validationErrorCount(): number { return this.validationErrors.length; }

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly vertexBuffer: GPUBuffer,
    private readonly uniformBuffer: GPUBuffer,
    private readonly texture: GPUTexture,
    private readonly target: GPUTexture,
    private readonly readback: GPUBuffer,
    private readonly displayContext: CanvasRenderingContext2D,
    private readonly validationErrors: string[],
    compilationErrorCount: number,
  ) {
    this.compilationErrorCount = compilationErrorCount;
  }

  static async create(canvas: HTMLCanvasElement, texturePixels: Uint8Array): Promise<WebGpuShowcaseRenderer> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable; Shader Language Lab does not silently fall back.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU did not return an adapter.');
    const device = await adapter.requestDevice();
    const validationErrors: string[] = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    device.pushErrorScope('validation');

    const module = device.createShaderModule({
      label: 'shader-language-lab.generated-wgsl',
      code: SHADER_LANGUAGE_SHOWCASE.wgsl.code,
    });
    const compilationInfo = await module.getCompilationInfo();
    const compilationErrors = compilationInfo.messages.filter(message => message.type === 'error');
    if (compilationErrors.length > 0) {
      throw new Error(`Generated WGSL failed:\n${compilationErrors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`);
    }
    const pipeline = await device.createRenderPipelineAsync({
      label: 'shader-language-lab.webgpu-pipeline',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const vertices = fullscreenTriangle();
    const vertexBuffer = device.createBuffer({
      label: 'shader-language-lab.vertices',
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer as ArrayBuffer);
    const uniformLayout = requiredWgslUniformLayout();
    const uniformBuffer = device.createBuffer({
      label: 'shader-language-lab.uniforms',
      size: uniformLayout.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const texture = device.createTexture({
      label: 'shader-language-lab.source-texture',
      size: [TEXTURE_SIZE, TEXTURE_SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      texturePixels.buffer as ArrayBuffer,
      { bytesPerRow: TEXTURE_SIZE * 4, rowsPerImage: TEXTURE_SIZE },
      [TEXTURE_SIZE, TEXTURE_SIZE],
    );
    const sampler = device.createSampler({
      label: 'shader-language-lab.sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    const resources = new Map(SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.resources.map(resource => [resource.id, resource]));
    const params = requiredResource(resources, 'material.params');
    const sourceTexture = requiredResource(resources, 'material.sourceTexture');
    const sourceSampler = requiredResource(resources, 'material.sourceSampler');
    const bindGroup = device.createBindGroup({
      label: 'shader-language-lab.material-bind-group',
      layout: pipeline.getBindGroupLayout(params.group),
      entries: [
        { binding: params.binding, resource: { buffer: uniformBuffer } },
        { binding: sourceTexture.binding, resource: texture.createView() },
        { binding: sourceSampler.binding, resource: sampler },
      ],
    });
    const target = device.createTexture({
      label: 'shader-language-lab.rgba-target',
      size: [WIDTH, HEIGHT],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      label: 'shader-language-lab.readback',
      size: WIDTH * HEIGHT * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const displayContext = canvas.getContext('2d', { alpha: false });
    if (!displayContext) throw new Error('WebGPU display canvas 2D context is unavailable.');
    const validationError = await device.popErrorScope();
    if (validationError) validationErrors.push(validationError.message);
    if (validationErrors.length > 0) throw new Error(`WebGPU validation failed: ${validationErrors.join('; ')}`);
    return new WebGpuShowcaseRenderer(
      device, pipeline, bindGroup, vertexBuffer, uniformBuffer, texture, target, readback,
      displayContext, validationErrors, compilationErrors.length,
    );
  }

  async render(state: ShowcaseUniformState): Promise<Uint8Array> {
    const values = uniformValues(state);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, packReflectedUniforms(requiredWgslUniformLayout(), values));
    const encoder = this.device.createCommandEncoder({ label: 'shader-language-lab.frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.005, g: 0.008, b: 0.018, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(2, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.target },
      { buffer: this.readback, bytesPerRow: WIDTH * 4, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT],
    );
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(this.readback.getMappedRange()).slice();
    this.readback.unmap();
    paintRgbaPixels(this.displayContext, pixels, WIDTH, HEIGHT, true);
    return pixels;
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.uniformBuffer.destroy();
    this.texture.destroy();
    this.target.destroy();
    this.readback.destroy();
    this.device.destroy();
  }
}

class WebGl2ShowcaseRenderer {
  readonly compileErrorCount = 0;
  readonly linkErrorCount = 0;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly vertexShader: WebGLShader,
    private readonly fragmentShader: WebGLShader,
    private readonly vao: WebGLVertexArrayObject,
    private readonly vertexBuffer: WebGLBuffer,
    private readonly uniformBuffer: WebGLBuffer,
    private readonly texture: WebGLTexture,
  ) {}

  static create(canvas: HTMLCanvasElement, texturePixels: Uint8Array): WebGl2ShowcaseRenderer {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is unavailable; the GLSL feasibility pane cannot run.');
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const vertexEntry = SHADER_LANGUAGE_SHOWCASE.glsl.entries.find(entry => entry.stage === 'vertex');
    const fragmentEntry = SHADER_LANGUAGE_SHOWCASE.glsl.entries.find(entry => entry.stage === 'fragment');
    if (!vertexEntry || !fragmentEntry) throw new Error('Generated GLSL is missing vertex or fragment entry source.');
    const vertexShader = compileGlShader(gl, gl.VERTEX_SHADER, vertexEntry.code, 'vertex');
    const fragmentShader = compileGlShader(gl, gl.FRAGMENT_SHADER, fragmentEntry.code, 'fragment');
    const program = requiredGlObject(gl.createProgram(), 'WebGL2 program');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Generated GLSL link failed: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`);
    }
    gl.useProgram(program);
    const vao = requiredGlObject(gl.createVertexArray(), 'WebGL2 vertex array');
    gl.bindVertexArray(vao);
    const vertexBuffer = requiredGlObject(gl.createBuffer(), 'WebGL2 vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, fullscreenTriangle(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);

    const uniform = requiredGlslUniformBlock();
    const uniformBuffer = requiredGlObject(gl.createBuffer(), 'WebGL2 uniform buffer');
    gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, uniform.layout.byteSize, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, uniform.binding, uniformBuffer);
    const blockIndex = gl.getUniformBlockIndex(program, uniform.blockName);
    if (blockIndex === gl.INVALID_INDEX) throw new Error(`Generated GLSL uniform block ${uniform.blockName} is inactive.`);
    gl.uniformBlockBinding(program, blockIndex, uniform.binding);

    const sampled = SHADER_LANGUAGE_SHOWCASE.glsl.sampledTextures[0];
    if (!sampled) throw new Error('Generated GLSL combined sampler reflection is missing.');
    const texture = requiredGlObject(gl.createTexture(), 'WebGL2 source texture');
    gl.activeTexture(gl.TEXTURE0 + sampled.textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEXTURE_SIZE, TEXTURE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, texturePixels);
    const samplerLocation = gl.getUniformLocation(program, sampled.uniformName);
    if (!samplerLocation) throw new Error(`Generated GLSL sampler ${sampled.uniformName} is inactive.`);
    gl.uniform1i(samplerLocation, sampled.textureUnit);
    return new WebGl2ShowcaseRenderer(gl, program, vertexShader, fragmentShader, vao, vertexBuffer, uniformBuffer, texture);
  }

  render(state: ShowcaseUniformState): Uint8Array {
    const gl = this.gl;
    const uniform = requiredGlslUniformBlock();
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, packReflectedUniforms(uniform.layout, uniformValues(state)));
    gl.viewport(0, 0, WIDTH, HEIGHT);
    gl.clearColor(0.005, 0.008, 0.018, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL2 render failed with 0x${error.toString(16)}.`);
    return pixels;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.uniformBuffer);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vertexShader);
    gl.deleteShader(this.fragmentShader);
  }
}

function requiredWgslUniformLayout(): UniformLayout {
  const layout = SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.uniformBlocks.find(block => block.id === 'material.params');
  if (!layout) throw new Error('Generated WGSL material.params layout is missing.');
  return layout;
}

function requiredGlslUniformBlock(): typeof SHADER_LANGUAGE_SHOWCASE.glsl.uniformBlocks[number] {
  const block = SHADER_LANGUAGE_SHOWCASE.glsl.uniformBlocks.find(candidate => candidate.resourceId === 'material.params');
  if (!block) throw new Error('Generated GLSL material.params block is missing.');
  return block;
}

function requiredResource<T extends { readonly id: string }>(resources: ReadonlyMap<string, T>, id: string): T {
  const resource = resources.get(id);
  if (!resource) throw new Error(`Generated WebGPU resource ${id} is missing.`);
  return resource;
}

function uniformValues(state: ShowcaseUniformState): Readonly<Record<string, number | readonly number[]>> {
  return {
    invResolution: [1 / WIDTH, 1 / HEIGHT],
    time: state.time,
    noiseScale: state.noiseScale,
    noiseStrength: state.noiseStrength,
    gradientBias: state.gradientBias,
    scanStrength: state.scanStrength,
    vignetteStrength: state.vignetteStrength,
    tintA: state.tintA,
    tintB: state.tintB,
  };
}

function createHighFrequencyTexture(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) for (let x = 0; x < TEXTURE_SIZE; x++) {
    const offset = (y * TEXTURE_SIZE + x) * 4;
    const checker = ((x >> 2) + (y >> 2)) % 2;
    const stripe = (x + y * 3) % 13 < 3;
    pixels[offset] = checker ? 238 : stripe ? 255 : 26;
    pixels[offset + 1] = checker ? 54 : stripe ? 196 : 224;
    pixels[offset + 2] = checker ? 208 : stripe ? 52 : 248;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function comparePixels(left: Uint8Array, right: Uint8Array): PixelDifference {
  if (left.length !== right.length) throw new Error('Backend pixel buffers have different lengths.');
  let maxChannelDelta = 0;
  let totalDelta = 0;
  let changedPixelCount = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(left[offset + channel]! - right[offset + channel]!);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      totalDelta += delta;
      changed ||= delta > 0;
    }
    if (changed) changedPixelCount++;
  }
  const pixelCount = left.length / 4;
  return Object.freeze({
    maxChannelDelta,
    meanAbsoluteDelta: totalDelta / left.length,
    changedPixelRatio: changedPixelCount / pixelCount,
    changedPixelCount,
  });
}

function paintDifference(context: CanvasRenderingContext2D, left: Uint8Array, right: Uint8Array): void {
  const pixels = new Uint8ClampedArray(left.length);
  for (let offset = 0; offset < left.length; offset += 4) {
    const red = Math.abs(left[offset]! - right[offset]!);
    const green = Math.abs(left[offset + 1]! - right[offset + 1]!);
    const blue = Math.abs(left[offset + 2]! - right[offset + 2]!);
    const delta = Math.max(red, green, blue);
    pixels[offset] = Math.min(255, delta * 32);
    pixels[offset + 1] = Math.min(255, delta * 8);
    pixels[offset + 2] = delta === 0 ? 12 : Math.min(255, 48 + delta * 12);
    pixels[offset + 3] = 255;
  }
  paintRgbaPixels(context, pixels, WIDTH, HEIGHT, true);
}

function compileGlShader(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = requiredGlObject(gl.createShader(type), `${label} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Generated ${label} GLSL failed: ${gl.getShaderInfoLog(shader) ?? 'unknown error'}\n${source}`);
  }
  return shader;
}

function requiredGlObject<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`${label} allocation failed.`);
  return value;
}

function fullscreenTriangle(): Float32Array {
  return new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]);
}

function configureCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
}
