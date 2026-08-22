import type { ParsedDeformableMesh2DData } from '@haiyue/animation-spec/deformable2d';
import { sampleDeformableMesh2DDrawable } from './DeformableMesh2DSampler.js';

export type DeformableMesh2DBlendPolicy = 'override' | 'additive';

export interface DeformableMesh2DClipRange {
  readonly id: string;
  readonly start: number;
  readonly duration: number;
  readonly loop?: boolean;
}

export interface DeformableMesh2DActionPose {
  readonly id: string;
  readonly clip: DeformableMesh2DClipRange;
  readonly time: number;
  readonly weight: number;
  readonly layer?: number;
  readonly order?: number;
  readonly blend?: DeformableMesh2DBlendPolicy;
  readonly channels?: ReadonlySet<'vertices' | 'opacity' | 'color' | 'visibility' | 'order'>;
}

export class DeformableMesh2DPoseError extends Error {
  readonly code: 'E_DEFORMABLE_POSE_TOPOLOGY' | 'E_DEFORMABLE_POSE_ADDITIVE_DISCRETE' | 'E_DEFORMABLE_POSE_DESTROYED';

  constructor(code: DeformableMesh2DPoseError['code'], message: string) {
    super(message);
    this.name = 'DeformableMesh2DPoseError';
    this.code = code;
  }
}

/** Compact reusable pose storage. Colors are neutral in HYDM v1 but are kept in the port for a future ABI revision. */
export class DeformableMesh2DPoseBuffer {
  readonly topology: string;
  readonly positions: readonly Float32Array[];
  readonly opacities: Float32Array;
  readonly multiplyColors: Float32Array;
  readonly screenColors: Float32Array;
  readonly visibilities: Uint8Array;
  readonly renderOrders: Int32Array;
  revision = 0;

  constructor(data: ParsedDeformableMesh2DData) {
    this.topology = topologyIdentity(data);
    this.positions = Object.freeze(data.drawables.map(drawable => new Float32Array(drawable.vertexCount * 2)));
    this.opacities = new Float32Array(data.drawables.length);
    this.multiplyColors = new Float32Array(data.drawables.length * 4).fill(1);
    this.screenColors = new Float32Array(data.drawables.length * 4);
    this.visibilities = new Uint8Array(data.drawables.length);
    this.renderOrders = new Int32Array(data.drawables.length);
  }
}

interface SampledAction {
  readonly action: DeformableMesh2DActionPose;
  readonly pose: DeformableMesh2DPoseBuffer;
  readonly weight: number;
  readonly layer: number;
  readonly order: number;
}

/**
 * Samples any number of disjoint baked clip ranges into one retained model pose.
 * Scratch buffers are action-owned and reused; evaluation never creates a second model or renderer hierarchy.
 */
export class DeformableMesh2DClipMixer {
  readonly output: DeformableMesh2DPoseBuffer;
  private readonly reference: DeformableMesh2DPoseBuffer;
  private readonly scratch = new Map<string, DeformableMesh2DPoseBuffer>();
  private destroyed = false;

  constructor(private readonly data: ParsedDeformableMesh2DData) {
    this.reference = new DeformableMesh2DPoseBuffer(data);
    this.output = new DeformableMesh2DPoseBuffer(data);
    sampleDeformableMesh2DPose(data, data.times[0]!, this.reference);
    copyPose(this.reference, this.output);
  }

  evaluate(actions: readonly DeformableMesh2DActionPose[]): DeformableMesh2DPoseBuffer {
    this.assertAlive();
    const sampled: SampledAction[] = [];
    const ids = new Set<string>();
    for (const action of actions) {
      if (!action.id || ids.has(action.id)) throw new RangeError('Deformable action ids must be non-empty and unique.');
      ids.add(action.id);
      if (!Number.isFinite(action.weight) || action.weight < 0) throw new RangeError(`Action "${action.id}" weight must be finite and non-negative.`);
      if (action.weight === 0) continue;
      validateClip(action.clip, this.data.duration);
      let pose = this.scratch.get(action.id);
      if (!pose) { pose = new DeformableMesh2DPoseBuffer(this.data); this.scratch.set(action.id, pose); }
      sampleDeformableMesh2DPose(this.data, clipTime(action.clip, action.time), pose);
      sampled.push({ action, pose, weight: action.weight, layer: action.layer ?? 0, order: action.order ?? 0 });
    }
    mixPoses(this.reference, sampled, this.output);
    return this.output;
  }

