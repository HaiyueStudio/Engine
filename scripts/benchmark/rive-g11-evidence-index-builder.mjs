import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveOracleTrace } from '../hya-corpus/rive-oracle-trace-contract.mjs';
import { validateRiveBrowserClosureReport } from './rive-browser-closure-scan.mjs';
import { validateRiveG11EvidenceIndex } from './rive-g11-evidence-index-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLOSURE_SCANS = Object.freeze(['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests']);

export function buildRiveG11EvidenceIndex({
  baseIndex,
  traceEntries,
  closureEntry = null,
  manifest,
  workloadPlan,
  deviceBrowserArtifactDirectory = 'review/candidates/rive-g11-evidence/device-browser',
}) {
  const output = structuredClone(baseIndex);
  output.engineRevision = null;
  output.corpusManifestSha256 = null;
  output.workloadPlanSha256 = null;
  output.traceArtifacts = [];
  output.devices = [];
  output.performance = { fullWorkload: false, assets: [] };
  const assetOrder = new Map((manifest.formalAssets ?? []).map((value, index) => [value.id, index]));
  const deviceSources = new Map();
  const tracesByKey = new Map();
  const metricsByKey = new Map();
  let identity = null;

  for (const entry of traceEntries) {
    const trace = entry.trace;
    if (entry.validationStatus !== 'passed' || trace?.status !== 'passed' || trace?.evidenceClass !== 'clean-device-candidate' || trace?.engineDirty !== false) {
      throw new Error(`Trace ${String(entry.reference?.path)} is not validated clean formal evidence.`);
    }
    const asset = manifest.formalAssets?.find(value => value.id === trace.assetId);
    if (!asset) throw new Error(`Trace asset ${String(trace.assetId)} is outside formalAssets.`);
    if (asset.riv.sha256 !== trace.rivSha256) throw new Error(`Trace RIV identity differs from formal asset ${trace.assetId}.`);
    const devicePlan = workloadPlan.browserDeviceMatrix?.find(value => value.deviceClass === trace.environment?.deviceClass);
    if (!devicePlan?.browsers?.includes(trace.environment?.browser)) throw new Error(`Trace environment is outside the workload matrix: ${trace.environment?.deviceClass}:${trace.environment?.browser}.`);
    const nextIdentity = {
      engineRevision: trace.engineRevision,
      corpusManifestSha256: trace.corpusManifestSha256,
      workloadPlanSha256: trace.workloadPlanSha256,
    };
    if (identity && stableJson(identity) !== stableJson(nextIdentity)) throw new Error(`Trace ${entry.reference.path} has a conflicting formal identity.`);
    identity ??= nextIdentity;

    const key = traceKey(trace.assetId, trace.environment.deviceClass, trace.environment.browser);
    const reference = {
      assetId: trace.assetId,
      deviceClass: trace.environment.deviceClass,
      browser: trace.environment.browser,
      ...entry.reference,
    };
    addImmutable(tracesByKey, key, reference, 'trace');

    const deviceIdentity = {
      id: trace.environment.deviceClass,
      os: trace.environment.os,
      gpuClass: trace.environment.gpu,
      physicalDevice: trace.environment.physicalDevice,
      machineIdSha256: trace.environment.machineIdSha256,
    };
    const source = deviceSources.get(deviceIdentity.id) ?? { identity: deviceIdentity, browsers: new Map() };
    if (stableJson(source.identity) !== stableJson(deviceIdentity)) throw new Error(`Device identity changed across traces for ${deviceIdentity.id}.`);
    deviceSources.set(deviceIdentity.id, source);
    const browserIdentity = {
      browser: trace.environment.browser,
      version: trace.environment.browserVersion,
      nativeBackend: trace.environment.nativeBackend,
      officialBackend: trace.environment.officialBackend,
      hyaBackend: trace.environment.hyaBackend,
      browserLogCaptured: trace.environment.browserLogCaptured,
      consoleErrorCount: trace.environment.consoleErrorCount,
      exceptionCount: trace.environment.exceptionCount,
      unclassifiedFailureCount: trace.comparison.unclassifiedFailureCount,
    };
    const browserSource = source.browsers.get(browserIdentity.browser) ?? { identity: browserIdentity, traces: [] };
    if (stableJson(browserSource.identity) !== stableJson(browserIdentity)) throw new Error(`Browser identity changed across traces for ${deviceIdentity.id}:${browserIdentity.browser}.`);
    if (!browserSource.traces.some(value => value.assetId === reference.assetId)) browserSource.traces.push(reference);
    source.browsers.set(browserIdentity.browser, browserSource);

    const performance = {
      assetId: trace.assetId,
      deviceClass: trace.environment.deviceClass,
      browser: trace.environment.browser,
      tracePath: entry.reference.path,
      traceSha256: entry.reference.sha256,
      official: trace.official.metrics,
      hya: trace.hya.metrics,
      measurement: { official: trace.official.measurement, hya: trace.hya.measurement },
      sameMachine: trace.comparison.sameMachine,
      sameRevision: trace.comparison.sameRevision,
      sameActionStream: trace.comparison.sameActionStream,
    };
    addImmutable(metricsByKey, key, performance, 'performance');
  }

  if (identity) Object.assign(output, identity);
  output.traceArtifacts = [...tracesByKey.values()].sort((left, right) => compareEvidence(left, right, assetOrder, workloadPlan));
  const generatedArtifactBytesByPath = new Map();
  for (const devicePlan of workloadPlan.browserDeviceMatrix ?? []) {
    const source = deviceSources.get(devicePlan.deviceClass);
    if (!source) continue;
    const browsers = [];
    for (const browserName of devicePlan.browsers) {
      const browserSource = source.browsers.get(browserName);
      if (!browserSource || browserSource.traces.length !== (manifest.formalAssets ?? []).length) continue;
      const traces = [...browserSource.traces].sort((left, right) => compareEvidence(left, right, assetOrder, workloadPlan));
      const report = {
        schemaVersion: 1,
        kind: 'haiyue-rive-g11-device-browser-run',
        engineRevision: identity.engineRevision,
        corpusManifestSha256: identity.corpusManifestSha256,
        workloadPlanSha256: identity.workloadPlanSha256,
        device: source.identity,
        browser: browserSource.identity,
        fullWorkload: true,
        traceArtifacts: traces,
      };
      const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      const path = `${deviceBrowserArtifactDirectory}/${devicePlan.deviceClass}-${browserName}.json`;
      generatedArtifactBytesByPath.set(path, bytes);
      browsers.push({ ...browserSource.identity, fullWorkload: true, evidence: reference(path, bytes) });
    }
    if (browsers.length === devicePlan.browsers.length) output.devices.push({ ...source.identity, browsers });
  }
  output.performance.assets = [...metricsByKey.values()].sort((left, right) => compareEvidence(left, right, assetOrder, workloadPlan));

  if (closureEntry) output.browserClosure = closureFromReport(closureEntry, identity);
  const expectedKeys = expectedTraceKeys(manifest, workloadPlan);
  const observedTraceKeys = new Set(output.traceArtifacts.map(value => traceKey(value.assetId, value.deviceClass, value.browser)));
  const observedMetricKeys = new Set(output.performance.assets.map(value => traceKey(value.assetId, value.deviceClass, value.browser)));
  output.performance.fullWorkload = exactSet(observedTraceKeys, expectedKeys) && exactSet(observedMetricKeys, expectedKeys);
  const closureComplete = CLOSURE_SCANS.every(name => output.browserClosure?.scans?.find(value => value.name === name)?.status === 'passed');
  output.status = output.performance.fullWorkload && closureComplete ? 'complete' : 'collecting';
  return { index: output, generatedArtifactBytesByPath };
}

