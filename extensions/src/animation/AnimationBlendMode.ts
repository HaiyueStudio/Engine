export type AnimationBlendMode = 'normal' | 'additive' | 'multiplicative' | 'screen';
export type AnimationTextureAlphaMode = 'straight' | 'premultiplied';

export interface AnimationBlendPixelInput {
  /** Straight-alpha display-encoded source sample after drawable tinting. */
  readonly source: readonly [number, number, number, number];
  /** Current render-target value. */
  readonly destination: readonly [number, number, number, number];
  readonly mode: AnimationBlendMode;
  readonly opacity?: number;
  readonly coverage?: number;
}

/** Official Cubism 5.2-and-earlier blend factors for premultiplied source colors. */
export function animationBlendState(mode: AnimationBlendMode): GPUBlendState {
  if (mode === 'additive') return {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  if (mode === 'multiplicative') return {
    color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  if (mode === 'screen') return {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  return {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
}

export function animationBlendFragmentEntryPoint(
  mode: AnimationBlendMode,
  textureAlphaMode: AnimationTextureAlphaMode = 'straight',
): 'fs_main' | 'fs_main_premultiplied_texture' {
  void mode;
  return textureAlphaMode === 'premultiplied' ? 'fs_main_premultiplied_texture' : 'fs_main';
}

/** Deterministic CPU oracle for the renderer's normalized RGBA target. */
export function composeAnimationBlendPixel(input: AnimationBlendPixelInput): readonly [number, number, number, number] {
  const sourceAlpha = clamp01(input.source[3] * (input.opacity ?? 1) * (input.coverage ?? 1));
  const source = [
    clamp01(input.source[0]) * sourceAlpha,
    clamp01(input.source[1]) * sourceAlpha,
    clamp01(input.source[2]) * sourceAlpha,
  ] as const;
  const destination = input.destination.map(clamp01) as [number, number, number, number];
  if (input.mode === 'additive') return [
    clamp01(source[0] + destination[0]),
    clamp01(source[1] + destination[1]),
    clamp01(source[2] + destination[2]),
    destination[3],
  ];
  if (input.mode === 'multiplicative') return [
    clamp01(source[0] * destination[0] + destination[0] * (1 - sourceAlpha)),
    clamp01(source[1] * destination[1] + destination[1] * (1 - sourceAlpha)),
    clamp01(source[2] * destination[2] + destination[2] * (1 - sourceAlpha)),
    destination[3],
  ];
  if (input.mode === 'screen') return [
    clamp01(source[0] + destination[0] * (1 - source[0])),
    clamp01(source[1] + destination[1] * (1 - source[1])),
    clamp01(source[2] + destination[2] * (1 - source[2])),
    clamp01(sourceAlpha + destination[3] * (1 - sourceAlpha)),
  ];
  return [
    clamp01(source[0] + destination[0] * (1 - sourceAlpha)),
    clamp01(source[1] + destination[1] * (1 - sourceAlpha)),
    clamp01(source[2] + destination[2] * (1 - sourceAlpha)),
    clamp01(sourceAlpha + destination[3] * (1 - sourceAlpha)),
  ];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