  rebind(data: ParsedDeformableMesh2DData): void {
    this.assertAlive();
    if (topologyIdentity(data) !== this.output.topology) {
      throw new DeformableMesh2DPoseError('E_DEFORMABLE_POSE_TOPOLOGY', 'Cannot rebind a pose mixer to incompatible drawable topology.');
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scratch.clear();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new DeformableMesh2DPoseError('E_DEFORMABLE_POSE_DESTROYED', 'Deformable pose mixer is destroyed.');
  }
}

export function sampleDeformableMesh2DPose(
  data: ParsedDeformableMesh2DData,
  time: number,
  output: DeformableMesh2DPoseBuffer,
): DeformableMesh2DPoseBuffer {
  if (output.topology !== topologyIdentity(data)) {
    throw new DeformableMesh2DPoseError('E_DEFORMABLE_POSE_TOPOLOGY', 'Pose buffer topology does not match the sampled model.');
  }
  for (let index = 0; index < data.drawables.length; index++) {
    const sampled = sampleDeformableMesh2DDrawable(data.times, data.drawables[index]!, time, output.positions[index]!);
    output.opacities[index] = sampled.opacity;
    output.visibilities[index] = sampled.opacity > 0 ? 1 : 0;
    output.renderOrders[index] = sampled.renderOrder;
  }
  output.revision++;
  return output;
}

function mixPoses(reference: DeformableMesh2DPoseBuffer, sampled: readonly SampledAction[], output: DeformableMesh2DPoseBuffer): void {
  copyPose(reference, output);
  const layers = [...new Set(sampled.map(item => item.layer))].sort((left, right) => left - right);
  for (const layer of layers) {
    const entries = sampled.filter(item => item.layer === layer).sort(compareAction);
    const overrides = entries.filter(item => (item.action.blend ?? 'override') === 'override');
    const additives = entries.filter(item => item.action.blend === 'additive');
    if (overrides.length > 0) applyOverrides(overrides, output);
    for (const entry of additives) applyAdditive(reference, entry, output);
  }
  output.revision++;
}

function applyOverrides(entries: readonly SampledAction[], output: DeformableMesh2DPoseBuffer): void {
  for (let drawable = 0; drawable < output.positions.length; drawable++) {
    const vertexEntries = entries.filter(entry => hasChannel(entry.action, 'vertices'));
    if (vertexEntries.length > 0) mixContinuous(output.positions[drawable]!, vertexEntries, drawable, 'positions');
    const opacityEntries = entries.filter(entry => hasChannel(entry.action, 'opacity'));
    if (opacityEntries.length > 0) {
      const { denominator, baseWeight } = channelWeights(opacityEntries);
      let value = output.opacities[drawable]! * baseWeight;
      for (const entry of opacityEntries) value += entry.pose.opacities[drawable]! * entry.weight / denominator;
      output.opacities[drawable] = value;
    }
    const colorEntries = entries.filter(entry => hasChannel(entry.action, 'color'));
    if (colorEntries.length > 0) {
      mixColor(output.multiplyColors, colorEntries, drawable);
      mixColor(output.screenColors, colorEntries, drawable, true);
    }
    const visibility = dominant(entries.filter(entry => hasChannel(entry.action, 'visibility')));
    const order = dominant(entries.filter(entry => hasChannel(entry.action, 'order')));
    if (visibility) output.visibilities[drawable] = visibility.pose.visibilities[drawable]!;
    if (order) output.renderOrders[drawable] = order.pose.renderOrders[drawable]!;
  }
}

function applyAdditive(reference: DeformableMesh2DPoseBuffer, entry: SampledAction, output: DeformableMesh2DPoseBuffer): void {
  if (hasChannel(entry.action, 'visibility') || hasChannel(entry.action, 'order')) {
    throw new DeformableMesh2DPoseError('E_DEFORMABLE_POSE_ADDITIVE_DISCRETE', `Additive action "${entry.action.id}" cannot target visibility or draw order.`);
  }
  for (let drawable = 0; drawable < output.positions.length; drawable++) {
    if (hasChannel(entry.action, 'vertices')) {
      const target = output.positions[drawable]!;
      const source = entry.pose.positions[drawable]!;
      const base = reference.positions[drawable]!;
      for (let index = 0; index < target.length; index++) target[index] = target[index]! + (source[index]! - base[index]!) * entry.weight;
    }
    if (hasChannel(entry.action, 'color')) {
      const offset = drawable * 4;
      for (let index = 0; index < 4; index++) {
        output.multiplyColors[offset + index] = output.multiplyColors[offset + index]! + (entry.pose.multiplyColors[offset + index]! - reference.multiplyColors[offset + index]!) * entry.weight;
        output.screenColors[offset + index] = output.screenColors[offset + index]! + (entry.pose.screenColors[offset + index]! - reference.screenColors[offset + index]!) * entry.weight;
      }
    }
  }
}

function mixContinuous(target: Float32Array, entries: readonly SampledAction[], drawable: number, field: 'positions'): void {
  const { denominator, baseWeight } = channelWeights(entries);
  for (let index = 0; index < target.length; index++) {
    let value = target[index]! * baseWeight;
    for (const entry of entries) value += entry.pose[field][drawable]![index]! * entry.weight / denominator;
    target[index] = value;
  }
}

function mixColor(target: Float32Array, entries: readonly SampledAction[], drawable: number, screen = false): void {
  const { denominator, baseWeight } = channelWeights(entries);
  const offset = drawable * 4;
  for (let index = 0; index < 4; index++) {
    let value = target[offset + index]! * baseWeight;
    for (const entry of entries) value += (screen ? entry.pose.screenColors : entry.pose.multiplyColors)[offset + index]! * entry.weight / denominator;
    target[offset + index] = value;
  }
}

function channelWeights(entries: readonly SampledAction[]): { readonly denominator: number; readonly baseWeight: number } {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return { denominator: Math.max(1, total), baseWeight: Math.max(0, 1 - total) };
}

function copyPose(source: DeformableMesh2DPoseBuffer, target: DeformableMesh2DPoseBuffer): void {
  if (source.topology !== target.topology) throw new DeformableMesh2DPoseError('E_DEFORMABLE_POSE_TOPOLOGY', 'Cannot copy between incompatible deformable poses.');
  for (let index = 0; index < source.positions.length; index++) target.positions[index]!.set(source.positions[index]!);
  target.opacities.set(source.opacities);
  target.multiplyColors.set(source.multiplyColors);
  target.screenColors.set(source.screenColors);
  target.visibilities.set(source.visibilities);
  target.renderOrders.set(source.renderOrders);
}

function dominant(entries: readonly SampledAction[]): SampledAction | undefined {
  return [...entries].sort((left, right) => right.weight - left.weight || right.order - left.order || left.action.id.localeCompare(right.action.id))[0];
}

function compareAction(left: SampledAction, right: SampledAction): number { return left.order - right.order || left.action.id.localeCompare(right.action.id); }
function hasChannel(action: DeformableMesh2DActionPose, channel: 'vertices' | 'opacity' | 'color' | 'visibility' | 'order'): boolean { return action.channels?.has(channel) ?? true; }

function clipTime(clip: DeformableMesh2DClipRange, time: number): number {
  if (!Number.isFinite(time)) throw new RangeError(`Clip "${clip.id}" time must be finite.`);
  const local = clip.loop === false ? Math.max(0, Math.min(clip.duration, time)) : modulo(time, clip.duration);
  return clip.start + local;
}

function validateClip(clip: DeformableMesh2DClipRange, modelDuration: number): void {
  if (!clip.id || !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.start + clip.duration > modelDuration + 1e-6) {
    throw new RangeError('Deformable clip range must have an id and stay inside the model timeline.');
  }
}

function topologyIdentity(data: ParsedDeformableMesh2DData): string {
  return data.drawables.map(drawable => `${drawable.id}:${drawable.vertexCount}:${drawable.indices.length}:${drawable.textureIndex}`).join('|');
}

function modulo(value: number, divisor: number): number { const result = value % divisor; return result < 0 ? result + divisor : result; }
