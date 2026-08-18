export interface GuiShapeCommand {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  color: [number, number, number, number];
  clip?: { x: number; y: number; width: number; height: number } | undefined;
}
