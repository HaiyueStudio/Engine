import { PostProcessPass, FULLSCREEN_VERT_WGSL, getPostProcessTextureView } from './PostProcessPass';
import customPassBindingsWgsl from '../shaders/postprocess/custom-pass-bindings.wgsl';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredItemAt } from '../math/arrayAccess';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';

/**
 * Post-processing pass driven by a user-supplied WGSL fragment shader.
 *
 * The following bindings are pre-wired and available in your shader:
 *   @group(0) @binding(0) var srcTex     : texture_2d<f32>;
 *   @group(0) @binding(1) var srcSampler : sampler;
 *
 * The vertex shader (fullscreen triangle) and VertexOutput struct are
 * prepended automatically, so your code only needs to define `fs_main`:
 *
 * ```wgsl
 * @fragment
 * fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
 *   // in.uv  : vec2<f32>  (0..1, V=0 at top)
 *   // in.pos : vec4<f32>  (clip-space position)
 *   return textureSample(srcTex, srcSampler, in.uv);
 * }
 * ```
 *
 * For additional uniforms/textures/samplers, add @group(1)+ bindings to
 * `extraBindings` and populate them via `extraEntries`.
 */

export interface CustomPassExtraEntriesContext {
  device: GPUDevice;
  src: GPUTexture;
  dstView: GPUTextureView;
}

export type CustomPassExtraBindGroupEntries =
  | readonly GPUBindGroupEntry[]
  | ((context: CustomPassExtraEntriesContext) => readonly GPUBindGroupEntry[]);

export type CustomPassExtraBindings =
  | readonly GPUBindGroupLayoutEntry[]
  | readonly (readonly GPUBindGroupLayoutEntry[])[];

export interface CustomPassOptions {
  /** Label shown in GPU debugging tools. */
  label?: string;
  /**
   * WGSL fragment-shader code.  Must define `fs_main(in: VertexOutput)`.
   * The VertexOutput struct, fullscreen vertex shader, and group(0) bindings
   * (srcTex, srcSampler) are injected automatically.
   */
  fragmentCode: string;
  /**
   * Extra bind group layouts appended after the built-in group(0).
   *
   * A flat array is treated as group(1).  A nested array maps to group(1),
   * group(2), ... in order.
   */
  extraBindings?: CustomPassExtraBindings;
  /**
   * Entries for each extra bind group. A flat entry array is treated as
   * group(1); a nested array/callback array maps to group(1), group(2), ...
   * Static entries are cached after `prepare()`. Callback entries are rebuilt
   * every `apply()` so callers can swap resources per frame.
   */
  extraEntries?: CustomPassExtraBindGroupEntries | readonly CustomPassExtraBindGroupEntries[];
}

const BINDING_HEADER = customPassBindingsWgsl;

export class CustomPass extends PostProcessPass {
  readonly label: string;
  private _fragmentCode: string;

  private _pipeline: GPURenderPipeline | null = null;
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _format!: GPUTextureFormat;
  private _bgl!: GPUBindGroupLayout;
  private _extraBgls: GPUBindGroupLayout[] = [];
  private _sampler!: GPUSampler;
  private _lastSrc: GPUTexture | null = null;
  private _bg: GPUBindGroup | null = null;
  private readonly _extraBindings: readonly (readonly GPUBindGroupLayoutEntry[])[];
  private readonly _extraEntries: readonly CustomPassExtraBindGroupEntries[];
  private _staticExtraBindGroups: Array<GPUBindGroup | null> = [];

  constructor(options: CustomPassOptions) {
    super();
    this.label        = options.label        ?? 'CustomPass';
    this._fragmentCode = options.fragmentCode;
    this._extraBindings = normalizeExtraBindings(options.extraBindings);
    this._extraEntries = normalizeExtraEntries(options.extraEntries, this._extraBindings.length, this.label);
  }

