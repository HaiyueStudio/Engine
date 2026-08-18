export async function captureVisualSanity(canvas, clearColor) {
  const width = 64;
  const height = 36;
  const probe = document.createElement('canvas');
  probe.width = width;
  probe.height = height;
  const context = probe.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const clear = clearColor.slice(0, 3).map(value => Math.round(value * 255));
  let nonBackground = 0;
  let lumaTotal = 0;
  let opaque = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const delta = Math.abs(pixels[offset] - clear[0]) + Math.abs(pixels[offset + 1] - clear[1]) + Math.abs(pixels[offset + 2] - clear[2]);
    if (delta > 30) nonBackground++;
    lumaTotal += pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    if (pixels[offset + 3] > 240) opaque++;
  }
  const pixelCount = width * height;
  const nonBackgroundRatio = nonBackground / pixelCount;
  const meanLuma = lumaTotal / pixelCount;
  const opaqueRatio = opaque / pixelCount;
  const failures = [];
  if (nonBackgroundRatio < 0.08) failures.push('render is blank or indistinguishable from the clear color');
  if (meanLuma < 5 || meanLuma > 250) failures.push(`mean luma ${meanLuma.toFixed(2)} is implausible`);
  if (opaqueRatio < 0.98) failures.push(`opaque ratio ${opaqueRatio.toFixed(3)} is too low`);
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    sampleWidth: width,
    sampleHeight: height,
    nonBackgroundRatio,
    meanLuma,
    opaqueRatio,
  };
}