function closureFromReport(entry, identity) {
  const report = entry.report;
  const validation = validateRiveBrowserClosureReport(report, { formal: true, expectedRevision: identity?.engineRevision ?? report?.engineRevision });
  if (validation.status !== 'passed') throw new Error(`Closure report failed formal validation:\n- ${validation.violations.join('\n- ')}`);
  const scans = CLOSURE_SCANS.map(name => {
    const scan = report.scans?.find(value => value.name === name);
    if (!scan) throw new Error(`Closure report is missing ${name}.`);
    return { ...scan, evidence: entry.reference };
  });
  return {
    officialOracleBuildTimeOnly: report.officialOracleBuildTimeOnly,
    unclassifiedFailureCount: report.unclassifiedFailureCount,
    scans,
  };
}

function addImmutable(map, key, value, label) {
  const existing = map.get(key);
  if (existing && stableJson(existing) !== stableJson(value)) throw new Error(`Conflicting ${label} evidence for ${key}.`);
  map.set(key, value);
}

function expectedTraceKeys(manifest, workloadPlan) {
  return new Set((manifest.formalAssets ?? []).flatMap(asset => (workloadPlan.browserDeviceMatrix ?? []).flatMap(device => (
    device.browsers.map(browser => traceKey(asset.id, device.deviceClass, browser))
  ))));
}

