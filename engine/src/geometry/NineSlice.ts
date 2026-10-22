/** Pure logical-pixel slicing; rendering owns DPR, sampling and texture lifetime. */
export interface NineSliceOptions {
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Left, top, right, bottom source-pixel borders. */
  readonly cuts?: readonly [number, number, number, number];
  /** Alternating fixed/stretch boundaries for the existing HYA N-slice adapter. */
  readonly xCuts?: readonly number[];
  readonly yCuts?: readonly number[];
  /** Atlas origin and extent, in normalized texture coordinates. */
  readonly uv?: readonly [number, number, number, number];
  readonly maxPatches?: number;
}

export interface NineSlicePatch {
  readonly rect: Readonly<{x: number; y: number; width: number; height: number}>;
  readonly uv: readonly [number, number, number, number];
  /** Exact source-pixel coordinates avoid round trips through normalized UVs. */
  readonly sourceRect: readonly [number, number, number, number];
}

interface Segment {readonly offset: number; readonly destination: number; readonly start: number; readonly length: number;}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid nine-slice ${name}.`);
}

function axis(sourceSize: number, cuts: readonly number[], destinationSize: number): Segment[] {
  if (cuts.length % 2 !== 0) throw new RangeError('Slice boundaries must contain stretch-region pairs.');
  let previous = 0;
  for (const cut of cuts) {
    nonnegative(cut, 'boundary');
    if (cut < previous || cut > sourceSize) throw new RangeError('Slice boundaries must be ordered within the source.');
    previous = cut;
  }
  const boundaries = [0, ...cuts, sourceSize];
  const lengths = boundaries.slice(0, -1).map((start, index) => boundaries[index + 1]! - start);
  let fixed = 0, stretch = 0;
  lengths.forEach((length, index) => {if (index % 2 === 0) fixed += length; else stretch += length;});
  const fixedScale = destinationSize < fixed && fixed > 0 ? destinationSize / fixed : 1;
  const stretchScale = stretch > 0 ? Math.max(0, destinationSize - fixed * fixedScale) / stretch : 0;
  const stretchRegions = Math.floor(lengths.length / 2);
  let offset = 0;
  return lengths.map((length, index) => {
    const destination = index % 2 === 0 ? length * fixedScale : stretch > 0 ? length * stretchScale : Math.max(0, destinationSize - fixed * fixedScale) / stretchRegions;
    const segment = {offset, destination, start: boundaries[index]!, length};
    offset += destination;
    return segment;
  });
}

export function computeNineSlicePatches(options: NineSliceOptions): readonly NineSlicePatch[] {
  const {width, height, sourceWidth, sourceHeight} = options;
  for (const [name, value] of Object.entries({width, height, sourceWidth, sourceHeight})) nonnegative(value, name);
  if (sourceWidth === 0 || sourceHeight === 0) throw new RangeError('Nine-slice source dimensions must be positive.');
  let xCuts: readonly number[], yCuts: readonly number[];
  if (options.cuts) {
    if (options.xCuts || options.yCuts || options.cuts.length !== 4) throw new RangeError('Specify borders or paired axis boundaries, not both.');
    const [left, top, right, bottom] = options.cuts;
    for (const value of options.cuts) nonnegative(value, 'border');
    if (left + right > sourceWidth || top + bottom > sourceHeight) throw new RangeError('Nine-slice borders exceed the source.');
    xCuts = [left, sourceWidth - right]; yCuts = [top, sourceHeight - bottom];
  } else {
    if (!options.xCuts || !options.yCuts) throw new RangeError('Nine-slice requires source borders or both axis boundaries.');
    xCuts = options.xCuts; yCuts = options.yCuts;
  }
  const maximum = options.maxPatches ?? 4096;
  const count = (xCuts.length + 1) * (yCuts.length + 1);
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Number.isSafeInteger(count) || count > maximum) throw new RangeError('Nine-slice patch limit exceeded.');
  const uv = options.uv ?? [0, 0, 1, 1];
  if (uv.length !== 4 || uv.some(value => !Number.isFinite(value)) || uv.some(value => value < 0) || uv[0] + uv[2] > 1 || uv[1] + uv[3] > 1) throw new RangeError('Invalid nine-slice atlas UV rectangle.');
  const x = axis(sourceWidth, xCuts, width), y = axis(sourceHeight, yCuts, height);
  const patches: NineSlicePatch[] = [];
  for (const row of y) for (const column of x) {
    patches.push(Object.freeze({
      rect: Object.freeze({x: column.offset, y: row.offset, width: column.destination, height: row.destination}),
      uv: Object.freeze([uv[0] + column.start / sourceWidth * uv[2], uv[1] + row.start / sourceHeight * uv[3], column.length / sourceWidth * uv[2], row.length / sourceHeight * uv[3]]) as NineSlicePatch['uv'],
      sourceRect: Object.freeze([column.start, row.start, column.length, row.length]) as NineSlicePatch['sourceRect'],
    }));
  }
  return Object.freeze(patches);
}
