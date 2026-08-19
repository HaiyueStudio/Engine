import type { MaterialTextureSource, PbrTextureSlot } from '@haiyue/engine/material';
import type { RayPackedAcceleration } from '../acceleration/index.js';

export type RayMaterialSeverity = 'info' | 'warning' | 'error';
export type RayMaterialPhase = 'extract' | 'material-pack' | 'texture-pack' | 'surface-pack';

export interface RayMaterialDiagnostic {
  readonly phase: RayMaterialPhase;
  readonly severity: RayMaterialSeverity;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayTexturePixels {
  readonly identity: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  /** Tightly packed RGBA8 texels in the source slot's declared color space. */
  readonly data: Uint8Array | Uint8ClampedArray;
}

export type RayTextureResolver = (
  source: MaterialTextureSource,
  slot: PbrTextureSlot,
  materialIdentity: string,
) => RayTexturePixels | null;

export interface RayPackedTextureAtlas {
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly bytesPerRow: number;
  readonly data: Uint8Array;
  readonly identities: readonly string[];
  readonly fingerprint: string;
}

export interface RayPackedMaterialBuffer {
  readonly stride: 128;
  readonly count: number;
  readonly data: ArrayBuffer;
}

export interface RayPackedSurfaceBuffer {
  readonly stride: 128;
  readonly count: number;
  readonly data: ArrayBuffer;
}

export interface RayPackedMaterialScene {
  readonly schemaVersion: 1;
  readonly accelerationFingerprint: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly materials: RayPackedMaterialBuffer;
  readonly surfaces: RayPackedSurfaceBuffer;
  readonly textures: RayPackedTextureAtlas;
  readonly materialIdentities: readonly string[];
  readonly diagnostics: readonly RayMaterialDiagnostic[];
  readonly unsupportedFeatures: readonly string[];
}

export interface RayMaterialPackOptions {
  readonly textureResolver?: RayTextureResolver;
  readonly maxTextureDimension?: number;
  readonly maxTextureLayers?: number;
}

export interface RayMaterialPackResult {
  readonly packed: RayPackedMaterialScene | null;
  readonly diagnostics: readonly RayMaterialDiagnostic[];
}

export interface RayMaterialSourceContext {
  readonly acceleration: RayPackedAcceleration;
}
