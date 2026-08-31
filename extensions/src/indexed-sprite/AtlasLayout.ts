import {
  DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS,
  type IndexedSpriteAtlasLayout,
  type IndexedSpriteAtlasLimits,
  type IndexedSpriteAtlasPage,
  type IndexedSpriteAtlasPlacement,
  type IndexedSpritePaletteDescriptor,
  type IndexedSpritePlaneDescriptor,
} from './contracts';

interface MutablePage {
  readonly kind: 'indexed' | 'color';
  readonly placements: Array<IndexedSpriteAtlasPlacement & { readonly source: Uint8Array; readonly sourceBytesPerPixel: number }>;
  x: number;
  y: number;
  shelfHeight: number;
  usedWidth: number;
  usedHeight: number;
}

export function prepareIndexedSpriteAtlas(
  sprites: readonly IndexedSpritePlaneDescriptor[],
  palettes: readonly IndexedSpritePaletteDescriptor[],
  limits: IndexedSpriteAtlasLimits = DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS,
): IndexedSpriteAtlasLayout {
  validateLimits(limits);
  const sortedSprites = [...sprites].sort((left, right) => compare(left.id, right.id));
  const sortedPalettes = [...palettes].sort((left, right) => compare(left.id, right.id));
  assertUnique(sortedSprites.map(value => value.id), 'sprite');
  assertUnique(sortedPalettes.map(value => value.id), 'palette');
  const mutablePages: MutablePage[] = [];
  const mutablePlacements = new Map<string, IndexedSpriteAtlasPlacement>();
  for (const sprite of sortedSprites) {
    validateSprite(sprite, limits);
    const kind = sprite.format === 'indexed8' ? 'indexed' : 'color';
    const sourceBytesPerPixel = sprite.format === 'indexed8' ? 1 : sprite.format === 'rgb8' ? 3 : 4;
    let page = mutablePages.find(value => value.kind === kind && canPlace(value, sprite.width, sprite.height, limits.maxTextureDimension2D));
    if (!page) {
      if (mutablePages.length >= limits.maxAtlasPages) throw new RangeError(`Indexed sprite atlas exceeds maxAtlasPages=${limits.maxAtlasPages}.`);
      page = { kind, placements: [], x: 0, y: 0, shelfHeight: 0, usedWidth: 0, usedHeight: 0 };
      mutablePages.push(page);
    }
    const point = place(page, sprite.width, sprite.height, limits.maxTextureDimension2D);
    const placement = Object.freeze({ spriteId: sprite.id, pageIndex: mutablePages.indexOf(page), pageKind: kind, x: point.x, y: point.y, width: sprite.width, height: sprite.height });
    page.placements.push({ ...placement, source: sprite.pixels.slice(), sourceBytesPerPixel });
    mutablePlacements.set(sprite.id, placement);
  }
  const pages: IndexedSpriteAtlasPage[] = mutablePages.map((page, index) => finalizePage(page, index));
  const mutablePaletteRows = new Map<string, number>();
  const paletteHeight = Math.max(1, sortedPalettes.length);
  const palettePixels = new Uint8Array(256 * paletteHeight * 4);
  sortedPalettes.forEach((palette, row) => {
    validatePalette(palette);
    mutablePaletteRows.set(palette.id, row);
    palettePixels.set(palette.rgba, row * 256 * 4);
  });
  if (palettePixels.byteLength > limits.maxPaletteGpuBytes) throw new RangeError(`Indexed sprite palette bank exceeds maxPaletteGpuBytes=${limits.maxPaletteGpuBytes}.`);
  const pageBytes = pages.reduce((total, page) => total + page.pixels.byteLength, 0);
  const gpuBytes = pageBytes + palettePixels.byteLength;
  if (gpuBytes > limits.maxGpuBytes) throw new RangeError(`Indexed sprite atlas exceeds maxGpuBytes=${limits.maxGpuBytes}.`);
  return Object.freeze({
    pages: Object.freeze(pages),
    placements: readonlyMap(mutablePlacements),
    paletteRows: readonlyMap(mutablePaletteRows),
    paletteWidth: 256 as const, paletteHeight, palettePixels,
    cpuBytes: gpuBytes, gpuBytes,
  });
}

function readonlyMap<Key, Value>(source: Map<Key, Value>): ReadonlyMap<Key, Value> {
  const view: ReadonlyMap<Key, Value> = {
    get size() { return source.size; },
    has: key => source.has(key),
    get: key => source.get(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback, thisArg) => source.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  };
  return Object.freeze(view);
}

