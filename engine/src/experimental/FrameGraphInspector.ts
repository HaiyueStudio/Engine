import type { Render3DSystem } from '../systems/Render3DSystem';
import { createFrameGraphCaptureInspector, type FrameGraphInspector } from '../core/FrameGraphCapture';
export type { FrameGraphInspector, FrameGraphSnapshot } from '../core/FrameGraphCapture';
/** Captures structural metadata and encoded work for one requested system record, with no GPU readback. */
export function createFrameGraphInspector(system: Render3DSystem): FrameGraphInspector {
  return createFrameGraphCaptureInspector(system);
}
