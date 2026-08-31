import {
  IndexedSpriteRenderer,
  prepareIndexedSpriteAtlas,
  type IndexedSpriteDrawCommand,
  type IndexedSpritePaletteDescriptor,
  type IndexedSpritePlaneDescriptor,
  type IndexedSpriteRendererOptions,
} from '../src/experimental-indexed-sprite';

declare const device: GPUDevice;
declare const pass: GPURenderPassEncoder;
declare const sprite: IndexedSpritePlaneDescriptor;
declare const palette: IndexedSpritePaletteDescriptor;

const options: IndexedSpriteRendererOptions = { targetFormat: 'bgra8unorm', sampleCount: 4 };
const layout = prepareIndexedSpriteAtlas([sprite], [palette]);
const renderer = new IndexedSpriteRenderer(device, [sprite], [palette], options);
const command: IndexedSpriteDrawCommand = { spriteId: sprite.id, paletteId: palette.id, x: 0, y: 0, sampling: 'nearest' };

layout.placements.get(sprite.id);
// @ts-expect-error The deterministic placement map is immutable.
layout.placements.set(sprite.id, layout.placements.get(sprite.id)!);
renderer.render(pass, [command], 1280, 720);
renderer.dispose();
