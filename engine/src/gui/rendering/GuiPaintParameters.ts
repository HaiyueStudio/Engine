import type {GuiRect} from '../GuiTypes';
import type {RenderCommandContext} from '../../core/RenderCommandContext';
import type {GuiGpuResources} from './GuiGpuResources';
import {GuiVertexChanges} from './GuiVertexChanges';

export interface GuiRoundedClip {readonly rect: GuiRect; readonly radii: readonly [number,number,number,number]; readonly parent?: GuiRoundedClip;}
export interface GuiClipRect extends GuiRect {readonly rounded?: GuiRoundedClip;}
const STRIDE = 24;
/** Index zero is the empty sentinel. Clip chains and shape records share one bounded ABI. */
export class GuiPaintParameters {
  data = new Float32Array(STRIDE);
  version = 0;
  private values: number[] = [];
  private clips = new Map<GuiRoundedClip, number>();
  private clipHeads = new Map<GuiClipRect, number>();
  begin(): void {this.values = Array<number>(STRIDE).fill(0); this.clips.clear(); this.clipHeads.clear();}
  record(values: readonly number[]): number {
    if (values.length !== STRIDE || this.values.length / STRIDE >= 100_000 || values.some(n => !Number.isFinite(n))) throw new RangeError('Invalid or excessive GUI paint parameters.');
    const index = this.values.length / STRIDE; this.values.push(...values); return index;
  }
  clip(clip: GuiClipRect | undefined, depth = 0): number {
    const mask = clip?.rounded; if (!mask) return 0;
    const head = this.clipHeads.get(clip); if (head) return head;
    const parent = this.mask(mask,depth), values = Array<number>(STRIDE).fill(0);
    values.splice(0,9,clip.x,clip.y,clip.width,clip.height,0,0,0,0,parent);
    const index = this.record(values);this.clipHeads.set(clip,index);return index;
  }
  private mask(mask: GuiRoundedClip, depth: number): number {
    if (depth >= 128) throw new RangeError('GUI rounded clipping exceeds tree bounds.');
    const cached = this.clips.get(mask); if (cached) return cached;
    const parent = mask.parent ? this.mask(mask.parent, depth + 1) : 0;
    const r = mask.rect, values = Array<number>(STRIDE).fill(0);
    values.splice(0, 9, r.x,r.y,r.width,r.height,...mask.radii,parent);
    const index = this.record(values); this.clips.set(mask,index); return index;
  }
  finish(): void {
    const next = Float32Array.from(this.values);
    const base=this.version,changes=new GuiVertexChanges();let changed=next.length!==this.data.length,start=-1;
    for(let i=0;i<next.length;i++){if(next[i]!==this.data[i]){changed=true;if(start<0)start=i;}else if(start>=0){changes.add(start*4,(i-start)*4);start=-1;}}
    if(start>=0)changes.add(start*4,(next.length-start)*4);
    if(changed){this.data=next;this.version++;}changes.commit(this,base,this.version,{commands:next.length/STRIDE,layouts:0,vertices:0});
    this.values = []; this.clips.clear(); this.clipHeads.clear();
  }
}

export type GuiParameterGroups = WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>;
export function guiParameterGroup(resources: GuiGpuResources, device: GPUDevice, layout: GPUBindGroupLayout, viewport: GPUBuffer,
    parameters: GuiPaintParameters, context: RenderCommandContext | undefined, groups: GuiParameterGroups): GPUBindGroup {
  // Ordinary fragments never dereference a paint record; their unused storage binding borrows the viewport.
  const empty=parameters.data.length===STRIDE;
  const buffer = empty?viewport:resources.upload(parameters,parameters.version,parameters.data,parameters.data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,'gui:paint-parameters',context);
  let byParameters = groups.get(viewport); if (!byParameters) {byParameters = new WeakMap(); groups.set(viewport,byParameters);}
  let group = byParameters.get(buffer); if (!group) {group = device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:viewport,offset:0,size:16}},{binding:1,resource:{buffer,offset:0,size:empty?STRIDE*4:parameters.data.byteLength}}]}); byParameters.set(buffer,group);}
  return group;
}
