export interface GuiShapeCommand {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Tessellated outline; interior stays transparent without an extra shader variant. */
  strokeWidth?: number;
  color: [number, number, number, number];
  clip?: { x: number; y: number; width: number; height: number } | undefined;
}
