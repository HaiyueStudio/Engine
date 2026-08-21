/** Shared flat background used by both sides of animation fidelity comparisons. */
export const ANIMATION_COMPARE_BACKGROUND_HEX = '#050817';

export const ANIMATION_COMPARE_CLEAR_COLOR = Object.freeze({
  r: 5 / 255,
  g: 8 / 255,
  b: 23 / 255,
  a: 1,
});

/** Maps a uniform control range to fine low-end adjustment and fast high-end magnification. */
export function resolveAnimationCompareZoom(autoZoom: number, controlValue: number): number {
  const normalizedControl = Number.isFinite(controlValue) ? Math.max(0, controlValue) : 1;
  return autoZoom * normalizedControl ** 2;
}
