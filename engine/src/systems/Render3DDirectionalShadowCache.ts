import type { DirectionalLight } from '../lighting/DirectionalLight';

/**
 * Tracks every input that makes the scene-global directional shadow map reusable.
 * Keeping this policy separate prevents Render3DSystem from owning another
 * renderer-specific cache lifecycle.
 */
export class Render3DDirectionalShadowCache {
  private valid = false;
  private light: DirectionalLight | null = null;
  private lightVersion = -1;
  private readonly direction = new Float64Array(3);
  private readonly settings = new Float64Array(6);
  private casterRevisionA = 0;
  private casterRevisionB = 0;
  private casterCount = 0;

  matches(
    light: DirectionalLight,
    hasShadowState: boolean,
    casterRevisionA: number,
    casterRevisionB: number,
    casterCount: number,
  ): boolean {
    if (
      !this.valid
      || !hasShadowState
      || this.light !== light
      || this.lightVersion !== light.version
      || this.casterRevisionA !== casterRevisionA
      || this.casterRevisionB !== casterRevisionB
      || this.casterCount !== casterCount
    ) return false;

    const direction = light.direction;
    if (
      this.direction[0] !== direction[0]
      || this.direction[1] !== direction[1]
      || this.direction[2] !== direction[2]
    ) return false;

    const shadow = light.shadow;
    return this.settings[0] === shadow.mapSize
      && this.settings[1] === shadow.extent
      && this.settings[2] === shadow.near
      && this.settings[3] === shadow.far
      && this.settings[4] === shadow.bias
      && this.settings[5] === shadow.normalBias;
  }

  store(
    light: DirectionalLight,
    casterRevisionA: number,
    casterRevisionB: number,
    casterCount: number,
  ): void {
    this.valid = true;
    this.light = light;
    this.lightVersion = light.version;
    this.direction.set(light.direction);
    const shadow = light.shadow;
    this.settings[0] = shadow.mapSize;
    this.settings[1] = shadow.extent;
    this.settings[2] = shadow.near;
    this.settings[3] = shadow.far;
    this.settings[4] = shadow.bias;
    this.settings[5] = shadow.normalBias;
    this.casterRevisionA = casterRevisionA;
    this.casterRevisionB = casterRevisionB;
    this.casterCount = casterCount;
  }

  invalidate(): void {
    this.valid = false;
  }

  reset(): void {
    this.valid = false;
    this.light = null;
    this.lightVersion = -1;
    this.casterRevisionA = 0;
    this.casterRevisionB = 0;
    this.casterCount = 0;
  }
}
