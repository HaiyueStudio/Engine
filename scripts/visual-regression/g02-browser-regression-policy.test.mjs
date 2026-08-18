import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  G02_EDITOR_FLOWS,
  G02_REPRESENTATIVE_CASES,
  G02_VERIFICATION_GATES,
  validateG02CandidateReport,
  verifyG02CandidateArtifacts,
} from './g02-browser-regression-policy.mjs';

const matrix = {
  browsers: [
    { id: 'chrome-macos', tier: 'extended' },
    { id: 'chrome-windows', tier: 'required' },
    { id: 'edge-windows', tier: 'required' },
    { id: 'safari-macos', tier: 'extended' },
  ],
  deviceClasses: [
    { id: 'windows-discrete', tier: 'required' },
    { id: 'android-vulkan', tier: 'extended' },
  ],
};
const releaseMatrix = JSON.parse(readFileSync(new URL('../../config/release-matrix.json', import.meta.url), 'utf8'));

test('first-release Windows browsers support Windows 10 22H2 and newer', () => {
  const browsers = releaseMatrix.browsers.filter(browser => browser.id.endsWith('-windows'));
  assert.deepEqual(browsers.map(browser => browser.id), ['chrome-windows', 'edge-windows']);
  assert.ok(browsers.every(browser => browser.tier === 'required'));
  assert.ok(browsers.every(browser => browser.os === 'Windows 10 22H2+'));
  assert.deepEqual(
    releaseMatrix.browsers.filter(browser => browser.tier === 'required').map(browser => browser.id),
    ['chrome-windows', 'edge-windows'],
  );
  assert.equal(releaseMatrix.browsers.find(browser => browser.id === 'chrome-macos')?.tier, 'extended');
});

test('first-release hardware matrix requires Windows discrete without integrated GPU handoffs', () => {
  const requiredDevices = releaseMatrix.deviceClasses
    .filter(device => device.tier === 'required')
    .map(device => device.id);
  assert.deepEqual(requiredDevices, ['windows-discrete']);
  assert.ok(!releaseMatrix.deviceClasses.some(device => device.id === 'apple-integrated'));
  assert.ok(!releaseMatrix.deviceClasses.some(device => device.id === 'windows-integrated'));
  assert.match(releaseMatrix.policy, /native hardware WebGPU/u);
});

test('G02 candidate policy accepts native browser evidence and explicit required-device handoffs', () => {
  assert.deepEqual(validateG02CandidateReport(candidate(), matrix), []);
});

test('G02 candidate policy rejects software WebGPU, hidden failures and handoffs in final mode', () => {
  const report = candidate();
  report.browserMatrix[0].angleBackend = 'swiftshader';
  report.browserMatrix[0].unclassifiedFailureCount = 1;
  report.browserMatrix[1].claimedPassed = true;
  const errors = validateG02CandidateReport(report, matrix, { requireAllDevices: true });
  assert.match(errors.join('\n'), /software backend/u);
  assert.match(errors.join('\n'), /unclassifiedFailureCount/u);
  assert.match(errors.join('\n'), /cannot be represented as passed/u);
  assert.match(errors.join('\n'), /still a device handoff/u);
});

test('G02 candidate policy requires every required device class independently of browser coverage', () => {
  const report = candidate();
  report.deviceMatrix.pop();
  const errors = validateG02CandidateReport(report, matrix);
  assert.match(errors.join('\n'), /required device ids mismatch/u);
});

test('G02 candidate policy rejects product evidence attributed to a browser without passed evidence', () => {
  const report = candidate();
  report.representativeCases[0].browserId = 'edge-windows';
  const errors = validateG02CandidateReport(report, matrix);
  assert.match(errors.join('\n'), /references browser without passed evidence/u);
});

test('G02 candidate policy requires exact product, editor and verification coverage without baseline writes', () => {
  const report = candidate();
  report.representativeCases.pop();
  report.editorE2E[0].transport = 'file';
  report.verification[0].status = 'skipped';
  report.formalBaselineUpdated = true;
  report.candidatePixelArtifacts.push('review/baselines/forbidden.png');
  const errors = validateG02CandidateReport(report, matrix);
  assert.match(errors.join('\n'), /representative case ids mismatch/u);
  assert.match(errors.join('\n'), /must use HTTP/u);
  assert.match(errors.join('\n'), /must be passed/u);
  assert.match(errors.join('\n'), /formalBaselineUpdated must be false/u);
  assert.match(errors.join('\n'), /formal baseline cannot be a candidate output/u);
});

test('G02 artifact checks can classify an explicit set of accepted platform outcomes', () => {
  const errors = verifyG02CandidateArtifacts(fileURLToPath(new URL('../..', import.meta.url)), {
    artifactChecks: [{
      path: 'package.json',
      assertions: [{ path: 'version', oneOf: ['0.1.0', '0.1.1'] }],
    }],
  });
  assert.deepEqual(errors, []);
});

function candidate() {
  const provenance = {
    sourcePath: 'fixture.html',
    byteLength: 10,
    sha256: 'a'.repeat(64),
  };
  const evidence = id => ({
    id,
    status: 'passed',
    browserId: 'chrome-windows',
    transport: 'http',
    replayCommand: `node verify-${id}.mjs`,
    provenance,
  });
  return {
    schemaVersion: 2,
    goal: 'g02-correctness-browser-regression',
    candidateState: 'required-device-handoff',
    formalBaselineUpdated: false,
    baseHead: '1'.repeat(40),
    browserMatrix: [
      {
        id: 'chrome-windows', status: 'passed', nativeWebGpu: true, angleBackend: 'd3d11',
        unclassifiedFailureCount: 0, gpuValidationErrorCount: 0, ownerResidualCount: 0,
        product: 'Chrome/140', os: 'Windows 10 22H2', adapter: 'NVIDIA GeForce', replayCommands: ['npm run check:slow'],
      },
      handoff('edge-windows'),
    ],
    deviceMatrix: [
      passedDevice('windows-discrete', ['chrome-windows']),
    ],
    representativeCases: G02_REPRESENTATIVE_CASES.map(evidence),
    editorE2E: G02_EDITOR_FLOWS.map(evidence),
    verification: G02_VERIFICATION_GATES.map(id => ({ id, status: 'passed', command: `npm run ${id}` })),
    aggregate: { unclassifiedFailureCount: 0, gpuValidationErrorCount: 0, ownerResidualCount: 0 },
    candidatePixelArtifacts: ['artifacts/render-regression/candidate.png'],
  };
}

function passedDevice(id, browserIds) {
  return {
    id,
    status: 'passed',
    nativeWebGpu: true,
    angleBackend: 'd3d11',
    unclassifiedFailureCount: 0,
    gpuValidationErrorCount: 0,
    ownerResidualCount: 0,
    product: 'Chrome/140',
    os: 'Windows 10 22H2',
    adapter: 'NVIDIA GeForce',
    browserIds,
    replayCommands: ['npm run check:slow'],
  };
}

function handoff(id) {
  return {
    id,
    status: 'device-handoff',
    owner: 'g07-rc-integration-go-no-go',
    reason: 'required-device-not-available-on-current-host',
    claimedPassed: false,
    replayCommands: ['node scripts/verify-m02-g02-candidate.mjs'],
  };
}
