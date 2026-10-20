import { DeferredAmbientOcclusion } from './DeferredAmbientOcclusion';
import { getPrecompiledShaderPassRuntime, type PrecompiledShaderPassRuntime } from '../shader/PrecompiledShaderRuntime';
import { DEFERRED_FULL_FORWARD_SHADER_ARTIFACT } from '../shaders/generated/deferred-full-forward-artifact.generated';
import type { PbrDeferredSurfacePort, PbrFullLightingState } from './PbrDeferredSurfacePort';

interface FullLightBindings { readonly source: GPUBufferBinding; readonly header: GPUBufferBinding; readonly indices: GPUBufferBinding }

/** Only reached through the lazy Deferred provider; default PBR never imports this shader family. */
export class DeferredFullForward {
  private readonly _ao: DeferredAmbientOcclusion;
  readonly runtimes: readonly PrecompiledShaderPassRuntime[];
  private readonly _shaders: readonly ReturnType<PbrFullLightingState['shader']>[];
  private readonly _ids = new WeakMap<object, number>();
  private _nextId = 1;
  private readonly _groups = new Map<string, GPUBindGroup>();
  private readonly _states = new Map<string, PbrFullLightingState>();

  constructor(private readonly _device: GPUDevice, port: PbrDeferredSurfacePort) {
    this._ao = new DeferredAmbientOcclusion(_device);
    this.runtimes = ['pbr', 'pbr-clearcoat', 'pbr-transmission', 'pbr-transmission-clearcoat'].map(id =>
      getPrecompiledShaderPassRuntime(_device, DEFERRED_FULL_FORWARD_SHADER_ARTIFACT, `deferred-full-${id}`, {
        rendererOwnedLayouts: Object.fromEntries(port.layouts.slice(0, 3).map((layout, i) => [i, layout])),
      }));
    this._shaders = this.runtimes.map(runtime => ({ module: runtime.module, key: runtime.pass.canonicalHash, pipelineLayout: runtime.pipelineLayout }));
  }

  bind(bindings: FullLightBindings, opaqueSurfaceMask?: GPUTextureView, ao: GPUBufferBinding = this._ao.neutral): PbrFullLightingState {
    const key = [bindings.source, bindings.header, bindings.indices]
      .map(b => `${this._id(b.buffer)}:${b.offset ?? 0}:${b.size ?? 0}`).join('|') + `|surface:${opaqueSurfaceMask ? this._id(opaqueSurfaceMask) : 0}|ao:${this._id(ao.buffer)}:${ao.offset ?? 0}:${ao.size ?? 0}`;
    let state = this._states.get(key);
    if (!state) {
      state = {
        shader: (clearcoat, transmission) => this._shaders[(clearcoat ? 1 : 0) + (transmission ? 2 : 0)]!,
        bindGroup: (base, entries) => {
          const groupKey = `${key}|${this._id(base)}`;
          let group = this._groups.get(groupKey);
          if (!group) {
            group = this._device.createBindGroup({ label: 'DeferredFullForward.scene', layout: this.runtimes[0]!.bindGroupLayouts[3]!,
              entries: [...entries.map(entry => entry.binding === 11 && opaqueSurfaceMask ? { ...entry, resource: opaqueSurfaceMask } : entry), { binding: 12, resource: bindings.source }, { binding: 13, resource: bindings.header }, { binding: 14, resource: bindings.indices }, { binding: 15, resource: ao }] });
            if (this._groups.size >= 128) this._groups.delete(this._groups.keys().next().value!);
            this._groups.set(groupKey, group);
          }
          return group;
        },
      };
      if (this._states.size >= 64) this._states.delete(this._states.keys().next().value!);
      this._states.set(key, state);
    }
    return state;
  }

  destroy(): void { this._ao.destroy(); this._groups.clear(); this._states.clear(); }
  private _id(value: object): number {
    let id = this._ids.get(value);
    if (id === undefined) { id = this._nextId++; this._ids.set(value, id); }
    return id;
  }
}
