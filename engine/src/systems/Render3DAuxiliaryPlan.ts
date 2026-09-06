import { auxiliaryWritesDepth } from '../renderer/AuxiliaryMaterial';
import type { Render3DPostSceneItem, Render3DPostSceneRequirements } from './Render3DPostScenePasses';

export function isAuxiliarySurface(item: Render3DPostSceneItem): boolean {
  return !!item.geometry && !!item.worldMatrix && !!item.material && auxiliaryWritesDepth(item.material);
}

/** Preserve the ordered surface set, including equal-depth tie breaking. */
export function canShareMotionSurface(items: readonly Render3DPostSceneItem[], motionItems: readonly Render3DPostSceneItem[]): boolean {
  let motionIndex = 0;
  for (const item of items) {
    if (!isAuxiliarySurface(item)) continue;
    while (motionIndex < motionItems.length && !isAuxiliarySurface(motionItems[motionIndex]!)) motionIndex++;
    if (motionItems[motionIndex++] !== item) return false;
  }
  while (motionIndex < motionItems.length && !isAuxiliarySurface(motionItems[motionIndex]!)) motionIndex++;
  return motionIndex === motionItems.length;
}

export function auxiliarySurfacePassCount(requirements: Render3DPostSceneRequirements, sharedMotion: boolean): number {
  const { needsDepth, needsNormal, needsMotion } = requirements;
  return needsMotion && sharedMotion ? 1 : +(needsDepth || needsNormal) + +needsMotion;
}
