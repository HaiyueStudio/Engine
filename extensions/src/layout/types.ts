/** Logical border-box pixels. Percentages use 100 for one containing dimension. */
export type LayoutLength = number | {readonly percent: number} | 'auto';
export interface LayoutEdges {readonly top?: LayoutLength; readonly right?: LayoutLength; readonly bottom?: LayoutLength; readonly left?: LayoutLength;}
export type LayoutTrack = number | {readonly percent: number} | {readonly fr: number} | {readonly min: number | {readonly percent: number}; readonly max: number | {readonly percent: number} | {readonly fr: number}};
type Alignment = 'start' | 'end' | 'center' | 'stretch';
type Distribution = 'start' | 'end' | 'center' | 'space-between' | 'space-around' | 'space-evenly';
export interface LayoutStyle {
  readonly display?: 'flex' | 'grid' | 'none'; readonly position?: 'relative' | 'absolute';
  readonly width?: LayoutLength; readonly height?: LayoutLength;
  readonly minWidth?: LayoutLength; readonly minHeight?: LayoutLength; readonly maxWidth?: LayoutLength; readonly maxHeight?: LayoutLength;
  readonly aspectRatio?: number; readonly margin?: LayoutEdges; readonly padding?: LayoutEdges; readonly border?: LayoutEdges; readonly inset?: LayoutEdges;
  readonly direction?: 'row' | 'row-reverse' | 'column' | 'column-reverse'; readonly writingDirection?: 'ltr' | 'rtl'; readonly wrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  readonly grow?: number; readonly shrink?: number; readonly basis?: LayoutLength;
  readonly justifyContent?: Distribution; readonly alignItems?: Alignment; readonly alignSelf?: 'auto' | Alignment;
  readonly alignContent?: Distribution | 'stretch';
  readonly rowGap?: number | {readonly percent: number}; readonly columnGap?: number | {readonly percent: number};
  readonly columns?: readonly LayoutTrack[]; readonly rows?: readonly LayoutTrack[];
  readonly placement?: {readonly column?: number; readonly row?: number; readonly columnSpan?: number; readonly rowSpan?: number};
}
export interface LayoutNode {readonly id: string; readonly contentVersion: number; readonly style: LayoutStyle; readonly children?: readonly LayoutNode[];}
export interface LayoutConstraints {
  readonly width: {readonly mode: 'exact' | 'at-most' | 'unbounded'; readonly value?: number};
  readonly height: {readonly mode: 'exact' | 'at-most' | 'unbounded'; readonly value?: number};
}
export type LayoutMeasure = (nodeId: string, constraints: LayoutConstraints) => {readonly width: number; readonly height: number; readonly minWidth: number; readonly minHeight: number};
export interface LayoutRect {readonly x: number; readonly y: number; readonly width: number; readonly height: number;}
export interface LayoutResult {
  readonly generation: number; readonly rects: ReadonlyMap<string, LayoutRect>; readonly contentBounds: ReadonlyMap<string, LayoutRect>;
  readonly measuredNodes: number; readonly solvedNodes: number;
}
export interface LayoutLimits {readonly maxNodes: number; readonly maxDepth: number; readonly maxMeasureEntriesPerNode: number; readonly maxConstraintPasses: number;}
export interface LayoutSession {
  update(root: LayoutNode, constraints: LayoutConstraints, measure: LayoutMeasure, options?: {readonly metricsVersion: number; readonly signal?: {readonly aborted: boolean}}): LayoutResult;
  invalidate(nodeIds: readonly string[]): void;
  dispose(): void;
}

/** Internal compatibility stages, selected only by the HYA adapter. */
export type LayoutProfile = 'gui-v1' | 'hya-v1';
export type Size = {width: number; height: number};
export type Edges = {top: number; right: number; bottom: number; left: number};
export type AxisConstraint = LayoutConstraints['width'];

export class LayoutError extends Error {
  override readonly name = 'LayoutError';
  constructor(readonly code: 'invalid-input' | 'cycle' | 'limit' | 'aborted' | 'disposed', message: string, readonly nodeId?: string) {super(message);}
}
