import { World } from '../ecs/World';
import { HaiyueEngine } from '../core/Engine';
import type { SampleableTextureSource } from '../material/BasicMaterial';
import { RttEngine } from './RttEngine';

export interface RttTextureOptions {
  width: number;
  height: number;
  clearColor?: { r: number; g: number; b: number; a: number };
  msaaSamples?: 1 | 4;
  reverseZ?: boolean;
}

/**
 * Render-to-texture container.
 *
 * Usage:
 *   const rtt = new RttTexture(engine, { width: 512, height: 384 });
 *
 *   // Populate the off-screen world with systems that use rtt.engine
 *   rtt.world.addSystem(new Render3DSystem(rtt.engine, camEntity));
 *   rtt.world.addEntity(camEntity);
 *
 *   // Apply the resulting texture to a mesh in the main scene
 *   new BasicMaterial({ texture: rtt.textureSource })
 *
 *   // In the render loop — call before the main scene
 *   rtt.render(time, delta);
 *   mainWorld.update(time, delta);
 */
export class RttTexture {
  /** The off-screen scene to render each frame */
  readonly world: World;

  /**
   * Pass this engine to Render3DSystem / Line3DRenderSystem / BitmapTextRenderSystem
   * that live inside this world so they target the off-screen textures.
   */
  readonly engine: RttEngine;
  readonly textureSource: SampleableTextureSource;
  private _version = 0;

  constructor(realEngine: HaiyueEngine, options: RttTextureOptions) {
    this.engine = new RttEngine(
      realEngine,
      options.width,
      options.height,
      options.clearColor ?? { r: 0.05, g: 0.05, b: 0.1, a: 1 },
    );
    if (options.msaaSamples) this.engine.msaaSamples = options.msaaSamples;
    if (options.reverseZ)    this.engine.reverseZ    = options.reverseZ;

    const thisRtt = this;
    this.textureSource = {
      get texture() { return thisRtt.engine.colorTexture; },
      get version() { return thisRtt.version; },
    };
    this.world = new World('RttTexture');
  }

  /** The current sampleable color texture. Use `textureSource` for resize-stable material references. */
  get texture(): GPUTexture {
    return this.engine.colorTexture;
  }

  get version(): number {
    return this._version;
  }

  /**
   * Render the off-screen world for this frame.
   * Call this BEFORE updating the main scene so the texture is ready for sampling.
   */
  render(time: number, delta: number): void {
    this.world.update(time, delta);
  }

  /**
   * Resize the off-screen render targets.
   * Materials referencing `this.textureSource` will pick up the new GPUTexture
   * on the next render. Direct `this.texture` references are one-shot snapshots.
   */
  resize(width: number, height: number): void {
    this.engine.resize(width, height);
    this._version++;
  }

  destroy(): void {
    this.engine.destroy();
  }
}
