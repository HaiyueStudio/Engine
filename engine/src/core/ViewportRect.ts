/** Defines the region of the render target to draw into. */
export interface ViewportRect {
  /** Pixels from the left edge of the canvas. */
  x: number;
  /** Pixels from the top edge of the canvas. */
  y: number;
  width: number;
  height: number;
  /** Depth range minimum (default 0). */
  minDepth?: number;
  /** Depth range maximum (default 1). */
  maxDepth?: number;
}

/** Clips rendering to this rectangle; fragments outside are discarded. */
export interface ScissorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
