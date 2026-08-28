import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRiveG11EvidenceIndex } from './rive-g11-evidence-index-builder.mjs';

const REVISION = 'a'.repeat(40);
const MANIFEST_HASH = 'b'.repeat(64);
const WORKLOAD_HASH = 'c'.repeat(64);
const manifest = {
  formalAssets: [
    { id: 'asset-a', riv: { sha256: '1'.repeat(64) } },
    { id: 'asset-b', riv: { sha256: '2'.repeat(64) } },
  ],
};
const workloadPlan = {
  browserDeviceMatrix: [
    { deviceClass: 'windows-10-plus-device-a', browsers: ['chrome', 'edge'] },
    { deviceClass: 'windows-10-plus-device-b', browsers: ['chrome', 'edge'] },
  ],
};

test('partial trace population remains collecting and does not claim a complete browser run', () => {
  const entry = traceEntry('asset-a', 'windows-10-plus-device-a', 'chrome');
  const built = buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: [entry], manifest, workloadPlan });
  assert.equal(built.index.status, 'collecting');
  assert.equal(built.index.traceArtifacts.length, 1);
  assert.equal(built.index.performance.assets.length, 1);
  assert.equal(built.index.devices.length, 0);
  assert.equal(built.generatedArtifactBytesByPath.size, 0);
});

test('a complete device produces immutable aggregate evidence only after both browsers cover every asset', () => {
  const entries = manifest.formalAssets.flatMap(asset => ['chrome', 'edge'].map(browser => traceEntry(asset.id, 'windows-10-plus-device-a', browser)));
  const built = buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: entries, manifest, workloadPlan });
  assert.equal(built.index.status, 'collecting');
  assert.equal(built.index.devices.length, 1);
  assert.deepEqual(built.index.devices[0].browsers.map(value => value.browser), ['chrome', 'edge']);
  assert.equal(built.generatedArtifactBytesByPath.size, 2);
  for (const browser of built.index.devices[0].browsers) {
    const report = JSON.parse(built.generatedArtifactBytesByPath.get(browser.evidence.path));
    assert.equal(report.fullWorkload, true);
    assert.equal(report.traceArtifacts.length, 2);
  }
});

test('the full matrix and passing closure deterministically complete the evidence index', () => {
  const entries = manifest.formalAssets.flatMap(asset => workloadPlan.browserDeviceMatrix.flatMap(device => (
    device.browsers.map(browser => traceEntry(asset.id, device.deviceClass, browser))
  )));
  const closureBytes = Buffer.from('closure');
  const closureEntry = {
    reference: { path: 'review/candidates/closure.json', sha256: 'd'.repeat(64), byteLength: closureBytes.byteLength },
    report: {
      schemaVersion: 1, kind: 'haiyue-rive-browser-closure-scan', status: 'passed', formalEvidence: true,
      generatedAt: '2026-08-27T00:00:00.000Z', engineRevision: REVISION, engineDirty: false,
      evidenceClass: 'clean-revision-candidate', nodeVersion: 'v24.19.0', denyListSha256: '9'.repeat(64),
      officialOracleBuildTimeOnly: true, unclassifiedFailureCount: 0,
      scans: ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'].map(name => ({
        name, status: 'passed', sha256: '8'.repeat(64), forbiddenPackageCount: 0, forbiddenFileCount: 0,
        forbiddenStaticPatternCount: 0, forbiddenNetworkCount: 0, rawRivCount: 0,
      })),
    },
  };
  const first = buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: entries, closureEntry, manifest, workloadPlan });
  const second = buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: [...entries].reverse(), closureEntry, manifest, workloadPlan });
  assert.equal(first.index.status, 'complete');
  assert.equal(first.index.performance.fullWorkload, true);
  assert.equal(first.index.traceArtifacts.length, 8);
  assert.equal(first.index.devices.length, 2);
  assert.equal(first.generatedArtifactBytesByPath.size, 4);
  assert.deepEqual(first, second);
});

test('conflicting revision and device identity cannot be merged', () => {
  const first = traceEntry('asset-a', 'windows-10-plus-device-a', 'chrome');
  const revisionConflict = traceEntry('asset-b', 'windows-10-plus-device-a', 'chrome');
  revisionConflict.trace.engineRevision = 'e'.repeat(40);
  assert.throws(
    () => buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: [first, revisionConflict], manifest, workloadPlan }),
    /conflicting formal identity/u,
  );
  const machineConflict = traceEntry('asset-b', 'windows-10-plus-device-a', 'chrome');
  machineConflict.trace.environment.machineIdSha256 = 'f'.repeat(64);
  assert.throws(
    () => buildRiveG11EvidenceIndex({ baseIndex: emptyIndex(), traceEntries: [first, machineConflict], manifest, workloadPlan }),
    /Device identity changed/u,
  );
});

function emptyIndex() {
  return {
    schemaVersion: 1, kind: 'haiyue-rive-g11-evidence-index', status: 'collecting', tupleId: 'rive-7.3-webgl2-2.40.0',
    engineRevision: null, corpusManifestSha256: null, workloadPlanSha256: null, traceArtifacts: [], devices: [],
    performance: { fullWorkload: false, assets: [] },
    browserClosure: {
      officialOracleBuildTimeOnly: true, unclassifiedFailureCount: 0,
      scans: ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'].map(name => ({ name, status: 'not-run', reason: 'fixture' })),
    },
    formalRunAttempts: [],
  };
}

function traceEntry(assetId, deviceClass, browser) {
  const asset = manifest.formalAssets.find(value => value.id === assetId);
  const suffix = `${assetId}-${deviceClass}-${browser}`;
  const reference = { path: `review/candidates/${suffix}.json`, sha256: hashSuffix(suffix), byteLength: 10 };
  return {
    validationStatus: 'passed', reference,
    trace: {
      status: 'passed', evidenceClass: 'clean-device-candidate', engineDirty: false,
      engineRevision: REVISION, corpusManifestSha256: MANIFEST_HASH, workloadPlanSha256: WORKLOAD_HASH,
      assetId, rivSha256: asset.riv.sha256,
      environment: {
        deviceClass, browser, browserVersion: '151.0.0.0', os: 'Windows 11', gpu: `${deviceClass}-gpu`,
        physicalDevice: true, machineIdSha256: deviceClass.endsWith('-a') ? '3'.repeat(64) : '4'.repeat(64),
        nativeBackend: true, officialBackend: 'webgl2', hyaBackend: 'webgpu',
        browserLogCaptured: true, consoleErrorCount: 0, exceptionCount: 0,
      },
      official: { metrics: { rawBytes: 1 }, measurement: { warmupIterations: 5 } },
      hya: { metrics: { rawBytes: 1 }, measurement: { warmupIterations: 5 } },
      comparison: { unclassifiedFailureCount: 0, sameMachine: true, sameRevision: true, sameActionStream: true },
    },
  };
}

function hashSuffix(value) { return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64); }
