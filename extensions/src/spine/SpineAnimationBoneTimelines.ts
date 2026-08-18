import type {
  SpineAnimationBoneTimelines,
  SpineAnimationData,
} from './SpineSkeletonRuntime';

interface SpineAnimationBoneTimelineEntry {
  boneName: string;
  timelines: SpineAnimationBoneTimelines;
}

const cache = new WeakMap<object, SpineAnimationBoneTimelineEntry[]>();
const EMPTY: SpineAnimationBoneTimelineEntry[] = [];

export function compileAnimationBoneTimelines(animations: Record<string, SpineAnimationData>): void {
  for (const animation of Object.values(animations)) getAnimationBoneTimelines(animation);
}

export function getAnimationBoneTimelines(
  animation: SpineAnimationData | undefined,
): SpineAnimationBoneTimelineEntry[] {
  if (!animation || typeof animation !== 'object') return EMPTY;
  const cached = cache.get(animation);
  if (cached) return cached;
  const entries: SpineAnimationBoneTimelineEntry[] = [];
  for (const [boneName, timelines] of Object.entries(animation.bones ?? {})) {
    entries.push({ boneName, timelines });
  }
  cache.set(animation, entries);
  return entries;
}
