export const PANORAMA_WIDTH = 1024;
export const PANORAMA_HEIGHT = 512;

/** Creates a seam-safe, directional panorama so cubemap orientation is easy to inspect. */
export function createReflectionPanorama(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PANORAMA_WIDTH;
  canvas.height = PANORAMA_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The equirectangular example requires a 2D canvas context.');

  const sky = context.createLinearGradient(0, 0, 0, PANORAMA_HEIGHT);
  sky.addColorStop(0, '#142f68');
  sky.addColorStop(0.42, '#2d7ca2');
  sky.addColorStop(0.505, '#e99a62');
  sky.addColorStop(0.54, '#392a34');
  sky.addColorStop(1, '#08080e');
  context.fillStyle = sky;
  context.fillRect(0, 0, PANORAMA_WIDTH, PANORAMA_HEIGHT);

  addGlow(context, 0.22, 0.34, 0.23, ['rgba(255, 100, 36, .82)', 'rgba(255, 74, 24, 0)']);
  addGlow(context, 0.75, 0.41, 0.26, ['rgba(39, 138, 255, .72)', 'rgba(26, 73, 255, 0)']);
  addGlow(context, 0.43, 0.2, 0.075, ['rgba(255, 252, 222, 1)', 'rgba(255, 210, 93, 0)']);

  const horizonY = PANORAMA_HEIGHT * 0.51;
  context.fillStyle = 'rgba(255, 225, 188, .42)';
  context.fillRect(0, horizonY - 1, PANORAMA_WIDTH, 2);
  drawLightBank(context, PANORAMA_WIDTH * 0.08, horizonY, '#ff6d34');
  drawLightBank(context, PANORAMA_WIDTH * 0.31, horizonY, '#ffd578');
  drawLightBank(context, PANORAMA_WIDTH * 0.59, horizonY, '#63efff');
  drawLightBank(context, PANORAMA_WIDTH * 0.84, horizonY, '#7775ff');

  context.save();
  context.fillStyle = 'rgba(232, 244, 255, .7)';
  context.font = '600 24px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'center';
  context.fillText('+X', PANORAMA_WIDTH * 0.5, PANORAMA_HEIGHT * 0.13);
  context.fillText('+Z', PANORAMA_WIDTH * 0.75, PANORAMA_HEIGHT * 0.13);
  context.fillText('-X / seam', 8, PANORAMA_HEIGHT * 0.13);
  context.textAlign = 'left';
  context.restore();
  return canvas;
}

function addGlow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  colors: readonly [string, string],
): void {
  const centerX = x * PANORAMA_WIDTH;
  const centerY = y * PANORAMA_HEIGHT;
  const gradient = context.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    radius * PANORAMA_WIDTH,
  );
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, PANORAMA_WIDTH, PANORAMA_HEIGHT);
}

function drawLightBank(
  context: CanvasRenderingContext2D,
  centerX: number,
  horizonY: number,
  color: string,
): void {
  context.save();
  context.shadowColor = color;
  context.shadowBlur = 28;
  context.fillStyle = color;
  for (let index = -2; index <= 2; index++) {
    const height = 18 + (2 - Math.abs(index)) * 9;
    context.fillRect(centerX + index * 19 - 5, horizonY - height, 10, height);
  }
  context.restore();
}
