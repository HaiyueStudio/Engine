import type { CubismDrawableCapture } from './CubismCaptureConverter';

export interface CubismCaptureClipInput {
  readonly id: string;
  readonly name?: string;
  readonly capture: CubismDrawableCapture;
}

export interface CubismCaptureClipRange {
  readonly id: string;
  readonly name?: string;
  readonly start: number;
  readonly duration: number;
  readonly frameCount: number;
}

export interface CubismCaptureSetOptions {
  /** Unplayed separation that prevents interpolation across adjacent actions. Defaults to one 30 fps frame. */
  readonly interClipGap?: number;
  readonly name?: string;
}

export interface CubismCaptureSet {
  readonly capture: CubismDrawableCapture;
  readonly clips: readonly CubismCaptureClipRange[];
}

/** Pack same-model baked clips into one stable timeline without merging their playback ranges. */
export function combineCubismCaptureClips(
  inputs: readonly CubismCaptureClipInput[],
  options: CubismCaptureSetOptions = {},
): CubismCaptureSet {
  if (inputs.length === 0) throw new RangeError('Cubism capture set requires at least one clip.');
  const gap = options.interClipGap ?? 1 / 30;
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Cubism capture inter-clip gap must be finite and non-negative.');
  const ids = new Set<string>();
  const template = inputs[0]!.capture;
  const frames: Array<CubismDrawableCapture['frames'][number]> = [];
  const clips: CubismCaptureClipRange[] = [];
  let timelineEnd = 0;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    if (!input.id.trim()) throw new TypeError(`Cubism capture clip ${index} id must not be empty.`);
    if (ids.has(input.id)) throw new TypeError(`Cubism capture clip id "${input.id}" is duplicated.`);
    ids.add(input.id);
    assertCompatibleCapture(template, input.capture, index);
    const start = timelineEnd;
    for (const frame of input.capture.frames) frames.push(Object.freeze({ ...frame, time: start + frame.time }));
    clips.push(Object.freeze({
      id: input.id,
      ...(input.name === undefined ? {} : { name: input.name }),
      start,
      duration: input.capture.duration,
      frameCount: input.capture.frames.length,
    }));
    timelineEnd += input.capture.duration;
    if (index + 1 < inputs.length) timelineEnd += gap;
  }
  return Object.freeze({
    capture: Object.freeze({
      ...template,
      name: options.name ?? 'Cubism baked action set',
      source: Object.freeze({ kind: 'cubism-core-action-set', clipCount: clips.length }),
      duration: timelineEnd,
      frames: Object.freeze(frames),
    }),
    clips: Object.freeze(clips),
  });
}

function assertCompatibleCapture(template: CubismDrawableCapture, capture: CubismDrawableCapture, index: number): void {
  const sameCanvas = template.canvas.width === capture.canvas.width
    && template.canvas.height === capture.canvas.height
    && template.canvas.pixelsPerUnit === capture.canvas.pixelsPerUnit
    && template.canvas.coordinateSystem === capture.canvas.coordinateSystem
    && (template.canvas.uvOrigin ?? 'top-left') === (capture.canvas.uvOrigin ?? 'top-left');
  if (!sameCanvas) throw new TypeError(`Cubism capture clip ${index} canvas does not match the first clip.`);
  if (template.textures.length !== capture.textures.length) throw new TypeError(`Cubism capture clip ${index} texture count does not match the first clip.`);
  for (let textureIndex = 0; textureIndex < template.textures.length; textureIndex++) {
    const expected = template.textures[textureIndex]!;
    const actual = capture.textures[textureIndex]!;
    if (expected.id !== actual.id || expected.uri !== actual.uri) throw new TypeError(`Cubism capture clip ${index} texture ${textureIndex} does not match the first clip.`);
  }
}
