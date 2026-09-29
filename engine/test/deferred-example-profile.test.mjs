import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { createDeferredLightingProfile } = await importEngineSource('experimental/DeferredLightingProfile.ts');
const { getDeferredLightingBackend } = await importEngineSource('renderer/DeferredLightingBackendPort.ts');
const { Render3DSystem } = await importEngineSource('systems/Render3DSystem.ts');
function setup() { const device = createAuditGpuDevice({ limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32, maxStorageBuffersPerShaderStage: 8, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupStorageSize: 16384, maxComputeWorkgroupsPerDimension: 65535 } }); const engine = { device, format: 'rgba16float', width: 32, height: 32, defaults: {}, getDepthFormat: () => 'depth24plus' }; return { engine, system: new Render3DSystem(engine) }; }
test('experimental facade rejects unsupported modes and already-aborted setup', async () => {
  const { engine, system } = setup();
  await assert.rejects(createDeferredLightingProfile(system, engine, { mode: 'invalid' }), RangeError);
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(createDeferredLightingProfile(system, engine, { signal: abort.signal }), /cancelled/);
  assert.equal(getDeferredLightingBackend(system), undefined); system.destroy();
});
test('superseded handles cannot dispose the new profile or expose its readbacks', async () => {
  const { engine, system } = setup();
  const first = await createDeferredLightingProfile(system, engine, { mode: 'reference' });
  const second = await createDeferredLightingProfile(system, engine, { mode: 'tiled' });
  first.dispose(); assert.equal(first.snapshot().active, false); assert.equal(second.snapshot().active, true);
  assert.equal(await first.readDebug('tiles'), null);
  const snapshot = second.snapshot(); assert.equal(snapshot.completeCoverage, false);
  assert.equal('backend' in snapshot, false); assert.equal('binding' in snapshot, false);
  second.dispose(); second.dispose(); assert.equal(getDeferredLightingBackend(system), undefined); system.destroy();
});
