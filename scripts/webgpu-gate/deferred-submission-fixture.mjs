import { DeferredImmutableBufferArena } from '../../artifacts/engine-0.2.1/g02/fixture.js';

/** Exercise actual write/submit ordering without awaiting between submissions. */
export async function verifyDeferredSubmissionOrdering(device) {
  const frames = 32;
  const arena = new DeferredImmutableBufferArena(device, 'DeferredSubmissionProbe.records', 16, GPUBufferUsage.COPY_SRC);
  const readback = device.createBuffer({ label: 'DeferredSubmissionProbe.readback', size: frames * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let first;
  try {
    for (let frame = 0; frame < frames; frame++) {
      const encoder = device.createCommandEncoder(), callbacks = [];
      const values = new Uint32Array([frame + 1, 101 + frame, 201 + frame, 301 + frame]);
      const binding = arena.acquire({}, new Uint8Array(values.buffer), {
        device, encoder, afterSubmit: callback => callbacks.push(callback),
      });
      first ??= binding;
      if (binding.buffer !== first.buffer || binding.offset !== first.offset) {
        throw new Error(`Submitted arena binding changed at frame ${frame}: ${binding.offset} vs ${first.offset}`);
      }
      encoder.copyBufferToBuffer(binding.buffer, binding.offset, readback, frame * 16, 16);
      device.queue.submit([encoder.finish()]);
      for (const callback of callbacks) callback(device.queue);
    }
    // Reuse must not permit premature destruction while submitted GPU work remains.
    arena.destroy();
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 4; channel++) {
      if (actual[frame * 4 + channel] !== frame + 1 + channel * 100) {
        throw new Error(`Submitted arena record overwritten: frame=${frame} channel=${channel}`);
      }
    }
    return { id: 'submitted-arena-ordering', frames, checkedWords: actual.length, stableBinding: true };
  } finally {
    arena.destroy();
    await device.queue.onSubmittedWorkDone();
    arena.abandon();
    readback.destroy();
  }
}
