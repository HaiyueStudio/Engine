import { parseAtlas } from './spine/SpineAtlasParser';
import { normalizeSpineData } from './spine/SpineSkeletonRuntime';
import { Spine2DComponent } from './spine/Spine2DComponent';
import {
  advanceSpineRuntime,
  buildSpineVertices,
  createSpineRuntimeForBenchmark,
  sampleSpinePosesForBenchmark,
  type SpineRuntime,
} from './spine/Spine2DRuntime';
import type { AtlasPageGpu } from './spine/Spine2DGpuRenderer';
import type { AtlasRegion } from './spine/SpineAtlasParser';
import {
  compileSpineTimelines,
  createSpineTimelineSamplerState,
  findCompiledFrameIndex,
  sampleCompiledColor,
  sampleCompiledTimeline,
  type SpineTimelineSamplerState,
} from './spine/SpineTimelineRuntime';

/** Internal benchmark adapter. This file is built for the monorepo harness, not exported by the package. */
export function benchmarkSpineParse(
  data: { bones: Array<{ name: string; parent?: string }>; slots: Array<{ name: string; bone?: string }>; skins?: object },
  atlas: string,
): number {
  return normalizeSpineData(data).bones.length + parseAtlas(atlas).size;
}

export interface SpineAnimationBenchmarkState {
  readonly component: Spine2DComponent;
  readonly runtime: SpineRuntime;
  readonly boneCount: number;
  readonly slotCount: number;
  readonly keyframeCount: number;
}

export function createSpineAnimationBenchmarkState(
  boneCount: number,
  slotCount: number,
  keyframeCount: number,
): SpineAnimationBenchmarkState {
  const animationDuration = 2;
  const frameStep = animationDuration / Math.max(1, keyframeCount - 1);
  const bones = Array.from({ length: boneCount }, (_, boneIndex) => ({
    name: `bone${boneIndex}`,
    ...(boneIndex > 0 ? { parent: `bone${boneIndex - 1}` } : {}),
    x: boneIndex > 0 ? 1 : 0,
    length: 1,
  }));
  const slots = Array.from({ length: slotCount }, (_, slotIndex) => ({
    name: `slot${slotIndex}`,
    bone: `bone${slotIndex % boneCount}`,
    attachment: `region${slotIndex}`,
  }));
  const skin: Record<string, Record<string, object>> = {};
  const slotAnimations: Record<string, object> = {};
  const atlas = new Map<string, AtlasRegion>();
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
    const regionName = `region${slotIndex}`;
    skin[`slot${slotIndex}`] = {
      [regionName]: { type: 'region', name: regionName, path: regionName, width: 8, height: 8 },
    };
    slotAnimations[`slot${slotIndex}`] = {
      rgba: [
        { time: 0, color: 'ffffffff', curve: [0.25, 1, 0.75, 0.8, 0.25, 1, 0.75, 0.7, 0.25, 1, 0.75, 0.6, 0.25, 1, 0.75, 1] },
        { time: animationDuration, color: '80a0c0ff' },
      ],
    };
    atlas.set(regionName, {
      name: regionName,
      page: 'page.png',
      x: (slotIndex % 16) * 8,
      y: Math.floor(slotIndex / 16) * 8,
      width: 8,
      height: 8,
      originalWidth: 8,
      originalHeight: 8,
      offsetX: 0,
      offsetY: 0,
      rotate: 0,
    });
  }
  const boneAnimations: Record<string, object> = {};
  for (let boneIndex = 0; boneIndex < boneCount; boneIndex++) {
    const rotate = [];
    const translate = [];
    for (let frameIndex = 0; frameIndex < keyframeCount; frameIndex++) {
      const time = frameIndex * frameStep;
      const angle = Math.sin(frameIndex * 0.17 + boneIndex * 0.03) * 20;
      const nextAngle = Math.sin((frameIndex + 1) * 0.17 + boneIndex * 0.03) * 20;
      rotate.push(frameIndex + 1 < keyframeCount
        ? { time, angle, curve: [time + frameStep * 0.25, angle, time + frameStep * 0.75, nextAngle] }
        : { time, angle });
      translate.push({ time, x: Math.sin(frameIndex * 0.11) * 0.1, y: Math.cos(frameIndex * 0.13) * 0.1 });
    }
    boneAnimations[`bone${boneIndex}`] = { rotate, translate };
  }
  const data = normalizeSpineData({
    bones,
    slots,
    skins: { default: skin },
    animations: { benchmark: { bones: boneAnimations, slots: slotAnimations } },
  });
  const pages = new Map<string, AtlasPageGpu>([[
    'page.png',
    {
      image: null as unknown as HTMLImageElement,
      texture: null as unknown as GPUTexture,
      textureBindGroup: null as unknown as GPUBindGroup,
      width: 256,
      height: 256,
    },
  ]]);
  return {
    component: new Spine2DComponent({ animation: 'benchmark', loop: true }),
    runtime: createSpineRuntimeForBenchmark(data, atlas, pages),
    boneCount,
    slotCount,
    keyframeCount,
  };
}

export function benchmarkSpineAnimationSample(state: SpineAnimationBenchmarkState): number {
  advanceSpineRuntime(state.component, 16);
  return sampleSpinePosesForBenchmark(state.component, state.runtime);
}

export function benchmarkSpineVertexBuild(state: SpineAnimationBenchmarkState): number {
  advanceSpineRuntime(state.component, 16);
  const result = buildSpineVertices(state.component, state.runtime);
  return result.vertices.length + result.batches.length + result.vertexDirtyRanges.length;
}

export function benchmarkCompileSpineTimeline(frames: unknown[]): number {
  return compileSpineTimelines({ benchmark: { timeline: frames } }).frameCount;
}

export function benchmarkCreateSpineTimelineSamplerState(): SpineTimelineSamplerState {
  return createSpineTimelineSamplerState();
}

export function benchmarkSampleSpineTimeline(
  frames: unknown[],
  time: number,
  key: string,
  fallback: number,
  samplerState?: SpineTimelineSamplerState,
): number {
  return sampleCompiledTimeline(frames, time, key, fallback, 0, false, samplerState);
}

export function benchmarkFindSpineFrame(
  frames: unknown[],
  time: number,
  samplerState?: SpineTimelineSamplerState,
): number {
  return findCompiledFrameIndex(frames, time, samplerState);
}

export function benchmarkSampleSpineColor(
  frames: unknown[],
  time: number,
  fallback: [number, number, number, number],
  out: [number, number, number, number],
): [number, number, number, number] {
  return sampleCompiledColor(frames, time, fallback, out);
}
