export const SCENE_RENDER_MAX_LIGHTS = 8;
/** Fixed PBR shadow-map array capacity. Additional shadow-casting lights stay lit but unshadowed. */
export const SCENE_RENDER_MAX_DIRECTIONAL_SHADOWS = 3;

export interface PbrLightInfo {
  type: 0 | 1 | 2;
  color: [number, number, number];
  intensity: number;
  direction: [number, number, number];
  position: [number, number, number];
  range: number;
}

