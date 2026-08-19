import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { encodeAnimationBinary } from '../../animation-spec/dist/index.js';
import { convertCubismCaptureToHya } from '../../animation-spec/dist/live2d.js';
import { createDeformableMesh2DFormatRegistry } from '../../animation-spec/dist/deformable2d.js';

const root = dirname(fileURLToPath(import.meta.url));
const assets = resolve(root, 'assets');
const capture = createCaptureFixture();
const converted = convertCubismCaptureToHya(capture, { dataUri: 'assets/mascot.hydm', strict: true });
const binary = encodeAnimationBinary(converted.document, { extensions: createDeformableMesh2DFormatRegistry() });

await mkdir(assets, { recursive: true });
await Promise.all([
  writeFile(resolve(assets, 'mascot.capture.json'), `${JSON.stringify(capture, null, 2)}\n`),
  writeFile(resolve(assets, 'mascot.hya'), new Uint8Array(binary)),
  writeFile(resolve(assets, 'mascot.hydm'), new Uint8Array(converted.data)),
  writeFile(resolve(assets, 'mascot.png'), createMascotPng(512, 512)),
  writeFile(resolve(assets, 'conversion-report.json'), `${JSON.stringify({ ...converted.report, diagnostics: converted.diagnostics }, null, 2)}\n`),
]);
console.log(`Generated ${converted.report.frameCount} frames, ${converted.report.vertexCount} vertices and ${binary.byteLength + converted.data.byteLength} binary bytes.`);

function createCaptureFixture() {
  const columns = 12;
  const rows = 12;
  const width = 360;
  const height = 360;
  const uvs = [];
  const base = [];
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const u = column / columns;
      const v = row / rows;
      uvs.push(u, v);
      base.push((u - 0.5) * width, (0.5 - v) * height);
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const frameRate = 12;
  const duration = 2;
  const frames = [];
  for (let frame = 0; frame <= frameRate * duration; frame++) {
    const time = frame / frameRate;
    const phase = time / duration * Math.PI * 2;
    const positions = [];
    for (let vertex = 0; vertex < base.length; vertex += 2) {
      const x = base[vertex];
      const y = base[vertex + 1];
      const horizontal = x / (width / 2);
      const vertical = y / (height / 2);
      const breathe = 1 + Math.sin(phase) * 0.025;
      positions.push(x + Math.sin(phase + vertical * 1.8) * (11 + 5 * (1 - Math.abs(horizontal))), y * breathe + Math.cos(phase * 2 + horizontal * 1.4) * 4 * (1 - Math.abs(vertical)));
    }
    frames.push({ time, drawables: [{
      id: 'ArtMesh_Mascot', textureIndex: 0, renderOrder: 0, opacity: 1, blendMode: 'normal', culling: false, masks: [], positions, uvs, indices,
      multiplyColor: [1, 1, 1, 1], screenColor: [0, 0, 0, 0],
    }] });
  }
  return {
    format: 'live2d-cubism-drawable-capture', version: 1, name: 'HaiYue Mascot Cubism Capture Fixture',
    source: { kind: 'deterministic-test-fixture', notice: 'HaiYue-owned fixture exercising the same capture contract as the user-supplied Cubism Core adapter.' },
    canvas: { width: 512, height: 512, pixelsPerUnit: 1, coordinateSystem: 'model-y-up' },
    duration, frameRate,
    textures: [{ id: 'mascot-texture', uri: 'assets/mascot.png', width: 512, height: 512 }],
    frames,
  };
}

function createMascotPng(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  const ellipse = (cx, cy, rx, ry, color) => {
    const left = Math.max(0, Math.floor(cx - rx));
    const right = Math.min(width - 1, Math.ceil(cx + rx));
    const top = Math.max(0, Math.floor(cy - ry));
    const bottom = Math.min(height - 1, Math.ceil(cy + ry));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) setPixel(x, y, color);
    }
  };
  const setPixel = (x, y, [red, green, blue, alpha = 255]) => {
    const offset = (y * width + x) * 4;
    pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue; pixels[offset + 3] = alpha;
  };
  ellipse(256, 270, 190, 214, [33, 27, 58]);
  ellipse(256, 276, 151, 171, [244, 200, 164]);
  ellipse(256, 132, 165, 103, [48, 38, 78]);
  ellipse(194, 274, 46, 31, [250, 253, 255]); ellipse(318, 274, 46, 31, [250, 253, 255]);
  ellipse(196, 276, 18, 25, [52, 66, 104]); ellipse(316, 276, 18, 25, [52, 66, 104]);
  ellipse(202, 267, 6, 7, [185, 244, 255]); ellipse(322, 267, 6, 7, [185, 244, 255]);
  ellipse(256, 349, 43, 12, [181, 87, 103]); ellipse(256, 342, 43, 10, [244, 200, 164]);
  ellipse(91, 176, 27, 46, [113, 232, 220]); ellipse(421, 176, 27, 46, [113, 232, 220]);
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(scanlines, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
