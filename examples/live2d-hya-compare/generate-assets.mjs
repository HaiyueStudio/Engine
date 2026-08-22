import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
]);
console.log(`Generated Live2D comparison samples: mascot ${hya.byteLength}/${converted.data.byteLength} bytes; mask parity ${maskHya.byteLength}/${maskConverted.data.byteLength} bytes.`);

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
