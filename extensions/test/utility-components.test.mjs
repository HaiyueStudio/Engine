import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasText2DRenderSystem, CanvasTextComponent } from '../dist/canvas-text.js';
import { Tilemap2DComponent } from '../dist/tilemap.js';
import { Tween2DComponent } from '../dist/tween.js';
import { Entity } from '../../engine/dist/ecs.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    VERTEX: 1 << 0,
    COPY_DST: 1 << 1,
    UNIFORM: 1 << 2,
  };
  globalThis.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1 << 0,
    COPY_DST: 1 << 1,
    RENDER_ATTACHMENT: 1 << 2,
  };
  globalThis.GPUShaderStage ??= {
    VERTEX: 1 << 0,
    FRAGMENT: 1 << 1,
  };
}

test('Tilemap2DComponent tracks dirty versions, resize preserves cells, and clone is independent', () => {
  const tilemap = new Tilemap2DComponent({
    columns: 2,
    rows: 2,
    cells: [1, 2, 3, 4],
    palette: [[0, 0, 0, 0], [1, 0, 0, 1]],
  });

  assert.equal(tilemap.getCell(1, 0), 2);
  assert.equal(tilemap.getCell(9, 9), 0);
  const initialVersion = tilemap.version;
  tilemap.setCell(1, 1, 7);
  assert.equal(tilemap.version, initialVersion + 1);
  tilemap.setCell(9, 9, 5);
  assert.equal(tilemap.version, initialVersion + 1);

  tilemap.resize(3, 2);
  assert.equal(tilemap.getCell(0, 0), 1);
  assert.equal(tilemap.getCell(1, 0), 2);
  assert.equal(tilemap.getCell(1, 1), 7);
  assert.equal(tilemap.getCell(2, 1), 0);

  const clone = tilemap.clone();
  assert.notEqual(clone.cells, tilemap.cells);
  assert.notEqual(clone.palette, tilemap.palette);
  clone.setCell(0, 0, 9);
  clone.palette[1][0] = 0.5;
  assert.equal(tilemap.getCell(0, 0), 1);
  assert.deepEqual(tilemap.palette[1], [1, 0, 0, 1]);
});

test('CanvasTextComponent proxies CssMaterial text/style and clone does not share style object', () => {
  const component = new CanvasTextComponent({
    text: 'Score',
    style: { fontSize: 20, fontFamily: 'sans-serif', color: '#fff' },
  });

  component.text = 'Level';
  component.style = { ...component.style, color: '#f00' };
  assert.equal(component.material.text, 'Level');
  assert.equal(component.material.style.color, '#f00');

  const clone = component.clone();
  assert.notEqual(clone.material, component.material);
  assert.notEqual(clone.style, component.style);
  clone.style = { ...clone.style, color: '#0f0' };
  assert.equal(component.style.color, '#f00');
  assert.equal(clone.text, 'Level');
});

test('CanvasText2DRenderSystem uploads when same-size texture source changes', () => {
  ensureGpuConstants();
  class MockCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
  }
  globalThis.HTMLCanvasElement = MockCanvas;
  globalThis.HTMLImageElement ??= class {};
  globalThis.ImageBitmap ??= class {};

  const log = [];
  const device = {
    queue: {
      writeTexture(...args) {
        log.push(['writeTexture', args[0].texture.label ?? null]);
      },
      copyExternalImageToTexture(source, destination, size) {
        log.push(['copyExternalImageToTexture', source.source.name, destination.texture.label ?? null, size[0], size[1]]);
      },
    },
    createBindGroupLayout(descriptor) {
      return { descriptor };
    },
    createSampler(descriptor) {
      return { descriptor };
    },
    createTexture(descriptor) {
      const texture = {
        label: descriptor.size[0] === 1 && descriptor.size[1] === 1 ? 'fallback' : `text-${descriptor.size[0]}x${descriptor.size[1]}`,
        descriptor,
        createView() {
          return { texture };
        },
        destroy() {
          log.push(['destroyTexture', texture.label]);
        },
      };
      return texture;
    },
    createBuffer(descriptor) {
      return {
        descriptor,
        destroy() {
          log.push(['destroyBuffer', descriptor.size]);
        },
      };
    },
    createBindGroup(descriptor) {
      return { descriptor };
    },
    createShaderModule(descriptor) {
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      return { descriptor };
    },
  };
  const engine = {
    device,
    format: 'bgra8unorm',
    reverseZ: false,
    msaaSamples: 1,
    getDepthFormat() {
      return 'depth24plus';
    },
  };
  const system = new CanvasText2DRenderSystem(engine, new Entity('Camera'));
  system.prepare();
  const entity = new Entity('Text');
  const component = new CanvasTextComponent({ text: '1', style: { width: 24, height: 24 } });
  const firstSource = new MockCanvas(48, 48);
  firstSource.name = 'first';
  const secondSource = new MockCanvas(48, 48);
  secondSource.name = 'second';

  component.material.texture = firstSource;
  component.material.textureVersion = 7;
  system.getTextureBindGroup(entity, component);
  system.getTextureBindGroup(entity, component);
  component.material.texture = secondSource;
  system.getTextureBindGroup(entity, component);

  assert.deepEqual(
    log.filter(item => item[0] === 'copyExternalImageToTexture').map(item => item[1]),
    ['first', 'second'],
  );
});

test('Tween2DComponent resolves from values once and clone excludes runtime progress', () => {
  const tween = new Tween2DComponent({
    from: { x: 10 },
    to: { x: 20, y: 30, scaleX: 2 },
    duration: -1,
    delay: -5,
    easing: 'missing-easing',
    removeOnComplete: false,
  });

  assert.equal(tween.duration, 0);
  assert.equal(tween.delay, 0);
  assert.deepEqual(tween.resolveFrom({ x: 1, y: 2, scaleX: 1 }), { x: 10, y: 2, scaleX: 1 });
  tween.started = true;
  assert.deepEqual(tween.resolveFrom({ x: 99, y: 99, scaleX: 99 }), { x: 10, y: 2, scaleX: 1 });
  assert.equal(tween.getEasingFunction()(0.25), 0.25);

  tween.elapsed = 100;
  tween.completed = true;
  const clone = tween.clone();
  assert.deepEqual(clone.from, { x: 10 });
  assert.deepEqual(clone.to, { x: 20, y: 30, scaleX: 2 });
  assert.equal(clone.removeOnComplete, false);
  assert.equal(clone.elapsed, 0);
  assert.equal(clone.started, false);
  assert.equal(clone.completed, false);
});
