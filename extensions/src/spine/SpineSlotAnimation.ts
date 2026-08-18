import type { Spine2DComponent } from './Spine2DComponent';
import type {
  RegionAttachment,
  SliderAnimationState,
  SlotData,
  SpineData,
} from './SpineSkeletonRuntime';
import {
  findCompiledFrameIndex,
  sampleCompiledColor,
  type SpineTimelineSamplerState,
} from './SpineTimelineRuntime';

interface SpineSlotAnimationRuntime {
  readonly data: SpineData;
  readonly timelineSamplerState: SpineTimelineSamplerState;
  readonly slotColorScratch: [number, number, number, number];
  readonly sliderColorScratch: [number, number, number, number];
}

type SpineSlotAnimationComponent = Pick<Spine2DComponent, 'animation' | 'skin'>;

interface SpineSequenceFrame {
  readonly time?: number;
  readonly delay?: number;
  readonly index?: number;
  readonly mode?: string;
}

const WHITE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

/** Resolves the active slot attachment timeline without owning pose evaluation. */
export function getSpineSlotAttachmentName(
  runtime: SpineSlotAnimationRuntime,
  component: SpineSlotAnimationComponent,
  slot: SlotData,
  time: number,
): string | null {
  let name: string | null = slot.attachment ?? null;
  const frames = runtime.data.animations[component.animation]?.slots?.[slot.name]?.attachment;
  if (!Array.isArray(frames) || frames.length === 0) return name;
  const frameIndex = findCompiledFrameIndex(frames, time, runtime.timelineSamplerState);
  if (frameIndex >= 0) name = frames[frameIndex]?.name ?? null;
  return name;
}

/** Resolves sequence attachments across the base animation and slider overlays. */
export function getSpineAttachmentRegionName(
  runtime: SpineSlotAnimationRuntime,
  component: SpineSlotAnimationComponent,
  slot: SlotData,
  attachmentName: string,
  attachment: RegionAttachment,
  time: number,
  sliderStates: readonly SliderAnimationState[],
): string {
  const basePath = attachment.path || attachment.name || attachmentName;
  const sequence = attachment.sequence;
  if (!sequence?.count) return basePath;
  let index = sampleSequenceIndex(
    getSequenceFrames(runtime.data, component.animation, component.skin, slot.name, attachmentName),
    time,
    sequence,
    runtime.timelineSamplerState,
  );
  for (const slider of sliderStates) {
    const frames = getSequenceFrames(runtime.data, slider.animation, component.skin, slot.name, attachmentName);
    if (Array.isArray(frames) && frames.length > 0) {
      index = sampleSequenceIndex(frames, slider.time, sequence, runtime.timelineSamplerState);
    }
  }
  const frame = String((sequence.start ?? 0) + index).padStart(sequence.digits ?? 0, '0');
  return `${basePath}${frame}`;
}

/** Samples slot RGBA timelines and slider blends into runtime-owned scratch storage. */
export function getSpineSlotColor(
  runtime: SpineSlotAnimationRuntime,
  component: SpineSlotAnimationComponent,
  slot: SlotData,
  time: number,
  sliderStates: readonly SliderAnimationState[],
): [number, number, number, number] {
  const frames = runtime.data.animations[component.animation]?.slots?.[slot.name]?.rgba;
  const fallback = slot.color ?? WHITE_COLOR;
  const color = runtime.slotColorScratch;
  if (Array.isArray(frames) && frames.length > 0) {
    sampleCompiledColor(frames, time, fallback, color, runtime.timelineSamplerState);
  } else {
    copyColor(fallback, color);
  }
  for (const slider of sliderStates) {
    const sliderFrames = runtime.data.animations[slider.animation]?.slots?.[slot.name]?.rgba;
    if (!Array.isArray(sliderFrames) || sliderFrames.length === 0) continue;
    sampleCompiledColor(
      sliderFrames,
      slider.time,
      color,
      runtime.sliderColorScratch,
      runtime.timelineSamplerState,
    );
    mixColorInto(color, runtime.sliderColorScratch, slider.mix);
  }
  return color;
}

function getSequenceFrames(
  data: SpineData,
  animationName: string,
  skinName: string,
  slotName: string,
  attachmentName: string,
): SpineSequenceFrame[] | undefined {
  const frames = data.animations[animationName]?.attachments?.[skinName]?.[slotName]?.[attachmentName]?.sequence
    ?? data.animations[animationName]?.attachments?.default?.[slotName]?.[attachmentName]?.sequence;
  return Array.isArray(frames) ? frames as SpineSequenceFrame[] : undefined;
}

function sampleSequenceIndex(
  frames: SpineSequenceFrame[] | undefined,
  time: number,
  sequence: NonNullable<RegionAttachment['sequence']>,
  samplerState: SpineTimelineSamplerState,
): number {
  const count = Math.max(1, sequence.count ?? 1);
  if (!Array.isArray(frames) || frames.length === 0) {
    return clampSequenceIndex(sequence.setup ?? 0, count);
  }
  const frameIndex = findCompiledFrameIndex(frames, time, samplerState);
  if (frameIndex < 0) return clampSequenceIndex(sequence.setup ?? 0, count);
  const frame = frames[frameIndex];
  if (!frame) return clampSequenceIndex(sequence.setup ?? 0, count);
  const before = frame.time ?? 0;
  const delay = frame.delay ?? 0;
  let index = frame.index ?? 0;
  const mode = frame.mode ?? 'hold';
  if (mode !== 'hold' && delay > 0) {
    index += Math.floor((time - before) / delay + 0.00001);
    switch (mode) {
      case 'once':
        index = Math.min(count - 1, index);
        break;
      case 'loop':
        index %= count;
        break;
      case 'pingpong': {
        const range = count * 2 - 2;
        index = range === 0 ? 0 : index % range;
        if (index >= count) index = range - index;
        break;
      }
      case 'onceReverse':
        index = Math.max(count - 1 - index, 0);
        break;
      case 'loopReverse':
        index = count - 1 - (index % count);
        break;
      case 'pingpongReverse': {
        const range = count * 2 - 2;
        index = range === 0 ? 0 : (index + count - 1) % range;
        if (index >= count) index = range - index;
        break;
      }
      default:
        break;
    }
  }
  return clampSequenceIndex(index, count);
}

function clampSequenceIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(index)));
}

function mixColorInto(
  out: [number, number, number, number],
  to: [number, number, number, number],
  mix: number,
): void {
  const alpha = Math.max(0, Math.min(1, mix));
  out[0] += (to[0] - out[0]) * alpha;
  out[1] += (to[1] - out[1]) * alpha;
  out[2] += (to[2] - out[2]) * alpha;
  out[3] += (to[3] - out[3]) * alpha;
}

function copyColor(
  source: [number, number, number, number],
  out: [number, number, number, number],
): void {
  out[0] = source[0];
  out[1] = source[1];
  out[2] = source[2];
  out[3] = source[3];
}
