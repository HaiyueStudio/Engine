import type { IEngine } from '../core/IEngine';
import type { Render3DSystem } from '../systems/Render3DSystem';
import { getDeferredLightingBackend, removeDeferredLightingBackend } from '../renderer/DeferredLightingBackendPort';
import { createDeferredReferenceProfile } from './DeferredReferenceProfile';
import { DEFERRED_TILE_LAYOUT as TILE } from '../shaders/generated/deferred-tile-layout.generated';

export interface DeferredLightingProfileOptions {
  readonly mode?: 'reference' | 'tiled';
  readonly signal?: AbortSignal;
  /** Explicit tile diagnostics; leave off for ordinary rendering. */
  readonly forceCulling?: boolean;
}
export type DeferredLightingDebugChannel = 'base-color' | 'normal' | 'metallic' | 'roughness' | 'emissive' | 'occlusion' | 'depth' | 'tiles';
export interface DeferredLightingDebugImage {
  readonly width: number; readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Unquantized device depth for caller-side position reconstruction. */
  readonly depth?: Float32Array<ArrayBuffer>;
  readonly fullListTiles?: number; readonly maxLights?: number;
}
export interface DeferredLightingProfile {
  snapshot(): {
    readonly active: boolean; readonly requested: string; readonly effective: string;
    readonly completeCoverage: boolean; readonly reason: string | null;
    readonly submittedPoints: number; readonly rejected: number;
    readonly allocatedBytes: number; readonly peakBytes: number;
    readonly uploadBytes: number; readonly uploadCount: number;
    readonly passes: readonly string[];
    readonly tiles: { readonly columns: number; readonly rows: number; readonly capacity: number; readonly unstored: number } | null;
  };
  /** Latest recorded view, opt-in asynchronous copy. Never called by the render loop. */
  readDebug(channel: DeferredLightingDebugChannel): Promise<DeferredLightingDebugImage | null>;
  /** Does not remove a newer profile on this system. */
  dispose(): void;
}

