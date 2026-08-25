import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';
import { validateRiveG11SecurityReport } from './rive-g11-security-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const outputArgument = process.argv.find(value => value.startsWith('--out='));
const outputPath = resolve(root, outputArgument?.slice('--out='.length) ?? 'review/candidates/rive-g11-candidate.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const censusBytes = readFileSync(resolve(root, manifest.census.path));
const census = JSON.parse(censusBytes.toString('utf8'));
const workloadPlanBytes = readFileSync(resolve(root, manifest.workloadPlan.path));
const workloadPlan = JSON.parse(workloadPlanBytes.toString('utf8'));
const diagnosticCorpus = validateRiveCorpusManifest(manifest, census, { root });
if (diagnosticCorpus.status !== 'passed') {
  throw new Error(`Cannot create G11 candidate from an invalid corpus contract:\n- ${diagnosticCorpus.violations.join('\n- ')}`);
}
const formalCorpus = validateRiveCorpusManifest(manifest, census, { formal: true, root });
const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const diagnosticFindings = readDiagnosticFindings();
const securityEvidence = readSecurityEvidence(revision, manifestBytes);
const blockers = [
  ...formalCorpus.violations,
  'official @rive-app/webgl2@2.40.0 differential traces have not been captured',
  'the two required Windows browser/device classes have not supplied full-workload evidence',
  'packed player, browser bundle, source map, and network closure scans have not been run',
  ...(diagnosticFindings ? [
    ...(diagnosticFindings.importerOracleDivergenceCount > 0
      ? [`${diagnosticFindings.importerOracleDivergenceCount} official-loaded 7.3 fixtures are rejected by the HYA importer`]
      : []),
    ...(diagnosticFindings.oracleBrowserGateFailureCount > 0
      ? [`${diagnosticFindings.oracleBrowserGateFailureCount} 7.3 fixture triggers an official-oracle browser gate failure`]
      : []),
  ] : []),
];
const candidate = {
  schemaVersion: 1,
  kind: 'haiyue-rive-g11-candidate',
  goal: 'm07/g11-corpus-version-fidelity-performance',
  status: 'incomplete',
  blockers: [...new Set(blockers)],
  tupleId: manifest.compatibilityTuple.id,
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  nodeVersion: process.version,
  evidenceClass: dirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
  corpus: {
    manifest: relative(root, manifestPath).split('\\').join('/'),
    manifestSha256: hash(manifestBytes),
    censusSha256: hash(censusBytes),
    formalAssetCount: diagnosticCorpus.summary.formalAssetCount,
    realProductAssetCount: diagnosticCorpus.summary.realProductAssetCount,
    combinedStressAssetCount: diagnosticCorpus.summary.combinedStressAssetCount,
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
  traceArtifacts: [],
  devices: [],
  performance: { fullWorkload: false, assets: [] },
  security: {
    cases: securityEvidence ? securityEvidence.report.cases.map(value => ({
      ...value,
      evidence: securityEvidence.reference,
    })) : manifest.securityCases.map(value => ({
      id: value.id,
      class: value.class,
      status: 'not-run',
      expectedDiagnostic: value.expected,
      observedDiagnostic: null,
      ownerResidual: null,
      peakMemoryBytes: null,
      cpuMs: null,
    })),
  },
  browserClosure: {
    officialOracleBuildTimeOnly: true,
    unclassifiedFailureCount: 0,
    scans: ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'].map(name => ({
      name,
      status: 'not-run',
      reason: 'Formal corpus, converted HYA package, and browser workload are not yet available.',
      sha256: null,
      forbiddenPackageCount: null,
      forbiddenFileCount: null,
      forbiddenStaticPatternCount: null,
      forbiddenNetworkCount: null,
      rawRivCount: null,
    })),
  },
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
});
if (contract.status !== 'passed') {
  throw new Error(`Generated G11 diagnostic candidate violates its contract:\n- ${contract.violations.join('\n- ')}`);
}
writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
console.log(`[rive-g11] incomplete diagnostic candidate written to ${relative(root, outputPath)} with ${candidate.blockers.length} blockers.`);

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
      assets: inventory.totals.assets,
      accepted: inventory.totals.accepted,
      coveredObjectKeys: inventory.totals.coveredObjectKeys,
      coveredPropertyKeys: inventory.totals.coveredPropertyKeys,
      unclassifiedFailureCount: inventory.totals.unclassifiedFailureCount,
    },
    oracleRepositoryInventory: wasmInventory ? {
      path: relative(root, wasmInventoryPath).split('\\').join('/'),
      sha256: hash(wasmInventoryBytes),
      assets: wasmInventory.totals.assets,
      accepted: wasmInventory.totals.accepted,
      rejectedMinor: wasmInventory.totals.rejectedByCode?.E_RIVE_FORMAT_MINOR_UNSUPPORTED ?? 0,
      unclassifiedFailureCount: wasmInventory.totals.unclassifiedFailureCount,
    } : null,
    officialLoadMatrix: {
      path: relative(root, oraclePath).split('\\').join('/'),
      sha256: hash(oracleBytes),
      loaded: oracle.loadedCount,
      browserGateFailed: oracle.browserGateFailedCount,
      ownerResidual: oracle.ownerResidual,
    },
    edgeLoadMatrix: edge ? {
      path: relative(root, edgePath).split('\\').join('/'),
      sha256: hash(edgeBytes),
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

function readSecurityEvidence(expectedRevision, currentManifestBytes) {
  const path = resolve(root, 'review/candidates/rive-g11-security-diagnostic.json');
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const report = JSON.parse(bytes.toString('utf8'));
  const validation = validateRiveG11SecurityReport(report, manifest, {
    expectedRevision,
    expectedManifestSha256: hash(currentManifestBytes),
  });
  if (validation.status !== 'passed') throw new Error(`G11 security evidence is invalid:\n- ${validation.violations.join('\n- ')}`);
  return {
    report,
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
