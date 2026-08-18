export interface CubemapFaceDefinition {
  readonly layer: number;
  readonly axis: '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
  readonly name: string;
  readonly color: string;
}

export interface ProceduralCubemap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: number;
  readonly faces: readonly CubemapFaceDefinition[];
  destroy(): void;
}

export const CUBEMAP_FACES: readonly CubemapFaceDefinition[] = [
  { layer: 0, axis: '+X', name: 'Right', color: '#ef5350' },
  { layer: 1, axis: '-X', name: 'Left', color: '#26c6da' },
  { layer: 2, axis: '+Y', name: 'Top', color: '#66bb6a' },
  { layer: 3, axis: '-Y', name: 'Bottom', color: '#ffa726' },
  { layer: 4, axis: '+Z', name: 'Front', color: '#42a5f5' },
  { layer: 5, axis: '-Z', name: 'Back', color: '#ab47bc' },
];

export async function createProceduralCubemap(
  device: GPUDevice,
  size = 256,
): Promise<ProceduralCubemap> {
  if (!Number.isInteger(size) || size < 16 || size > 2_048) {
    throw new RangeError(`Cubemap face size must be an integer from 16 to 2048; received ${size}.`);
  }

  const texture = device.createTexture({
    label: 'CubemapExample.sixFaces',
    size: { width: size, height: size, depthOrArrayLayers: CUBEMAP_FACES.length },
    dimension: '2d',
    format: 'rgba8unorm-srgb',
    mipLevelCount: 1,
    usage: GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const bitmaps = await Promise.all(CUBEMAP_FACES.map(face => (
    createImageBitmap(drawFace(face, size))
  )));
  try {
    for (const face of CUBEMAP_FACES) {
      const bitmap = bitmaps[face.layer];
      if (!bitmap) throw new Error(`Missing generated cubemap bitmap for ${face.axis}.`);
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture, origin: { x: 0, y: 0, z: face.layer } },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
    }
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }

  return {
    texture,
    view: texture.createView({
      label: 'CubemapExample.cubeView',
      dimension: 'cube',
      baseArrayLayer: 0,
      arrayLayerCount: CUBEMAP_FACES.length,
    }),
    size,
    faces: CUBEMAP_FACES,
    destroy: () => texture.destroy(),
  };
}

function drawFace(face: CubemapFaceDefinition, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cubemap example requires a 2D canvas context to generate its faces.');

  // A cubemap is observed from inside its six faces. Pre-flip the diagnostic
  // artwork so axis labels remain readable in the skybox sampling direction.
  context.translate(size, 0);
  context.scale(-1, 1);

  context.fillStyle = face.color;
  context.fillRect(0, 0, size, size);
  const shade = context.createLinearGradient(0, 0, size, size);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.26)');
  shade.addColorStop(0.46, 'rgba(255, 255, 255, 0)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  context.fillStyle = shade;
  context.fillRect(0, 0, size, size);

  context.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  context.lineWidth = Math.max(1, size / 256);
  const gridSize = size / 8;
  for (let line = 1; line < 8; line++) {
    const offset = Math.round(line * gridSize) + 0.5;
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset, size);
    context.moveTo(0, offset);
    context.lineTo(size, offset);
    context.stroke();
  }

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'rgba(3, 9, 18, 0.82)';
  context.font = `800 ${Math.round(size * 0.31)}px ui-monospace, monospace`;
  context.fillText(face.axis, size * 0.505, size * 0.43 + 3);
  context.fillStyle = '#ffffff';
  context.fillText(face.axis, size * 0.5, size * 0.43);
  context.font = `700 ${Math.round(size * 0.075)}px ui-monospace, monospace`;
  context.letterSpacing = `${Math.max(1, size * 0.008)}px`;
  context.fillText(face.name.toUpperCase(), size * 0.5, size * 0.69);

  context.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  context.lineWidth = Math.max(2, size * 0.012);
  context.beginPath();
  context.moveTo(size * 0.28, size * 0.82);
  context.lineTo(size * 0.72, size * 0.82);
  context.lineTo(size * 0.65, size * 0.76);
  context.moveTo(size * 0.72, size * 0.82);
  context.lineTo(size * 0.65, size * 0.88);
  context.stroke();
  return canvas;
}
