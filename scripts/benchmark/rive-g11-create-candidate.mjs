import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';
import { validateRiveG11EvidenceIndex } from './rive-g11-evidence-index-contract.mjs';
import { validateRiveG11SecurityReport } from './rive-g11-security-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = safePath('animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const outputArgument = process.argv.find(value => value.startsWith('--out='));
const outputPath = safePath(outputArgument?.slice('--out='.length) ?? 'review/candidates/rive-g11-candidate.json');
const evidenceIndexArgument = process.argv.find(value => value.startsWith('--evidence-index='));
const evidenceIndexPath = safePath(evidenceIndexArgument?.slice('--evidence-index='.length) ?? 'review/candidates/rive-g11-evidence-index.json');
const securityArgument = process.argv.find(value => value.startsWith('--security='));
const securityPath = safePath(securityArgument?.slice('--security='.length) ?? 'review/candidates/rive-g11-security-diagnostic.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const censusBytes = readFileSync(resolve(root, manifest.census.path));
const census = JSON.parse(censusBytes.toString('utf8'));
const workloadPlanBytes = readFileSync(resolve(root, manifest.workloadPlan.path));
const workloadPlan = JSON.parse(workloadPlanBytes.toString('utf8'));
const evidenceIndexBytes = readFileSync(evidenceIndexPath);
const evidenceIndex = JSON.parse(evidenceIndexBytes.toString('utf8'));
const diagnosticCorpus = validateRiveCorpusManifest(manifest, census, { root });
if (diagnosticCorpus.status !== 'passed') {
  throw new Error(`Cannot create G11 candidate from an invalid corpus contract:\n- ${diagnosticCorpus.violations.join('\n- ')}`);
}
const formalCorpus = validateRiveCorpusManifest(manifest, census, { formal: true, root });
const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const artifactBytesByPath = readEvidenceArtifactBytes(evidenceIndex);
const tracesByPath = new Map((evidenceIndex.traceArtifacts ?? []).flatMap(reference => {
  const bytes = artifactBytesByPath.get(reference.path);
  return bytes ? [[reference.path, JSON.parse(bytes.toString('utf8'))]] : [];
}));
const evidenceIndexValidation = validateRiveG11EvidenceIndex(evidenceIndex, {
  expectedEngineRevision: revision,
  expectedManifestSha256: hash(manifestBytes),
  expectedWorkloadPlanSha256: hash(workloadPlanBytes),
  artifactBytesByPath, manifest, workloadPlan,
});
const diagnosticFindings = readDiagnosticFindings();
const securityEvidence = readSecurityEvidence(revision, manifestBytes, securityPath);
const securityCases = securityEvidence?.validation.status === 'passed'
  ? securityEvidence.report.cases.map(value => ({ ...value, evidence: securityEvidence.reference }))
  : manifest.securityCases.map(value => ({
    id: value.id, class: value.class, status: 'not-run', expectedDiagnostic: value.expected,
    observedDiagnostic: null, ownerResidual: null, peakMemoryBytes: null, cpuMs: null,
  }));
const blockers = deriveBlockers({
  evidenceIndex, evidenceIndexValidation, formalCorpus, manifest, workloadPlan, dirty,
  diagnosticFindings, securityCases, securityEvidence, tracesByPath,
});
/* Every blocker below is derived from a checked contract or an observed artifact. */
const candidate = {
  schemaVersion: 1,
  kind: 'haiyue-rive-g11-candidate',
  goal: 'm07/g11-corpus-version-fidelity-performance',
  status: blockers.length === 0 ? 'passed' : 'incomplete',
  blockers,
  tupleId: manifest.compatibilityTuple.id,
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  nodeVersion: process.version,
  evidenceClass: dirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
  evidenceIndex: {
    path: relative(root, evidenceIndexPath).split('\\').join('/'),
    sha256: hash(evidenceIndexBytes),
    byteLength: evidenceIndexBytes.byteLength,
  },
  corpus: {
    manifest: relative(root, manifestPath).split('\\').join('/'),
    manifestSha256: hash(manifestBytes),
    censusSha256: hash(censusBytes),
    formalAssetCount: diagnosticCorpus.summary.formalAssetCount,
    evidenceRoleCount: diagnosticCorpus.summary.evidenceRoleCount,
    realProductWitnessCount: diagnosticCorpus.summary.realProductWitnessCount,
    combinedStressWitnessCount: diagnosticCorpus.summary.combinedStressWitnessCount,
    featureWitnessCount: diagnosticCorpus.summary.featureWitnessCount,
    adversarialCaseCount: diagnosticCorpus.summary.adversarialCaseCount,
  },
  workloadPlan: {
    id: workloadPlan.id,
    path: manifest.workloadPlan.path,
    sha256: hash(workloadPlanBytes),
  },
  coverage: {
    contractRevision: 2,
    sourceCensus: {
      objectTypes: census.totals.objectTypes,
      propertyKeys: census.totals.propertyKeys,
      scriptModules: census.totals.scriptModules,
      scriptSymbols: census.totals.scriptSymbols,
      assetTypes: census.totals.assetTypes,
      unclassifiedFailureCount: 0,
    },
    binaryEvidence: {
      objectTypes: census.coverageEvidenceModel.binaryEvidence.objectTypes,
      propertyKeys: census.coverageEvidenceModel.binaryEvidence.propertyKeys,
      assetTypes: census.coverageEvidenceModel.binaryEvidence.assetTypes,
      uncoveredObjects: diagnosticCorpus.summary.uncovered.objectKeys,
      uncoveredProperties: diagnosticCorpus.summary.uncovered.propertyKeys,
      uncoveredAssets: diagnosticCorpus.summary.uncovered.assetTypeKeys,
    },
    behavioralEvidence: {
      featureFamilies: census.coverageEvidenceModel.behavioralEvidence.featureFamilies,
      scriptModules: census.coverageEvidenceModel.behavioralEvidence.scriptModules,
      scriptSymbols: census.coverageEvidenceModel.behavioralEvidence.scriptSymbols,
      uncoveredFeatureFamilies: diagnosticCorpus.summary.behavioral.uncoveredFeatureFamilies,
      unclassifiedScriptCapabilities: census.totals.unclassifiedScripts,
      attributedScriptModules: diagnosticCorpus.summary.sourceAttribution.scriptModuleKeys,
      attributedScriptSymbols: diagnosticCorpus.summary.sourceAttribution.scriptSymbolKeys,
    },
  },
  traceArtifacts: evidenceIndex.traceArtifacts,
  devices: evidenceIndex.devices,
  performance: evidenceIndex.performance,
  security: { cases: securityCases },
  browserClosure: evidenceIndex.browserClosure,
  licenses: {
    assets: manifest.formalAssets.map(asset => ({
      assetId: asset.id,
      licenseId: asset.license.id,
      evidence: asset.license.evidence,
      rightsComplete: Object.values(asset.license.allowedUses).every(value => value === true),
      transitiveAssetsComplete: asset.externalAssets.length === 0,
    })),
  },
  diagnosticFindings,
};
const contract = validateRiveG11Candidate(candidate, {
  expectedEngineRevision: revision,
  expectedManifestSha256: candidate.corpus.manifestSha256,
  manifest,
  workloadPlan,
  tracesByPath,
  artifactBytesByPath,
});
if (contract.status !== 'passed') {
  throw new Error(`Generated G11 diagnostic candidate violates its contract:\n- ${contract.violations.join('\n- ')}`);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
console.log(`[rive-g11] ${candidate.status} candidate written to ${relative(root, outputPath)} with ${candidate.blockers.length} blockers.`);

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readEvidenceArtifactBytes(index) {
  const references = [
    ...(index.traceArtifacts ?? []),
    ...(index.devices ?? []).flatMap(value => (value.browsers ?? []).map(browser => browser.evidence).filter(Boolean)),
    ...(index.browserClosure?.scans ?? []).map(value => value.evidence).filter(Boolean),
  ];
  const output = new Map();
  for (const reference of references) {
    const path = resolve(root, reference.path);
    const candidateRelative = relative(root, path);
    if (candidateRelative === '..' || candidateRelative.startsWith('../') || candidateRelative.startsWith('..\\')) {
      throw new Error(`Evidence artifact escapes Engine root: ${reference.path}`);
    }
    if (existsSync(path)) output.set(reference.path, readFileSync(path));
  }
  return output;
}

function deriveBlockers({ evidenceIndex, evidenceIndexValidation, formalCorpus, manifest, workloadPlan, dirty, diagnosticFindings, securityCases, securityEvidence, tracesByPath }) {
  const values = [
    ...formalCorpus.violations,
    ...evidenceIndexValidation.violations.map(value => `evidence index: ${value}`),
  ];
  if (dirty) values.push('formal evidence requires a clean Engine revision');
  if (Number(process.versions.node.split('.')[0]) < 22) values.push(`formal evidence requires Node.js 22 or later; observed ${process.version}`);

  const expectedKeys = new Set(manifest.formalAssets.flatMap(asset => workloadPlan.browserDeviceMatrix.flatMap(device => (
    device.browsers.map(browser => `${asset.id}:${device.deviceClass}:${browser}`)
  ))));
  const traceKeys = new Set((evidenceIndex.traceArtifacts ?? []).map(value => `${value.assetId}:${value.deviceClass}:${value.browser}`));
  const missingTraces = [...expectedKeys].filter(value => !traceKeys.has(value));
  if (missingTraces.length > 0) values.push(`${missingTraces.length}/${expectedKeys.size} required production differential traces are missing`);
  const failedTraces = [...tracesByPath.values()].filter(value => value?.status !== 'passed');
  if (failedTraces.length > 0) values.push(`${failedTraces.length} production differential traces are non-passing`);

  const deviceIds = new Set((evidenceIndex.devices ?? []).map(value => value.id));
  const missingDevices = workloadPlan.browserDeviceMatrix.map(value => value.deviceClass).filter(value => !deviceIds.has(value));
  if (missingDevices.length > 0) values.push(`required physical device evidence is missing: ${missingDevices.join(', ')}`);

  const metricKeys = new Set((evidenceIndex.performance?.assets ?? []).map(value => `${value.assetId}:${value.deviceClass}:${value.browser}`));
  const missingMetrics = [...expectedKeys].filter(value => !metricKeys.has(value));
  if (missingMetrics.length > 0) values.push(`${missingMetrics.length}/${expectedKeys.size} full-workload performance samples are missing`);
  if (evidenceIndex.performance?.fullWorkload !== true) values.push('full-workload performance identity has not been completed');

  const nonPassingSecurity = securityCases.filter(value => value.status !== 'passed');
  if (securityEvidence && securityEvidence.validation.status !== 'passed') {
    values.push(`security evidence is stale or invalid: ${securityEvidence.validation.violations.join('; ')}`);
  }
  if (nonPassingSecurity.length > 0) values.push(`${nonPassingSecurity.length}/${securityCases.length} security cases are not passing`);

  for (const scan of evidenceIndex.browserClosure?.scans ?? []) {
    if (scan.status !== 'passed') values.push(`${scan.name} browser-closure scan is ${scan.status}`);
  }
  if ((evidenceIndex.browserClosure?.unclassifiedFailureCount ?? 0) !== 0) values.push('browser closure contains unclassified failures');
  if (diagnosticFindings?.importerOracleDivergenceCount > 0) values.push(`${diagnosticFindings.importerOracleDivergenceCount} official-loaded 7.3 fixtures are rejected by the HYA importer`);
  if (diagnosticFindings?.oracleBrowserGateFailureCount > 0) values.push(`${diagnosticFindings.oracleBrowserGateFailureCount} official fixture triggers an oracle browser gate failure`);
  if (evidenceIndex.status !== 'complete') values.push('formal evidence index remains collecting');
  return [...new Set(values)];
}

function readDiagnosticFindings() {
  const inventoryPath = resolve(root, 'review/candidates/rive-official-7-3-input-inventory-diagnostic.json');
  const wasmInventoryPath = resolve(root, 'review/candidates/rive-upstream-diagnostic-inventory.json');
  const oraclePath = resolve(root, 'review/candidates/rive-official-7-3-load-chrome-diagnostic.json');
  const edgePath = resolve(root, 'review/candidates/rive-official-7-3-load-edge-diagnostic.json');
  const admissionPath = resolve(root, 'review/candidates/rive-official-7-3-admission-diagnostic.json');
  if (!existsSync(inventoryPath) || !existsSync(oraclePath)) return null;
  const inventoryBytes = readFileSync(inventoryPath);
  const oracleBytes = readFileSync(oraclePath);
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const wasmInventoryBytes = existsSync(wasmInventoryPath) ? readFileSync(wasmInventoryPath) : null;
  const wasmInventory = wasmInventoryBytes ? JSON.parse(wasmInventoryBytes.toString('utf8')) : null;
  const oracle = JSON.parse(oracleBytes.toString('utf8'));
  const edgeBytes = existsSync(edgePath) ? readFileSync(edgePath) : null;
  const edge = edgeBytes ? JSON.parse(edgeBytes.toString('utf8')) : null;
  const admissionBytes = existsSync(admissionPath) ? readFileSync(admissionPath) : null;
  const officialLoaded = new Set((oracle.results ?? [])
    .filter(value => value.status === 'completed' && value.result?.loadedCount === 1)
    .map(value => value.path));
  const divergences = (inventory.assets ?? []).filter(value => (
    officialLoaded.has(value.path) && value.result?.status === 'rejected'
    && value.result?.code !== 'E_RIVE_ASSET_LICENSE'
  ));
  const gateFailures = (oracle.results ?? []).filter(value => value.status === 'browser-gate-failed');
  return {
    formalEvidence: false,
    officialInputAdmission: admissionBytes ? {
      path: relative(root, admissionPath).split('\\').join('/'),
      sha256: hash(admissionBytes),
      byteLength: admissionBytes.byteLength,
    } : null,
    runtimeInventory: {
      path: relative(root, inventoryPath).split('\\').join('/'),
      sha256: hash(inventoryBytes),
      byteLength: inventoryBytes.byteLength,
      assets: inventory.totals.assets,
      accepted: inventory.totals.accepted,
      coveredObjectKeys: inventory.totals.coveredObjectKeys,
      coveredPropertyKeys: inventory.totals.coveredPropertyKeys,
      unclassifiedFailureCount: inventory.totals.unclassifiedFailureCount,
    },
    oracleRepositoryInventory: wasmInventory ? {
      path: relative(root, wasmInventoryPath).split('\\').join('/'),
      sha256: hash(wasmInventoryBytes),
      byteLength: wasmInventoryBytes.byteLength,
      assets: wasmInventory.totals.assets,
      accepted: wasmInventory.totals.accepted,
      rejectedMinor: wasmInventory.totals.rejectedByCode?.E_RIVE_FORMAT_MINOR_UNSUPPORTED ?? 0,
      unclassifiedFailureCount: wasmInventory.totals.unclassifiedFailureCount,
    } : null,
    officialLoadMatrix: {
      path: relative(root, oraclePath).split('\\').join('/'),
      sha256: hash(oracleBytes),
      byteLength: oracleBytes.byteLength,
      loaded: oracle.loadedCount,
      browserGateFailed: oracle.browserGateFailedCount,
      ownerResidual: oracle.ownerResidual,
    },
    edgeLoadMatrix: edge ? {
      path: relative(root, edgePath).split('\\').join('/'),
      sha256: hash(edgeBytes),
      byteLength: edgeBytes.byteLength,
      loaded: edge.loadedCount,
      browserGateFailed: edge.browserGateFailedCount,
      ownerResidual: edge.ownerResidual,
    } : null,
    observedBrowsers: edge ? ['chrome', 'edge'] : ['chrome'],
    formalDeviceClassCount: 0,
    crossBrowserPixelHashDifferenceCount: edge ? crossBrowserPixelHashDifferences(oracle, edge) : null,
    coveredObjectKeys: inventory.totals.coveredObjectKeys,
    coveredPropertyKeys: inventory.totals.coveredPropertyKeys,
    importerOracleDivergenceCount: divergences.length,
    oracleBrowserGateFailureCount: gateFailures.length,
    redCaseCount: divergences.length + gateFailures.length,
    redCases: [
      ...divergences.map(value => ({
        id: `importer-reject:${value.path}`,
        sourcePath: value.path,
        rivSha256: value.sha256,
        owner: 'g02-riv-import-neutral-ir',
        official: 'loaded',
        hya: value.result,
      })),
      ...gateFailures.map(value => ({
        id: `official-oracle-failure:${value.path}`,
        sourcePath: value.path,
        owner: 'g11-corpus-version-fidelity-performance',
        official: { status: 'browser-gate-failed', error: value.error },
        hya: 'import-accepted',
      })),
    ],
  };
}

function readSecurityEvidence(expectedRevision, currentManifestBytes, path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const report = JSON.parse(bytes.toString('utf8'));
  const validation = validateRiveG11SecurityReport(report, manifest, {
    expectedRevision,
    expectedManifestSha256: hash(currentManifestBytes),
  });
  return {
    report,
    validation,
    reference: {
      path: relative(root, path).split('\\').join('/'),
      sha256: hash(bytes),
      byteLength: bytes.byteLength,
    },
  };
}

function crossBrowserPixelHashDifferences(chrome, edge) {
  const edgeByPath = new Map((edge.results ?? []).map(value => [value.path, value]));
  let differences = 0;
  for (const chromeResult of chrome.results ?? []) {
    const edgeResult = edgeByPath.get(chromeResult.path);
    if (chromeResult.status !== 'completed' || edgeResult?.status !== 'completed') continue;
    const chromeHashes = (chromeResult.result?.results?.[0]?.artboards ?? []).map(value => value.pixels?.sha256);
    const edgeHashes = (edgeResult.result?.results?.[0]?.artboards ?? []).map(value => value.pixels?.sha256);
    if (JSON.stringify(chromeHashes) !== JSON.stringify(edgeHashes)) differences++;
  }
  return differences;
}

function safePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`Path must be relative POSIX: ${String(value)}`);
  }
  const path = resolve(root, value);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Path escapes Engine root: ${value}`);
  return path;
}
