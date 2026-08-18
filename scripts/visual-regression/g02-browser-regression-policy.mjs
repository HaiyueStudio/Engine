import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const G02_REPRESENTATIVE_CASES = Object.freeze([
  'pbr',
  'ambient-occlusion',
  'planar-reflection',
  'multi-light-shadow',
  'motion-blur',
  'clipping',
  'navigation',
  'gltf-animation3d',
  'spine',
  'hya-2d',
  'hya-3d',
  'complete-game',
]);

export const G02_EDITOR_FLOWS = Object.freeze([
  'create-import-save-reopen-export-play',
  'optional-capability-failure',
  'resource-replacement',
  'teardown',
]);

export const G02_VERIFICATION_GATES = Object.freeze([
  'targeted-policy',
  'check-fast',
  'slow-smoke',
  'slow-full',
  'animation-editor-browser',
  'voxel-editor-browser',
  'editor-release-lifecycle-browser',
]);

export function validateG02CandidateReport(report, releaseMatrix, options = {}) {
  const errors = [];
  check(report?.schemaVersion === 2, 'schemaVersion must be 2', errors);
  check(report?.goal === 'g02-correctness-browser-regression', 'goal must identify G02', errors);
  check(
    ['required-device-handoff', 'all-required-evidence-passed'].includes(report?.candidateState),
    'candidateState must describe the required evidence state',
    errors,
  );
  check(report?.formalBaselineUpdated === false, 'formalBaselineUpdated must be false', errors);
  check(/^[0-9a-f]{40}$/u.test(report?.baseHead ?? ''), 'baseHead must be a full Git commit', errors);

  const requiredBrowsers = (releaseMatrix?.browsers ?? [])
    .filter(browser => browser.tier === 'required')
    .map(browser => browser.id);
  const browserEntries = report?.browserMatrix ?? [];
  checkSet(browserEntries.map(entry => entry.id), requiredBrowsers, 'required browser ids', errors);
  for (const browser of browserEntries) {
    validateMatrixEvidence(browser, `browser ${browser.id}`, options, errors);
  }

  const requiredDevices = (releaseMatrix?.deviceClasses ?? [])
    .filter(device => device.tier === 'required')
    .map(device => device.id);
  const deviceEntries = report?.deviceMatrix ?? [];
  checkSet(deviceEntries.map(entry => entry.id), requiredDevices, 'required device ids', errors);
  for (const device of deviceEntries) {
    validateMatrixEvidence(device, `device ${device.id}`, options, errors);
    if (device.status === 'passed') {
      check(
        Array.isArray(device.browserIds) && device.browserIds.length > 0,
        `device ${device.id} must identify verified browsers`,
        errors,
      );
      for (const browserId of device.browserIds ?? []) {
        check(
          browserEntries.some(entry => entry.id === browserId && entry.status === 'passed'),
          `device ${device.id} references browser without passed evidence: ${browserId}`,
          errors,
        );
      }
    }
  }

  const hasHandoff = [...browserEntries, ...deviceEntries].some(entry => entry.status === 'device-handoff');
  check(
    report?.candidateState === (hasHandoff ? 'required-device-handoff' : 'all-required-evidence-passed'),
    'candidateState does not match browser/device evidence',
    errors,
  );

  const representative = report?.representativeCases ?? [];
  checkSet(representative.map(entry => entry.id), G02_REPRESENTATIVE_CASES, 'representative case ids', errors);
  for (const entry of representative) {
    validatePassedEvidence(entry, `representative case ${entry.id}`, errors);
    check(
      browserEntries.some(browser => browser.id === entry.browserId && browser.status === 'passed'),
      `representative case ${entry.id} references browser without passed evidence: ${entry.browserId}`,
      errors,
    );
  }

  const editorFlows = report?.editorE2E ?? [];
  checkSet(editorFlows.map(entry => entry.id), G02_EDITOR_FLOWS, 'editor E2E flow ids', errors);
  for (const entry of editorFlows) {
    validatePassedEvidence(entry, `editor E2E ${entry.id}`, errors);
    check(
      browserEntries.some(browser => browser.id === entry.browserId && browser.status === 'passed'),
      `editor E2E ${entry.id} references browser without passed evidence: ${entry.browserId}`,
      errors,
    );
  }

  const verification = report?.verification ?? [];
  checkSet(verification.map(entry => entry.id), G02_VERIFICATION_GATES, 'verification gate ids', errors);
  for (const entry of verification) {
    check(entry.status === 'passed', `verification ${entry.id} must be passed`, errors);
    check(typeof entry.command === 'string' && entry.command.length > 0, `verification ${entry.id} needs a command`, errors);
  }

  check(report?.aggregate?.unclassifiedFailureCount === 0, 'aggregate unclassifiedFailureCount must be 0', errors);
  check(report?.aggregate?.gpuValidationErrorCount === 0, 'aggregate gpuValidationErrorCount must be 0', errors);
  check(report?.aggregate?.ownerResidualCount === 0, 'aggregate ownerResidualCount must be 0', errors);
  check(Array.isArray(report?.candidatePixelArtifacts), 'candidatePixelArtifacts must be an array', errors);
  for (const path of report?.candidatePixelArtifacts ?? []) {
    check(/^artifacts\//u.test(path), `candidate pixel output must remain under artifacts/: ${path}`, errors);
    check(!/^review\/baselines\//u.test(path), `formal baseline cannot be a candidate output: ${path}`, errors);
  }
  return errors;
}

export function verifyG02CandidateProvenance(root, report) {
  const errors = [];
  const entries = [
    ...(report?.representativeCases ?? []),
    ...(report?.editorE2E ?? []),
  ];
  for (const entry of entries) {
    const provenance = entry.provenance;
    if (!provenance?.sourcePath) continue;
    const absolute = resolve(root, provenance.sourcePath);
    if (!existsSync(absolute)) {
      errors.push(`${entry.id} provenance file is missing: ${provenance.sourcePath}`);
      continue;
    }
    const contents = readFileSync(absolute);
    const hash = createHash('sha256').update(contents).digest('hex');
    if (contents.byteLength !== provenance.byteLength) {
      errors.push(`${entry.id} provenance bytes changed: ${contents.byteLength} !== ${provenance.byteLength}`);
    }
    if (hash !== provenance.sha256) errors.push(`${entry.id} provenance hash changed: ${hash} !== ${provenance.sha256}`);
  }
  return errors;
}

export function verifyG02CandidateArtifacts(root, report) {
  const errors = [];
  for (const definition of report?.artifactChecks ?? []) {
    const absolute = resolve(root, definition.path ?? '');
    if (!existsSync(absolute)) {
      errors.push(`candidate artifact is missing: ${definition.path}`);
      continue;
    }
    let value;
    try {
      value = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      errors.push(`candidate artifact is not valid JSON: ${definition.path} (${error.message})`);
      continue;
    }
    for (const assertion of definition.assertions ?? []) {
      const actual = readPath(value, assertion.path);
      if (Array.isArray(assertion.oneOf)) {
        if (!assertion.oneOf.some(expected => Object.is(actual, expected))) {
          errors.push(`${definition.path}#${assertion.path}: expected one of ${JSON.stringify(assertion.oneOf)}, received ${JSON.stringify(actual)}`);
        }
      } else if (!Object.is(actual, assertion.equals)) {
        errors.push(`${definition.path}#${assertion.path}: expected ${JSON.stringify(assertion.equals)}, received ${JSON.stringify(actual)}`);
      }
    }
  }
  return errors;
}

function validatePassedEvidence(entry, label, errors) {
  check(entry.status === 'passed', `${label} must be passed`, errors);
  check(typeof entry.browserId === 'string' && entry.browserId.length > 0, `${label} must name the verified browser`, errors);
  check(entry.transport === 'http', `${label} must use HTTP`, errors);
  check(typeof entry.replayCommand === 'string' && entry.replayCommand.length > 0, `${label} needs a replay command`, errors);
  check(typeof entry.provenance?.sourcePath === 'string' && entry.provenance.sourcePath.length > 0, `${label} needs source provenance`, errors);
  check(Number.isInteger(entry.provenance?.byteLength) && entry.provenance.byteLength > 0, `${label} needs source byte length`, errors);
  check(/^[0-9a-f]{64}$/u.test(entry.provenance?.sha256 ?? ''), `${label} needs source SHA-256`, errors);
}

function validateMatrixEvidence(entry, label, options, errors) {
  if (entry.status === 'passed') {
    check(entry.nativeWebGpu === true, `${label} must use native WebGPU`, errors);
    check(!/swiftshader|software|warp|llvmpipe/iu.test(entry.angleBackend ?? ''), `${label} cannot use a software backend`, errors);
    check(entry.unclassifiedFailureCount === 0, `${label} unclassifiedFailureCount must be 0`, errors);
    check(entry.gpuValidationErrorCount === 0, `${label} gpuValidationErrorCount must be 0`, errors);
    check(entry.ownerResidualCount === 0, `${label} ownerResidualCount must be 0`, errors);
    check(typeof entry.product === 'string' && entry.product.length > 0, `${label} must record product identity`, errors);
    check(typeof entry.os === 'string' && entry.os.length > 0, `${label} must record OS identity`, errors);
    check(typeof entry.adapter === 'string' && entry.adapter.length > 0, `${label} must record adapter identity`, errors);
    check(Array.isArray(entry.replayCommands) && entry.replayCommands.length > 0, `${label} needs replay commands`, errors);
  } else if (entry.status === 'device-handoff') {
    check(!options.requireAllDevices, `${label} is still a device handoff`, errors);
    check(entry.owner === 'g07-rc-integration-go-no-go', `${label} handoff owner must be G07`, errors);
    check(entry.reason === 'required-device-not-available-on-current-host', `${label} needs the explicit device-unavailable reason`, errors);
    check(Array.isArray(entry.replayCommands) && entry.replayCommands.length > 0, `${label} handoff needs replay commands`, errors);
    check(entry.claimedPassed !== true, `${label} handoff cannot be represented as passed`, errors);
  } else {
    errors.push(`${label} has unsupported status ${entry.status ?? 'missing'}`);
  }
}

function readPath(value, path) {
  return String(path).split('.').reduce((current, key) => current?.[key], value);
}

function checkSet(actual, expected, label, errors) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  check(JSON.stringify(sortedActual) === JSON.stringify(sortedExpected), `${label} mismatch: ${sortedActual.join(', ')}`, errors);
}

function check(condition, message, errors) {
  if (!condition) errors.push(message);
}
