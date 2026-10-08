import { G05_ROOM_WORKLOADS } from './deferred-g05-cohort-policy.mjs';
import { G05_ROOM_CASES } from './deferred-g05-policy.mjs';

export function createFrameGraphParityPlan(qualification) {
  const cases = [...G05_ROOM_WORKLOADS.map(c => ({ ...c, fixture: 'room', ao: 'off' })),
    { caseId: '1080p-128', moving: true, fixture: 'cost', ao: 'gtao' }];
  return qualification.targets.flatMap(target => cases.flatMap(c => ['reference', 'tiled'].flatMap(algorithm =>
    ['A0', 'B4'].map(variant => ({ ...target, ...c, algorithm, variant })))));
}

export function compareFrameGraphRoomPixels(a, b, job) {
  const c = G05_ROOM_CASES[job.caseId];
  if (!c || a?.length !== c.views || b?.length !== c.views) throw Error('Incomplete paired view population');
  const decode = image => {
    if (image?.encoding !== 'float32-le-base64' || image.components !== c.width * c.height * 4) throw Error('Invalid paired image identity');
    const bytes = Buffer.from(image.bytes, 'base64');
    if (bytes.length !== image.components * 4 || bytes.toString('base64') !== image.bytes) throw Error('Truncated/noncanonical paired image');
    return new Float32Array(bytes.buffer, bytes.byteOffset, image.components);
  };
  return a.map((before, i) => {
    const after = b[i];
    if (before.key !== after.key) throw Error('Paired view identity changed');
    const row = { key: before.key, componentsPerChannel: c.width * c.height * 4, hdrMaxToleranceRatio: 0, ldrMaxDelta: 0, failures: 0 };
    for (const channel of ['hdr', 'ldr']) {
      const x = decode(before[channel]), y = decode(after[channel]);
      for (let k = 0; k < x.length; k++) {
        if (!Number.isFinite(x[k]) || !Number.isFinite(y[k])) throw Error('Nonfinite paired pixel');
        const delta = Math.abs(x[k] - y[k]);
        if (channel === 'hdr') {
          const ratio = delta / Math.max(.002, Math.abs(x[k]) * .002);
          row.hdrMaxToleranceRatio = Math.max(row.hdrMaxToleranceRatio, ratio);
          if (ratio > 1) row.failures++;
        } else { row.ldrMaxDelta = Math.max(row.ldrMaxDelta, delta); if (delta > 1 / 255 + 1e-7) row.failures++; }
      }
    }
    return { ...row, status: row.failures === 0 ? 'passed' : 'failed' };
  });
}