  prepare(device: GPUDevice, format: GPUTextureFormat): void {
    const fullCode = FULLSCREEN_VERT_WGSL + BINDING_HEADER + this._fragmentCode;
    this._module = device.createShaderModule({ code: fullCode, label: this.label });

    this._bgl = device.createBindGroupLayout({
      label:   `${this.label}.bgl`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this._extraBgls = this._extraBindings.map((entries, index) => device.createBindGroupLayout({
      label: `${this.label}.extraBgl${index + 1}`,
      entries: [...entries],
    }));
    this._staticExtraBindGroups = this._extraEntries.map((entries, index) => {
      if (typeof entries === 'function') return null;
      return device.createBindGroup({
        label: `${this.label}.extraBg${index + 1}`,
        layout: requiredItemAt(this._extraBgls, index, `${this.label} extra bind group layouts`),
        entries: [...entries],
      });
    });

    this._pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this._bgl, ...this._extraBgls] });
    this._format = format;

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', this.label, device, () => this._pipelineDescriptor(),
      () => this._pipeline !== null, pipeline => { this._pipeline = pipeline; });
  }

  apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void {
    if (src !== this._lastSrc) {
      this._bg = device.createBindGroup({
        layout:  this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._sampler },
        ],
      });
      this._lastSrc = src;
    }

    const pass = encoder.beginRenderPass({
      label: `${this.label}.renderPass`,
      colorAttachments: [{
        view:       dstView,
        loadOp:     'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp:    'store',
      }],
    });
    pass.setPipeline(this._pipeline ??= device.createRenderPipeline(this._pipelineDescriptor()));
    pass.setBindGroup(0, this._bg!);
    for (let i = 0; i < this._extraEntries.length; i++) {
      pass.setBindGroup(i + 1, this._getExtraBindGroup(i, {
        device,
        src,
        dstView,
      }));
    }
    pass.draw(3);
    pass.end();
  }

  override destroy(): void {
    this._pipeline = null;
    this._lastSrc = null;
    this._bg = null;
    this._staticExtraBindGroups = [];
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: `${this.label}.pipeline`,
      layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: { module: this._module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _getExtraBindGroup(index: number, context: CustomPassExtraEntriesContext): GPUBindGroup {
    const staticBindGroup = this._staticExtraBindGroups[index];
    if (staticBindGroup) return staticBindGroup;
    const entries = this._extraEntries[index];
    if (typeof entries !== 'function') {
      throw new EngineError(
        EngineErrorCode.RenderCommandContextInvalid,
        `${this.label} extra bind group ${index + 1} was not prepared.`,
        {
          hint: 'Call prepare() before apply(), or provide matching extraBindings/extraEntries.',
          docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
        },
      );
    }
    return context.device.createBindGroup({
      label: `${this.label}.extraBg${index + 1}`,
      layout: requiredItemAt(this._extraBgls, index, `${this.label} extra bind group layouts`),
      entries: [...entries(context)],
    });
  }
}

function normalizeExtraBindings(value: CustomPassExtraBindings | undefined): readonly (readonly GPUBindGroupLayoutEntry[])[] {
  if (!value || value.length === 0) return [];
  const first = value[0] as unknown;
  if (isLayoutEntry(first)) return [value as readonly GPUBindGroupLayoutEntry[]];
  return value as readonly (readonly GPUBindGroupLayoutEntry[])[];
}

function normalizeExtraEntries(
  value: CustomPassOptions['extraEntries'],
  groupCount: number,
  label: string,
): readonly CustomPassExtraBindGroupEntries[] {
  if (groupCount === 0) return [];
  if (!value) {
    throw new EngineError(
      EngineErrorCode.RenderCommandContextInvalid,
      `${label} defines extraBindings but no extraEntries.`,
      {
        hint: 'Provide one extraEntries group for each extraBindings group.',
        docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
      },
    );
  }
  const normalized = normalizeExtraEntriesShape(value, groupCount);
  if (normalized.length !== groupCount) {
    throw new EngineError(
      EngineErrorCode.RenderCommandContextInvalid,
      `${label} extraBindings/extraEntries group count mismatch.`,
      {
        hint: `Expected ${groupCount} extraEntries group(s), received ${normalized.length}.`,
        docsPath: 'errors/E_RENDER_COMMAND_CONTEXT_INVALID',
      },
    );
  }
  return normalized;
}

function normalizeExtraEntriesShape(
  value: CustomPassOptions['extraEntries'],
  groupCount: number,
): readonly CustomPassExtraBindGroupEntries[] {
  if (typeof value === 'function') return [value];
  const entries = value as readonly unknown[];
  if (groupCount === 1 && (entries.length === 0 || isBindGroupEntry(entries[0]))) {
    return [entries as readonly GPUBindGroupEntry[]];
  }
  return entries as readonly CustomPassExtraBindGroupEntries[];
}

function isLayoutEntry(value: unknown): value is GPUBindGroupLayoutEntry {
  return !!value && typeof value === 'object' && 'binding' in value && (
    'buffer' in value ||
    'sampler' in value ||
    'texture' in value ||
    'storageTexture' in value ||
    'externalTexture' in value
  );
}

function isBindGroupEntry(value: unknown): value is GPUBindGroupEntry {
  return !!value && typeof value === 'object' && 'binding' in value && 'resource' in value;
}