function validateSprite(sprite: IndexedSpritePlaneDescriptor, limits: IndexedSpriteAtlasLimits): void {
  if (!sprite.id || !Number.isSafeInteger(sprite.width) || !Number.isSafeInteger(sprite.height) || sprite.width < 1 || sprite.height < 1 || sprite.width > limits.maxTextureDimension2D - 2 || sprite.height > limits.maxTextureDimension2D - 2) throw new RangeError(`Sprite ${sprite.id || '<empty>'} dimensions are invalid or exceed the atlas limit.`);
  const bytesPerPixel = sprite.format === 'indexed8' ? 1 : sprite.format === 'rgb8' ? 3 : sprite.format === 'rgba8' ? 4 : 0;
  if (bytesPerPixel === 0 || sprite.pixels.byteLength !== sprite.width * sprite.height * bytesPerPixel) throw new RangeError(`Sprite ${sprite.id} pixel byte length does not match its descriptor.`);
}

function validatePalette(palette: IndexedSpritePaletteDescriptor): void {
  if (!palette.id || !Number.isSafeInteger(palette.colorCount) || palette.colorCount < 1 || palette.colorCount > 256 || palette.rgba.byteLength !== palette.colorCount * 4) throw new RangeError(`Palette ${palette.id || '<empty>'} is invalid.`);
}

function validateLimits(limits: IndexedSpriteAtlasLimits): void { for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Indexed sprite limit ${key} must be a positive safe integer.`); }
function assertUnique(values: readonly string[], label: string): void { const seen = new Set<string>(); for (const value of values) { if (seen.has(value)) throw new RangeError(`Duplicate indexed sprite ${label} id: ${value}.`); seen.add(value); } }
function compare(left: string, right: string): number { const count = Math.min(left.length, right.length); for (let i = 0; i < count; i++) { const difference = left.charCodeAt(i) - right.charCodeAt(i); if (difference !== 0) return difference; } return left.length - right.length; }

function canPlace(page: MutablePage, width: number, height: number, maximum: number): boolean {
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  if (page.x + paddedWidth <= maximum && page.y + paddedHeight <= maximum) return true;
  return paddedWidth <= maximum && page.y + page.shelfHeight + paddedHeight <= maximum;
}

function place(page: MutablePage, width: number, height: number, maximum: number): { readonly x: number; readonly y: number } {
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  if (page.x + paddedWidth > maximum) { page.x = 0; page.y += page.shelfHeight; page.shelfHeight = 0; }
  const point = { x: page.x + 1, y: page.y + 1 };
  page.x += paddedWidth;
  page.shelfHeight = Math.max(page.shelfHeight, paddedHeight);
  page.usedWidth = Math.max(page.usedWidth, page.x);
  page.usedHeight = Math.max(page.usedHeight, page.y + page.shelfHeight);
  return point;
}

function finalizePage(page: MutablePage, index: number): IndexedSpriteAtlasPage {
  const bytesPerPixel = page.kind === 'indexed' ? 1 : 4;
  const pixels = new Uint8Array(page.usedWidth * page.usedHeight * bytesPerPixel);
  for (const placement of page.placements) {
    for (let y = -1; y <= placement.height; y++) {
      const sourceY = Math.max(0, Math.min(placement.height - 1, y));
      for (let x = -1; x <= placement.width; x++) {
        const sourceX = Math.max(0, Math.min(placement.width - 1, x));
        const sourceOffset = (sourceY * placement.width + sourceX) * placement.sourceBytesPerPixel;
        const targetOffset = ((placement.y + y) * page.usedWidth + placement.x + x) * bytesPerPixel;
        if (bytesPerPixel === 1) pixels[targetOffset] = placement.source[sourceOffset]!;
        else {
          pixels[targetOffset] = placement.source[sourceOffset]!;
          pixels[targetOffset + 1] = placement.source[sourceOffset + 1]!;
          pixels[targetOffset + 2] = placement.source[sourceOffset + 2]!;
          pixels[targetOffset + 3] = placement.sourceBytesPerPixel === 4 ? placement.source[sourceOffset + 3]! : 255;
        }
      }
    }
  }
  return Object.freeze({ index, kind: page.kind, width: page.usedWidth, height: page.usedHeight, bytesPerPixel: bytesPerPixel as 1 | 4, pixels });
}
