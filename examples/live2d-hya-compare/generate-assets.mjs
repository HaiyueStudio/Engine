import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { encodeAnimationBinary } from '../../animation-spec/dist/index.js';
import { convertCubismCaptureToHya } from '../../animation-spec/dist/live2d.js';
import { createDeformableMesh2DFormatRegistry } from '../../animation-spec/dist/deformable2d.js';

const root = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(root, '../live2d-hya/assets');
const outputRoot = resolve(root, 'samples');
const sourceCapture = JSON.parse(await readFile(resolve(sourceRoot, 'mascot.capture.json'), 'utf8'));
const capture = { ...sourceCapture, textures: sourceCapture.textures.map(texture => ({ ...texture, uri: 'samples/mascot.png' })) };
const converted = convertCubismCaptureToHya(capture, { dataUri: 'samples/mascot.hydm', strict: true });
const hya = encodeAnimationBinary(converted.document, { extensions: createDeformableMesh2DFormatRegistry() });
const maskCapture = createMaskParityCapture();
const maskConverted = convertCubismCaptureToHya(maskCapture, { dataUri: 'samples/mask-parity.hydm', strict: true });
const maskHya = encodeAnimationBinary(maskConverted.document, { extensions: createDeformableMesh2DFormatRegistry() });
const blendCapture = createBlendParityCapture();
const blendConverted = convertCubismCaptureToHya(blendCapture, { dataUri: 'samples/blend-parity.hydm', strict: true });
const blendHya = encodeAnimationBinary(blendConverted.document, { extensions: createDeformableMesh2DFormatRegistry() });
await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(resolve(outputRoot, 'mascot.hya'), new Uint8Array(hya)),
  writeFile(resolve(outputRoot, 'mascot.hydm'), new Uint8Array(converted.data)),
  copyFile(resolve(sourceRoot, 'mascot.png'), resolve(outputRoot, 'mascot.png')),
  copyFile(resolve(sourceRoot, 'mascot.capture.json'), resolve(outputRoot, 'mascot.capture.json')),
  writeFile(resolve(outputRoot, 'mask-parity.hya'), new Uint8Array(maskHya)),
  writeFile(resolve(outputRoot, 'mask-parity.hydm'), new Uint8Array(maskConverted.data)),
  writeFile(resolve(outputRoot, 'mask-parity.capture.json'), `${JSON.stringify(maskCapture, null, 2)}\n`),
  writeFile(resolve(outputRoot, 'mask-parity-conversion-report.json'), `${JSON.stringify({ diagnostics: maskConverted.diagnostics, report: maskConverted.report }, null, 2)}\n`),
  copyFile(resolve(sourceRoot, 'mascot.png'), resolve(outputRoot, 'mask-parity.png')),
  writeFile(resolve(outputRoot, 'blend-parity.hya'), new Uint8Array(blendHya)),
  writeFile(resolve(outputRoot, 'blend-parity.hydm'), new Uint8Array(blendConverted.data)),
  writeFile(resolve(outputRoot, 'blend-parity.capture.json'), `${JSON.stringify(blendCapture, null, 2)}\n`),
  writeFile(resolve(outputRoot, 'blend-parity-conversion-report.json'), `${JSON.stringify({ diagnostics: blendConverted.diagnostics, report: blendConverted.report }, null, 2)}\n`),
  writeFile(resolve(outputRoot, 'blend-parity-a.png'), createBlendTexture(64, 64, 'foreground')),
  writeFile(resolve(outputRoot, 'blend-parity-b.png'), createBlendTexture(64, 64, 'background')),
]);
console.log(`Generated Live2D comparison samples: mascot ${hya.byteLength}/${converted.data.byteLength} bytes; mask parity ${maskHya.byteLength}/${maskConverted.data.byteLength} bytes; blend parity ${blendHya.byteLength}/${blendConverted.data.byteLength} bytes.`);

