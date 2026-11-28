import type {GuiClipRect} from './GuiPaintParameters';
export interface GuiShapeCommand {
  rotation?: number;
  /** Analytic box/arc style, packed once per command instead of once per vertex. */
  appearance?: Readonly<{
    radii?: readonly [number,number,number,number]; borderWidth?: number; borderColor?: readonly [number,number,number,number];
    gradient?: Readonly<{color: readonly [number,number,number,number]; angle: number}>;
    blur?: number; arc?: Readonly<{start: number; end: number; thickness: number}>;
  }>;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Tessellated outline; interior stays transparent without an extra shader variant. */
  strokeWidth?: number;
  /** Rounded silhouette geometry lets MSAA smooth capsule/circle boundaries. */
  roundedMesh?: boolean;
  color: [number, number, number, number];
  clip?: GuiClipRect | undefined;
}
