/** Binary snapshots avoid lossy summaries and preserve every HDR/LDR component. */
export function encodeFrameGraphPixels(images) {
  const encode = values => {
    const bytes = new Uint8Array(Float32Array.from(values).buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { components: values.length, encoding: 'float32-le-base64', bytes: btoa(binary) };
  };
  return images.map(image => ({ key: image.key, hdr: encode(image.hdr), ldr: encode(image.ldr) }));
}

/** Full-resolution four-view snapshots exceed a single DevTools message. */
export async function captureFrameGraphPixels(cdp) {
  const evaluate = async expression => {
    const response = (await cdp.call('Runtime.evaluate', { expression, returnByValue: true })).result;
    if (response.exceptionDetails) throw Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  const deadline = Date.now() + 300000;
  let status;
  while (!(status = await evaluate("document.querySelector('#result')?.dataset.status"))) {
    if (Date.now() > deadline) throw Error('Timed out waiting for full-resolution pixel capture');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (status !== 'passed') return null;
  const manifest = await evaluate('globalThis.__framegraphPixels?.map(({key,hdr,ldr})=>({key,hdr:{components:hdr.components,encoding:hdr.encoding,length:hdr.bytes.length},ldr:{components:ldr.components,encoding:ldr.encoding,length:ldr.bytes.length}}))');
  if (!manifest?.length) throw Error('Missing full-resolution pixel manifest');
  const images = [];
  for (const [i, view] of manifest.entries()) {
    const image = { key: view.key };
    for (const channel of ['hdr', 'ldr']) {
      const metadata = view[channel], chunks = [];
      if (!Number.isSafeInteger(metadata.length) || metadata.length < 1 || metadata.length > 512 * 1024 * 1024) throw Error('Invalid pixel payload size');
      for (let offset = 0; offset < metadata.length; offset += 1024 * 1024) {
        const chunk = await evaluate(`globalThis.__framegraphPixels[${i}].${channel}.bytes.slice(${offset},${offset + 1024 * 1024})`);
        if (typeof chunk !== 'string' || chunk.length !== Math.min(1024 * 1024, metadata.length - offset)) throw Error('Pixel chunk missing');
        chunks.push(chunk);
      }
      image[channel] = { components: metadata.components, encoding: metadata.encoding, bytes: chunks.join('') };
    }
    images.push(image);
  }
  return images;
}