function createMaskParityCapture() {
  const quad = (x, y, width, height) => [
    x - 256, 256 - y,
    x + width - 256, 256 - y,
    x - 256, 256 - y - height,
    x + width - 256, 256 - y - height,
  ];
  const drawable = ({ id, order, positions, opacity = 1, visible = true, masks = [], invertedMask = false }) => ({
    id,
    textureIndex: 0,
    renderOrder: order,
    opacity,
    visible,
    blendMode: 'normal',
    culling: false,
    masks,
    invertedMask,
    positions,
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 1, 2, 2, 1, 3],
    multiplyColor: [1, 1, 1, 1],
    screenColor: [0, 0, 0, 0],
  });
  const frame = (time, shift, opacity, visible) => ({ time, drawables: [
    drawable({ id: 'mask-a', order: 0, positions: quad(72 + shift, 112, 192, 256), opacity, visible }),
    drawable({ id: 'mask-b', order: 1, positions: quad(176 - shift, 132, 192, 256), opacity: 0.55 }),
    drawable({ id: 'masked-single', order: 2, positions: quad(72, 112, 192, 256), masks: ['mask-a'] }),
    drawable({ id: 'masked-union', order: 3, positions: quad(120, 104, 256, 288), masks: ['mask-a', 'mask-b'] }),
    drawable({ id: 'masked-inverted', order: 4, positions: quad(120, 104, 256, 288), masks: ['mask-b', 'mask-a'], invertedMask: true }),
  ] });
  return {
    format: 'live2d-cubism-drawable-capture',
    version: 1,
    name: 'Synthetic Cubism mask composition parity fixture',
    source: { license: 'MIT', purpose: 'G10 mask composition browser parity' },
    canvas: { width: 512, height: 512, pixelsPerUnit: 1, coordinateSystem: 'model-y-up', uvOrigin: 'top-left' },
    duration: 2,
    frameRate: 1,
    textures: [{ id: 'mask-parity-texture', uri: 'samples/mask-parity.png', width: 512, height: 512 }],
    frames: [frame(0, 0, 0.2, true), frame(1, 28, 0.85, false), frame(2, 0, 0.4, true)],
  };
}

function createBlendParityCapture() {
  const quad = (x, y, width, height) => [
    x - 256, 256 - y,
    x + width - 256, 256 - y,
    x - 256, 256 - y - height,
    x + width - 256, 256 - y - height,
  ];
  const drawable = ({ id, textureIndex, order, positions, opacity = 1, masks = [], blendMode = 'normal' }) => ({
    id,
    textureIndex,
    renderOrder: order,
    opacity,
    visible: true,
    blendMode,
    culling: false,
    masks,
    invertedMask: false,
    positions,
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 1, 2, 2, 1, 3],
    multiplyColor: [1, 1, 1, 1],
    screenColor: [0, 0, 0, 0],
  });
  const frame = (time, shift, reversed) => ({ time, drawables: [
    drawable({ id: 'mask-source', textureIndex: 1, order: 0, positions: quad(112 + shift, 96, 288, 320), opacity: 0 }),
    drawable({ id: 'background', textureIndex: 1, order: 1, positions: quad(48, 64, 416, 384), opacity: 0.92 }),
    drawable({ id: 'normal', textureIndex: 0, order: 2, positions: quad(72 + shift, 136, 152, 224), opacity: reversed ? 0.42 : 0.72 }),
    drawable({ id: 'additive', textureIndex: 0, order: reversed ? 4 : 3, positions: quad(180 - shift, 120, 152, 256), opacity: reversed ? 0.8 : 0.55, masks: ['mask-source'], blendMode: 'additive' }),
    drawable({ id: 'multiplicative', textureIndex: 0, order: reversed ? 3 : 4, positions: quad(288 + shift, 136, 152, 224), opacity: reversed ? 0.5 : 0.78, masks: ['mask-source'], blendMode: 'multiplicative' }),
  ] });
  return {
    format: 'live2d-cubism-drawable-capture',
    version: 1,
    name: 'Synthetic Cubism premultiplied blend parity fixture',
    source: { license: 'MIT', purpose: 'G11 normal/additive/multiplicative browser parity' },
    canvas: { width: 512, height: 512, pixelsPerUnit: 1, coordinateSystem: 'model-y-up', uvOrigin: 'top-left' },
    duration: 2,
    frameRate: 1,
    textures: [
      { id: 'blend-foreground', uri: 'samples/blend-parity-a.png', width: 64, height: 64 },
      { id: 'blend-background', uri: 'samples/blend-parity-b.png', width: 64, height: 64 },
    ],
    frames: [frame(0, 0, false), frame(1, 28, true), frame(2, 0, false)],
  };
}

function createBlendTexture(width, height, kind) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (kind === 'foreground') {
      pixels[offset] = 96 + Math.round(150 * x / (width - 1));
      pixels[offset + 1] = 40 + Math.round(120 * y / (height - 1));
      pixels[offset + 2] = 180 - Math.round(100 * x / (width - 1));
      pixels[offset + 3] = 48 + Math.round(190 * (x + y) / (width + height - 2));
    } else {
      // Continuous gradients avoid backend-specific one-pixel ownership at a
      // synthetic checker discontinuity while still exercising filtered alpha.
      pixels[offset] = 18 + Math.round(34 * x / (width - 1));
      pixels[offset + 1] = 42 + Math.round(52 * y / (height - 1));
      pixels[offset + 2] = 72 + Math.round(60 * (x + y) / (width + height - 2));
      pixels[offset + 3] = 80 + Math.round(175 * x / (width - 1));
    }
  }
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(scanlines, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
