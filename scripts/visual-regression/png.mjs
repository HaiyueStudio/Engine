import { inflateSync } from 'node:zlib';

export function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('screenshot is not PNG.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG decoder requires non-interlaced 8-bit data.');
      colorType = data[9];
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`);
  const packed = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  let packedOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[packedOffset++];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = packed[packedOffset++];
      const left = x >= channels ? rows[rowOffset + x - channels] : 0;
      const up = y > 0 ? rows[rowOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? rows[rowOffset - stride + x - channels] : 0;
      const value = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + up
        : filter === 3 ? raw + Math.floor((left + up) / 2) : filter === 4 ? raw + paeth(left, up, upperLeft) : Number.NaN;
      if (!Number.isFinite(value)) throw new Error(`Unsupported PNG filter ${filter}.`);
      rows[rowOffset + x] = value & 255;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const rgba = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < rows.length; source += 3, target += 4) {
    rgba[target] = rows[source];
    rgba[target + 1] = rows[source + 1];
    rgba[target + 2] = rows[source + 2];
    rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}

function paeth(a, b, c) {
  const estimate = a + b - c;
  const pa = Math.abs(estimate - a);
  const pb = Math.abs(estimate - b);
  const pc = Math.abs(estimate - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

