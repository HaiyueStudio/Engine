import { EngineError, EngineErrorCode } from '@haiyue/engine';
import { ErrorDomain, ErrorRecovery } from '@haiyue/engine/core';

export interface AtlasRegion {
  name: string;
  page: string;
  x: number;
  y: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  offsetX: number;
  offsetY: number;
  rotate: number;
}

export interface ResolveAtlasPageImageOptions {
  atlasUrl: string;
  imageUrl: string;
  imageUrls: Record<string, string>;
}

export function parseAtlas(text: string): Map<string, AtlasRegion> {
  const regions = new Map<string, AtlasRegion>();
  const lines = text.split(/\r?\n/);
  let page = '';
  for (let i = 0; i < lines.length; i++) {
    const sourceLine = lines[i];
    if (sourceLine === undefined) continue;
    const line = sourceLine.trim();
    if (!line) continue;
    if (!line.includes(':')) {
      const next = lines[i + 1]?.trim() ?? '';
      if (next.startsWith('size:') || next.startsWith('format:') || next.startsWith('filter:') || next.startsWith('repeat:')) {
        page = line;
        continue;
      }
      const name = line;
      const region: AtlasRegion = {
        name,
        page,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        originalWidth: 0,
        originalHeight: 0,
        offsetX: 0,
        offsetY: 0,
        rotate: 0,
      };
      while (i + 1 < lines.length) {
        const propertyLine = lines[i + 1];
        if (propertyLine === undefined || !propertyLine.includes(':')) break;
        i++;
        const separator = propertyLine.indexOf(':');
        const key = propertyLine.slice(0, separator).trim();
        const raw = propertyLine.slice(separator + 1).trim();
        const nums = raw.split(',').map(Number);
        const numberAt = (index: number, fallback: number): number => {
          const value = nums[index];
          return value !== undefined && Number.isFinite(value) ? value : fallback;
        };
        if (key === 'rotate') region.rotate = raw === 'true' ? 90 : raw === 'false' ? 0 : Number(raw) || 0;
        if (key === 'bounds') {
          region.x = numberAt(0, region.x);
          region.y = numberAt(1, region.y);
          region.width = numberAt(2, region.width);
          region.height = numberAt(3, region.height);
        }
        if (key === 'xy') {
          region.x = numberAt(0, region.x);
          region.y = numberAt(1, region.y);
        }
        if (key === 'size') {
          region.width = numberAt(0, region.width);
          region.height = numberAt(1, region.height);
        }
        if (key === 'orig') {
          region.originalWidth = numberAt(0, region.originalWidth);
          region.originalHeight = numberAt(1, region.originalHeight);
        }
        if (key === 'offsets') {
          region.offsetX = numberAt(0, region.offsetX);
          region.offsetY = numberAt(1, region.offsetY);
          region.originalWidth = numberAt(2, region.originalWidth);
          region.originalHeight = numberAt(3, region.originalHeight);
        }
        if (key === 'offset') {
          region.offsetX = numberAt(0, region.offsetX);
          region.offsetY = numberAt(1, region.offsetY);
        }
      }
      if (!region.originalWidth && !region.originalHeight) {
        region.originalWidth = region.width;
        region.originalHeight = region.height;
      }
      regions.set(name, region);
    }
  }
  return regions;
}

export function resolveAtlasPageImageUrl(
  options: ResolveAtlasPageImageOptions,
  atlas: Map<string, AtlasRegion>,
  page: string,
): string {
  const mapped = options.imageUrls[page] ?? options.imageUrls[page.split('/').pop() ?? page];
  if (mapped) return mapped;
  if (options.imageUrl && (!page || atlasPageCount(atlas) <= 1)) return options.imageUrl;
  if (!page) {
    if (options.imageUrl) return options.imageUrl;
    throw new EngineError(EngineErrorCode.AssetInvalidData, 'Spine imageUrl is required when atlas has no page.', {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.ReleaseResource,
      context: { atlasUrl: options.atlasUrl, resourceType: 'skeleton/spine-atlas' },
      path: 'spine.atlas.pages',
    });
  }
  return new URL(page, options.atlasUrl || window.location.href).href;
}

export function atlasPageCount(atlas: Map<string, AtlasRegion>): number {
  return new Set(Array.from(atlas.values()).map(region => region.page).filter(Boolean)).size;
}