/** Experimental opt-in facade. The scene owns GPU lifetime; Forward does not load the backend. */
export async function createDeferredLightingProfile(system: Render3DSystem, engine: IEngine, options: DeferredLightingProfileOptions = {}): Promise<DeferredLightingProfile> {
  if (options.mode !== undefined && options.mode !== 'reference' && options.mode !== 'tiled') throw new RangeError('Invalid Deferred mode.');
  const { backend } = await createDeferredReferenceProfile(system, engine, {
    failurePolicy: 'strict', ...(options.signal ? { signal: options.signal } : {}),
    ...((options.mode ?? 'tiled') === 'tiled' ? { tiled: { forceCulling: options.forceCulling ?? false } } : {}),
  });
  let disposed = false, reading = false;
  const active = () => !disposed && getDeferredLightingBackend(system) === backend;
  return {
    snapshot() {
      const live = active(), detail = 'lastSource' in backend ? backend : undefined;
      const plan = live ? detail?.tileDiagnostics?.plan : undefined;
      return {
        active: live, requested: backend.diagnostics.requested, effective: live ? backend.diagnostics.effective : 'inactive',
        completeCoverage: live && backend.diagnostics.completeCoverage, reason: live ? backend.diagnostics.reason : 'profile-replaced-or-disposed',
        submittedPoints: live ? detail?.lastSource?.stats.pointCount ?? 0 : 0,
        rejected: live ? detail?.lastSource?.stats.rejectedCount ?? 0 : 0,
        allocatedBytes: live ? detail?.allocationDiagnostics.reservedBytes ?? 0 : 0,
        peakBytes: detail?.allocationDiagnostics.peakReservedBytes ?? 0,
        uploadBytes: (detail?.uploadStats?.sourceUploadBytes ?? 0) + (detail?.uploadStats?.viewUploadBytes ?? 0), uploadCount: (detail?.uploadStats?.sourceUploads ?? 0) + (detail?.uploadStats?.viewUploads ?? 0),
        passes: live ? detail?.passes.map(pass => pass.name) ?? [] : [],
        tiles: plan ? { columns: plan.columns, rows: plan.rows, capacity: plan.tileCapacity, unstored: plan.fullListTiles } : null,
      };
    },
    async readDebug(channel) {
      if (!active() || reading || !('lastSource' in backend) || !backend.diagnostics.completeCoverage) return null;
      const device = engine.device, tile = backend.tileDiagnostics;
      const channels = { 'base-color': 0, normal: 1, metallic: 0, roughness: 1, emissive: 2, occlusion: 2, depth: 3 };
      if (channel !== 'tiles' && !(channel in channels)) throw new RangeError('Invalid debug channel.');
      const texture = channel === 'tiles' ? undefined : backend.lastAttachments?.textures[channels[channel]];
      if (channel === 'tiles' ? !tile?.plan || !tile.binding || tile.bypassReason !== null : !texture) return null;
      reading = true;
      const width = texture?.width ?? tile!.plan!.columns, height = texture?.height ?? tile!.plan!.rows;
      const bytesPerPixel = channel === 'depth' ? 4 : 8, bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256;
      const byteSize = channel === 'tiles' ? tile!.plan!.byteSize : bytesPerRow * height;
      // Capture source population before the asynchronous copy, keeping diagnostics from the same frame.
      const pointCount = backend.lastSource?.stats.pointCount ?? 0;
      let staging: GPUBuffer | undefined;
      try {
        staging = device.createBuffer({ label: 'Deferred diagnostic readback', size: byteSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder({ label: 'Deferred diagnostic copy' });
        if (channel === 'tiles') encoder.copyBufferToBuffer(tile!.binding!.buffer, tile!.binding!.offset ?? 0, staging, 0, byteSize);
        else encoder.copyTextureToBuffer({ texture: texture!, ...(channel === 'depth' ? { aspect: 'depth-only' as const } : {}) }, { buffer: staging, bytesPerRow }, [width, height]);
        // Submit before yielding so subsequent profile/resize retirement follows this copy.
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        if (!active()) return null;
        const pixels = new Uint8ClampedArray(width * height * 4), data = new DataView(staging.getMappedRange());
        const depth = channel === 'depth' ? new Float32Array(width * height) : undefined;
        let fullListTiles = 0, maxLights = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = y * width + x, out = i * 4;
          if (channel === 'tiles') {
            const stored = i < tile!.plan!.storedTiles;
            const count = stored ? data.getUint32((i * TILE.strideWords + TILE.header.acceptedCount) * 4, true) : pointCount;
            const fallback = !stored || data.getUint32((i * TILE.strideWords + TILE.header.overflow) * 4, true) !== 0;
            maxLights = Math.max(maxLights, count); if (fallback) fullListTiles++;
            const t = Math.min(count / Math.max(1, tile!.plan!.tileCapacity), 1);
            pixels.set(fallback ? [255, 45, 150, 230] : [255 * t, 200 * (1 - t), 220 * (1 - t), 160], out);
          } else {
            const offset = y * bytesPerRow + x * bytesPerPixel;
            const values = channel === 'depth' ? [data.getFloat32(offset, true)] : [0, 1, 2, 3].map(c => half(data.getUint16(offset + c * 2, true)));
            if (depth) depth[i] = values[0]!;
            let rgb: number[];
            if (channel === 'depth') rgb = Array(3).fill(values[0]!);
            else if (['metallic', 'roughness', 'occlusion'].includes(channel)) rgb = Array(3).fill(values[3]!);
            else if (channel === 'normal') rgb = values.slice(0, 3).map(v => v * .5 + .5);
            else rgb = values.slice(0, 3).map(v => Math.pow(Math.max(0, channel === 'emissive' ? v / (1 + v) : v), 1 / 2.2));
            pixels.set([rgb[0]! * 255, rgb[1]! * 255, rgb[2]! * 255, 255], out);
          }
        }
        return { width, height, pixels, ...(depth ? { depth } : {}), ...(channel === 'tiles' ? { fullListTiles, maxLights } : {}) };
      } finally { if (staging?.mapState === 'mapped') staging.unmap(); staging?.destroy(); reading = false; }
    },
    dispose() { if (active()) removeDeferredLightingBackend(system); disposed = true; },
  };
}
function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = (value >> 10) & 31, fraction = value & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