function compareEvidence(left, right, assetOrder, workloadPlan) {
  return (assetOrder.get(left.assetId) ?? Number.MAX_SAFE_INTEGER) - (assetOrder.get(right.assetId) ?? Number.MAX_SAFE_INTEGER)
    || deviceOrder(left.deviceClass, workloadPlan) - deviceOrder(right.deviceClass, workloadPlan)
    || browserOrder(left.browser, left.deviceClass, workloadPlan) - browserOrder(right.browser, right.deviceClass, workloadPlan);
}
function deviceOrder(id, plan) { return plan.browserDeviceMatrix?.findIndex(value => value.deviceClass === id) ?? Number.MAX_SAFE_INTEGER; }
function browserOrder(browser, device, plan) { return plan.browserDeviceMatrix?.find(value => value.deviceClass === device)?.browsers?.indexOf(browser) ?? Number.MAX_SAFE_INTEGER; }
function traceKey(asset, device, browser) { return `${asset}:${device}:${browser}`; }
function exactSet(actual, expected) { return actual.size === expected.size && [...expected].every(value => actual.has(value)); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();

function runCli() {
  const defaultIndexPath = safePath('review/candidates/rive-g11-evidence-index.json');
  const indexPath = safePath(argument('--index') ?? 'review/candidates/rive-g11-evidence-index.json');
  const manifestPath = safePath('animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
  const manifestBytes = readFileSync(manifestPath); const manifest = JSON.parse(manifestBytes);
  const workloadPath = safePath(manifest.workloadPlan.path);
  const workloadBytes = readFileSync(workloadPath); const workloadPlan = JSON.parse(workloadBytes);
  const baseIndex = JSON.parse(readFileSync(existsSync(indexPath) ? indexPath : defaultIndexPath, 'utf8'));
  const tracePaths = new Set((baseIndex.traceArtifacts ?? []).map(value => value.path));
  for (const value of argumentsNamed('--trace')) tracePaths.add(posixPath(value));
  for (const value of argumentsNamed('--trace-dir')) for (const path of walkTraceFiles(safePath(value))) tracePaths.add(relative(root, path).split('\\').join('/'));
  const artifactBytesByPath = new Map();
  const traceEntries = [];
  const revision = git(['rev-parse', 'HEAD']);
  for (const path of tracePaths) {
    const tracePath = safePath(path); const bytes = readFileSync(tracePath); const trace = JSON.parse(bytes);
    artifactBytesByPath.set(path, bytes);
    loadTraceArtifactBytes(trace, artifactBytesByPath);
    const validation = validateRiveOracleTrace(trace, {
      formal: true, expectedRevision: revision, expectedManifestSha256: hash(manifestBytes), workloadPlan, artifactBytesByPath,
    });
    if (validation.status !== 'passed') throw new Error(`Trace ${path} failed formal validation:\n- ${validation.violations.join('\n- ')}`);
    traceEntries.push({ trace, validationStatus: validation.status, reference: reference(path, bytes) });
  }
  let closureEntry = null;
  const closureArgument = argument('--closure');
  const existingClosurePaths = new Set((baseIndex.browserClosure?.scans ?? []).map(value => value?.evidence?.path).filter(Boolean));
  if (existingClosurePaths.size > 1) throw new Error('Existing closure scans reference more than one aggregate report. Re-run with --closure to replace them deterministically.');
  const closurePath = closureArgument ? posixPath(closureArgument) : [...existingClosurePaths][0];
  if (closurePath) {
    const path = closurePath; const bytes = readFileSync(safePath(path)); artifactBytesByPath.set(path, bytes);
    closureEntry = { report: JSON.parse(bytes), reference: reference(path, bytes) };
  }
  const indexDirectory = relative(root, dirname(indexPath)).split('\\').join('/');
  const deviceBrowserArtifactDirectory = `${indexDirectory}/rive-g11-evidence/device-browser`;
  const built = buildRiveG11EvidenceIndex({
    baseIndex, traceEntries, closureEntry, manifest, workloadPlan, deviceBrowserArtifactDirectory,
  });
  for (const [path, bytes] of built.generatedArtifactBytesByPath) artifactBytesByPath.set(path, bytes);
  const validation = validateRiveG11EvidenceIndex(built.index, {
    expectedEngineRevision: revision,
    expectedManifestSha256: hash(manifestBytes),
    expectedWorkloadPlanSha256: hash(workloadBytes),
    artifactBytesByPath,
    manifest,
    workloadPlan,
  });
  if (validation.status !== 'passed') throw new Error(`Generated evidence index is invalid:\n- ${validation.violations.join('\n- ')}`);
  for (const [path, bytes] of built.generatedArtifactBytesByPath) atomicWrite(safePath(path), bytes);
  atomicWrite(indexPath, Buffer.from(`${JSON.stringify(built.index, null, 2)}\n`));
  console.log(`[rive-g11-index] ${built.index.status}; traces=${built.index.traceArtifacts.length}; performance=${built.index.performance.assets.length}; devices=${built.index.devices.length}; wrote ${relative(root, indexPath)}.`);
}

function loadTraceArtifactBytes(trace, target) {
  const queue = [...artifactReferencePaths(trace)];
  const seen = new Set();
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const bytes = readFileSync(safePath(path));
    target.set(path, bytes);
    if (path.endsWith('.json')) {
      const nested = JSON.parse(bytes);
      for (const nestedPath of artifactReferencePaths(nested)) if (!seen.has(nestedPath)) queue.push(nestedPath);
    }
  }
}

function artifactReferencePaths(value, output = new Set()) {
  if (Array.isArray(value)) { for (const item of value) artifactReferencePaths(item, output); return output; }
  if (!value || typeof value !== 'object') return output;
  if (typeof value.path === 'string' && typeof value.sha256 === 'string' && Number.isSafeInteger(value.byteLength)) output.add(value.path);
  for (const item of Object.values(value)) artifactReferencePaths(item, output);
  return output;
}

function walkTraceFiles(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkTraceFiles(path));
    else if (entry.isFile() && entry.name === 'trace.json') output.push(path);
  }
  return output;
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}
function reference(path, bytes) { return { path, sha256: hash(bytes), byteLength: bytes.byteLength }; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function argumentsNamed(name) { return process.argv.filter(value => value.startsWith(`${name}=`)).map(value => value.slice(name.length + 1)); }
function posixPath(value) { return relative(root, safePath(value)).split('\\').join('/'); }
function safePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error(`Path must be relative POSIX: ${String(value)}`);
  const path = resolve(root, value);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Path escapes Engine root: ${value}`);
  return path;
}
