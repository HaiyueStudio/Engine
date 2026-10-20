import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFrameGraphQualification } from './framegraph-qualification-policy.mjs';
import { createFrameGraphParityPlan, compareFrameGraphRoomPixels } from './framegraph-parity-policy.mjs';
import { captureFrameGraphPixels } from './framegraph-pixel-oracle.mjs';
const qualification = createFrameGraphQualification(JSON.parse(readFileSync(new URL('../../config/release-matrix.json', import.meta.url))), 'win32');
test('large pixel transfers are bounded and truncation fails instead of silently losing views', async () => {
  const payload = 'A'.repeat(1024 * 1024 + 16), expressions = [];
  const cdp = { async call(method, { expression }) {
    expressions.push(expression); let value;
    if (expression.includes('dataset.status')) value = 'passed';
    else if (expression.includes('?.map')) value = [{ key: 'v0', hdr: { components: 1, encoding: 'float32-le-base64', length: payload.length }, ldr: { components: 1, encoding: 'float32-le-base64', length: payload.length } }];
    else { const [from, to] = expression.match(/slice\((\d+),(\d+)\)/).slice(1).map(Number); assert.ok(to - from <= 1024 * 1024); value = payload.slice(from, to); }
    return { result: { result: { value } } };
  } };
  const images = await captureFrameGraphPixels(cdp);
  assert.equal(images[0].ldr.bytes, payload); assert.equal(expressions.filter(e => e.includes('.slice')).length, 4);
  const broken = { async call(method, args) { const r = await cdp.call(method, args); if (args.expression.includes('.slice')) r.result.result.value = ''; return r; } };
  await assert.rejects(() => captureFrameGraphPixels(broken), /chunk missing/);
});
test('preflight preserves every E/G static/dynamic workload, stress and GTAO on both browsers', () => {
  const plan = createFrameGraphParityPlan(qualification);
  assert.equal(plan.length, 112);
  for (const browserId of ['chrome-windows', 'edge-windows']) {
    const jobs = plan.filter(j => j.browserId === browserId);
    assert.equal(jobs.length, 56);
    for (const caseId of ['stress-512', 'stress-1024', 'dynamic-128-four-view']) assert.equal(jobs.filter(j => j.caseId === caseId).length, 4);
    assert.equal(jobs.filter(j => j.ao === 'gtao').length, 4);
  }
  for (let i = 0; i < plan.length; i += 2) assert.deepEqual({ ...plan[i], variant: 'B4' }, plan[i + 1]);
});
test('paired image check rejects truncation, nonfinite values and a changed final pixel', () => {
  const components = 1280 * 720 * 4, bytes = Buffer.alloc(components * 4);
  const channel = { components, encoding: 'float32-le-base64', bytes: bytes.toString('base64') };
  const images = [{ key: 'real-frame-view:0', hdr: channel, ldr: channel }], job = { caseId: 'small-8' };
  assert.equal(compareFrameGraphRoomPixels(images, images, job)[0].status, 'passed');
  bytes.writeFloatLE(.1, bytes.length - 4);
  const changed = [{ ...images[0], ldr: { ...channel, bytes: bytes.toString('base64') } }];
  assert.equal(compareFrameGraphRoomPixels(images, changed, job)[0].status, 'failed');
  bytes.writeFloatLE(NaN, bytes.length - 4); changed[0].ldr.bytes = bytes.toString('base64');
  assert.throws(() => compareFrameGraphRoomPixels(images, changed, job));
  assert.throws(() => compareFrameGraphRoomPixels(images, [], job));
  changed[0].ldr.bytes = 'AA=='; assert.throws(() => compareFrameGraphRoomPixels(images, changed, job));
});
