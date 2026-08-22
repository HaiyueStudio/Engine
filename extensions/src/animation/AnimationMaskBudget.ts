import { AnimationFormatError } from '@haiyue/animation-spec';

/** 256 MiB of rgba8 mask targets before allocator/tracker overhead. */
export const ANIMATION_2D_MAX_MASK_PIXELS = 64 * 1024 * 1024;

export interface AnimationMaskBudgetInput {
  readonly groupCount: number;
  readonly maxGroupCount: number;
  readonly width: number;
  readonly height: number;
  readonly maxTextureDimension2D: number;
  readonly maxPixels?: number;
  readonly viewKey: string;
}

export function animationMaskTargetKey(viewKey: string, sourceKey: string): string {
  return `${viewKey.length}:${viewKey}${sourceKey.length}:${sourceKey}`;
}

export function animationMaskCompositeKey(viewKey: string, sourceKeys: readonly string[]): string {
  return `${viewKey.length}:${viewKey}${sourceKeys.map(key => `${key.length}:${key}`).join('')}`;
}

/** Classifies every mask allocation limit before any GPU target is created. */
export function assertAnimationMaskBudget(input: AnimationMaskBudgetInput): void {
  const basePath = `$runtime.views[${JSON.stringify(input.viewKey)}]`;
  if (!Number.isSafeInteger(input.groupCount) || input.groupCount < 0) {
    throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', 'Mask group count must be a non-negative safe integer.', `${basePath}.maskGroups`);
  }
  if (input.groupCount > input.maxGroupCount) {
    throw new AnimationFormatError(
      'E_ANIMATION_LIMIT_EXCEEDED',
      `Mask group count ${input.groupCount} exceeds limit ${input.maxGroupCount}.`,
      `${basePath}.maskGroups`,
    );
  }
  if (!Number.isSafeInteger(input.width) || input.width <= 0 || !Number.isSafeInteger(input.height) || input.height <= 0) {
    throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', 'Mask target dimensions must be positive safe integers.', `${basePath}.maskTexture`);
  }
  if (input.width > input.maxTextureDimension2D || input.height > input.maxTextureDimension2D) {
    throw new AnimationFormatError(
      'E_ANIMATION_LIMIT_EXCEEDED',
      `Mask target ${input.width}x${input.height} exceeds device maxTextureDimension2D ${input.maxTextureDimension2D}.`,
      `${basePath}.maskTexture`,
    );
  }
  const pixels = input.width * input.height * input.groupCount;
  const maxPixels = input.maxPixels ?? ANIMATION_2D_MAX_MASK_PIXELS;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new AnimationFormatError(
      'E_ANIMATION_LIMIT_EXCEEDED',
      `Mask target pixels ${pixels} exceed aggregate limit ${maxPixels}.`,
      `${basePath}.maskPixels`,
    );
  }
}
