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
await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(resolve(outputRoot, 'mascot.hya'), new Uint8Array(hya)),
  writeFile(resolve(outputRoot, 'mascot.hydm'), new Uint8Array(converted.data)),
  copyFile(resolve(sourceRoot, 'mascot.png'), resolve(outputRoot, 'mascot.png')),
  copyFile(resolve(sourceRoot, 'mascot.capture.json'), resolve(outputRoot, 'mascot.capture.json')),
]);
console.log(`Generated Live2D comparison sample: ${hya.byteLength} HYA bytes + ${converted.data.byteLength} HYDM bytes.`);
