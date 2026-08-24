import type { NeutralImportedObject, NeutralResolvedResource, RiveImportReport } from '../import/types.js';
import type {
  ConvertRiveToHyaInput,
  RiveCapabilityArtifact,
  RiveConversionLimits,
  RiveConverterAsset,
  RiveCoverageEntry,
  RiveFeatureLedgerEntry,
  RiveNeutralCapabilityEvaluation,
} from './types.js';
import { RIVE_CAPABILITY_EVALUATION_FORMAT, RIVE_CAPABILITY_EVALUATION_VERSION } from './types.js';
import { conversionFail } from './diagnostics.js';
import { canonicalClone, compareUtf8 } from './stable.js';

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FORBIDDEN_SOURCE_KEYS = new Set(['sourceObjectIndex', 'sourceTypeKey', 'sourcePropertyKey', 'sourceName', 'sourceOwner', 'riveTypeId', 'rivePropertyId']);
const CAPABILITIES = new Set(['vector-visual', 'deformable-rig', 'responsive-layout', 'state-machine', 'data-binding', 'interaction', 'semantics', 'audio-events', 'sandbox-script']);
const REPRESENTATIONS = new Set(['native-semantic', 'visual-baked']);

export interface AdaptedRiveConversion {
  readonly evaluation: RiveNeutralCapabilityEvaluation;
  readonly objectCount: number;
  readonly propertyCount: number;
  readonly artifacts: readonly RiveCapabilityArtifact[];
  readonly assets: readonly RiveConverterAsset[];
  readonly featureLedger: readonly RiveFeatureLedgerEntry[];
  readonly resolvedResources: ReadonlyMap<string, NeutralResolvedResource>;
}

export function adaptRiveNeutralEvaluation(
  input: ConvertRiveToHyaInput,
  neutralIrSha256: string,
  limits: RiveConversionLimits,
  approvedExternalOrigins: readonly string[],
): AdaptedRiveConversion {
  const { imported, evaluation } = input;
  exactKeys(evaluation, ['format', 'version', 'inputIrSha256', 'tuple', 'baseDocument', 'artifacts', 'coverage', 'bakedTracks', 'assets', 'featureLedger', 'classification'], '$.evaluation');
  if (evaluation.format !== RIVE_CAPABILITY_EVALUATION_FORMAT || evaluation.version !== RIVE_CAPABILITY_EVALUATION_VERSION) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Unsupported neutral capability evaluation format.', '$.evaluation');
  }
  if (!HASH.test(evaluation.inputIrSha256) || evaluation.inputIrSha256 !== neutralIrSha256) {
    conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability evaluation does not match the imported neutral IR.', '$.evaluation.inputIrSha256');
  }
  validateTuple(evaluation.tuple);
  validateClassification(evaluation.classification, '$.evaluation.classification', true);
  validateClassification(imported.report.registryCoverage, '$.imported.report.registryCoverage', false);
  validateReport(imported.report, imported.ir.objects);
  scanForbiddenSourceKeys(evaluation, '$.evaluation', new Set<object>());
  if (evaluation.artifacts.length > limits.maxArtifacts) limit('artifact', evaluation.artifacts.length, limits.maxArtifacts, '$.evaluation.artifacts');
  if (evaluation.assets.length > limits.maxAssets) limit('asset', evaluation.assets.length, limits.maxAssets, '$.evaluation.assets');
  if (evaluation.bakedTracks.length > limits.maxBakedTracks) limit('baked track', evaluation.bakedTracks.length, limits.maxBakedTracks, '$.evaluation.bakedTracks');

  const artifacts = validateArtifacts(evaluation.artifacts);
  const artifactsById = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  const { objectCount, propertyCount } = validateCoverage(imported.ir.objects, imported.report, evaluation.coverage, artifactsById);
  const resolvedResources = new Map(imported.ir.resolvedResources.map(resource => [resource.objectId, resource]));
  if (resolvedResources.size !== imported.ir.resolvedResources.length) conversionFail('E_RIVE_CONVERT_FORMAT', 'Neutral IR contains duplicate resolved resource object ids.', '$.imported.ir.resolvedResources');
  const assets = validateAssets(evaluation.assets, limits, resolvedResources, validateApprovedOrigins(approvedExternalOrigins));
  const featureLedger = validateLedger(evaluation.featureLedger, artifactsById);
  const cloned = canonicalClone({
    ...evaluation,
    assets: assets.map(asset => asset.kind === 'embedded' ? { ...asset, bytes: Array.from(asset.bytes) } : asset),
  }, '$.evaluation') as unknown as RiveNeutralCapabilityEvaluation;
  const ownedAssets = assets.map(asset => asset.kind === 'embedded'
    ? Object.freeze({ ...asset, bytes: new Uint8Array(asset.bytes) })
    : Object.freeze({ ...asset }));
  return Object.freeze({
    evaluation: Object.freeze({ ...cloned, assets: Object.freeze(ownedAssets) }),
    objectCount,
    propertyCount,
    artifacts: Object.freeze(artifacts),
    assets: Object.freeze(ownedAssets),
    featureLedger: Object.freeze(featureLedger),
    resolvedResources,
  });
}

function validateTuple(tuple: RiveNeutralCapabilityEvaluation['tuple']): void {
  exactKeys(tuple, ['adapterId', 'adapterRevisionSha256', 'evaluatorId', 'evaluatorRevisionSha256', 'optionsRevision'], '$.evaluation.tuple');
  for (const [key, value] of Object.entries(tuple)) {
    if (typeof value !== 'string' || !value.trim()) conversionFail('E_RIVE_CONVERT_FORMAT', 'Tuple fields must be non-empty strings.', `$.evaluation.tuple.${key}`);
  }
  if (!HASH.test(tuple.adapterRevisionSha256)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Adapter revision must be lowercase SHA-256.', '$.evaluation.tuple.adapterRevisionSha256');
  if (!HASH.test(tuple.evaluatorRevisionSha256)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Evaluator revision must be lowercase SHA-256.', '$.evaluation.tuple.evaluatorRevisionSha256');
}

function validateClassification(value: object, path: string, exact: boolean): void {
  if (exact) exactKeys(value, ['unclassifiedObjects', 'unclassifiedProperties', 'unclassifiedAssets', 'unclassifiedScripts'], path);
  for (const key of ['unclassifiedObjects', 'unclassifiedProperties', 'unclassifiedAssets', 'unclassifiedScripts'] as const) {
    if ((value as Record<string, unknown>)[key] !== 0) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', `${key} must be zero.`, `${path}.${key}`);
  }
}

function validateReport(report: RiveImportReport, objects: readonly NeutralImportedObject[]): void {
  const byId = new Map(objects.map(object => [object.id, object]));
  if (byId.size !== objects.length || report.objects.length !== objects.length) conversionFail('E_RIVE_CONVERT_FORMAT', 'Import object/report cardinality mismatch.', '$.imported.report.objects');
  const visited = new Set<string>();
  report.objects.forEach((visit, index) => {
    const object = byId.get(visit.neutralObjectId);
    const path = `$.imported.report.objects[${index}]`;
    if (!object || visited.has(visit.neutralObjectId)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Import report object mapping is missing or duplicated.', `${path}.neutralObjectId`, { objectIndex: visit.sourceObjectIndex, objectTypeKey: visit.sourceTypeKey });
    visited.add(visit.neutralObjectId);
    const properties = new Set(object.properties.map(property => property.id));
    for (const property of visit.properties) {
      for (const fieldId of property.neutralFieldIds) {
        if (!properties.has(fieldId)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Report field does not exist in neutral IR.', `${path}.properties`, { objectIndex: visit.sourceObjectIndex, objectTypeKey: visit.sourceTypeKey, propertyKey: property.sourcePropertyKey });
      }
    }
  });
}

function validateArtifacts(values: readonly RiveCapabilityArtifact[]): RiveCapabilityArtifact[] {
  const seen = new Set<string>();
  return values.map((artifact, index) => {
    const path = `$.evaluation.artifacts[${index}]`;
    exactKeys(artifact, ['id', 'capability', 'representation', 'document'], path);
    identifier(artifact.id, `${path}.id`);
    if (!CAPABILITIES.has(artifact.capability)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', 'Unknown neutral capability.', `${path}.capability`);
    if (!REPRESENTATIONS.has(artifact.representation)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Unknown representation.', `${path}.representation`);
    if (seen.has(artifact.id)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Duplicate artifact id.', `${path}.id`);
    seen.add(artifact.id);
    if (artifact.representation === 'visual-baked' && artifact.capability !== 'vector-visual') {
      conversionFail('E_RIVE_CONVERT_BAKING_INELIGIBLE', 'Only pure vector visual artifacts may use visual-baked representation.', `${path}.representation`);
    }
    return Object.freeze(canonicalClone(artifact, path));
  }).sort((left, right) => compareUtf8(left.id, right.id));
}

function validateCoverage(objects: readonly NeutralImportedObject[], report: RiveImportReport, entries: readonly RiveCoverageEntry[], artifactsById: ReadonlyMap<string, RiveCapabilityArtifact>): { objectCount: number; propertyCount: number } {
  const objectsById = new Map(objects.map(object => [object.id, object]));
  const objectCoverage = new Set<string>();
  const propertyCoverage = new Set<string>();
  const coveredArtifacts = new Set<string>();
  entries.forEach((entry, index) => {
    const path = `$.evaluation.coverage[${index}]`;
    exactKeys(entry, ['objectId', 'propertyIds', 'capability', 'representation', 'artifactId'], path);
    if (entry.capability !== 'hya-core' && !CAPABILITIES.has(entry.capability)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', 'Unknown neutral capability.', `${path}.capability`);
    if (!REPRESENTATIONS.has(entry.representation)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Unknown representation.', `${path}.representation`);
    const object = objectsById.get(entry.objectId);
    if (!object) conversionFail('E_RIVE_CONVERT_FORMAT', 'Coverage references an unknown neutral object.', `${path}.objectId`);
    const artifact = entry.artifactId === undefined ? undefined : artifactsById.get(entry.artifactId);
    if (entry.artifactId !== undefined && !artifact) conversionFail('E_RIVE_CONVERT_FORMAT', 'Coverage references an unknown artifact.', `${path}.artifactId`);
    if (entry.capability !== 'hya-core' && entry.artifactId === undefined) conversionFail('E_RIVE_CONVERT_FORMAT', 'Capability coverage must reference its artifact.', `${path}.artifactId`);
    if (artifact && (artifact.capability !== entry.capability || artifact.representation !== entry.representation)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Coverage capability/representation differs from its artifact.', path);
    if (artifact) coveredArtifacts.add(artifact.id);
    objectCoverage.add(entry.objectId);
    const objectFields = new Set(object.properties.map(property => property.id));
    entry.propertyIds.forEach((propertyId, propertyIndex) => {
      const key = `${entry.objectId}\0${propertyId}`;
      if (!objectFields.has(propertyId)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Coverage references an unknown neutral field.', `${path}.propertyIds[${propertyIndex}]`);
      if (propertyCoverage.has(key)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Neutral field is covered more than once.', `${path}.propertyIds[${propertyIndex}]`);
      propertyCoverage.add(key);
    });
  });
  for (const object of objects) {
    if (!objectCoverage.has(object.id)) uncovered(report, object.id, undefined);
    for (const property of object.properties) if (!propertyCoverage.has(`${object.id}\0${property.id}`)) uncovered(report, object.id, property.id);
  }
  for (const artifactId of artifactsById.keys()) if (!coveredArtifacts.has(artifactId)) conversionFail('E_RIVE_CONVERT_UNSUPPORTED', `Artifact "${artifactId}" has no neutral coverage entry.`, '$.evaluation.coverage');
  return { objectCount: objects.length, propertyCount: objects.reduce((sum, object) => sum + object.properties.length, 0) };
}

function uncovered(report: RiveImportReport, objectId: string, fieldId: string | undefined): never {
  const visit = report.objects.find(candidate => candidate.neutralObjectId === objectId)!;
  const property = fieldId === undefined ? undefined : visit.properties.find(candidate => candidate.neutralFieldIds.includes(fieldId));
  conversionFail('E_RIVE_CONVERT_UNSUPPORTED', fieldId === undefined ? 'Neutral object is not compiled.' : 'Neutral property is not compiled.', fieldId === undefined ? `$.ir.objects[${visit.sourceObjectIndex}]` : `$.ir.objects[${visit.sourceObjectIndex}].properties[${fieldId}]`, {
    objectIndex: visit.sourceObjectIndex,
    objectTypeKey: visit.sourceTypeKey,
    ...(property === undefined ? {} : { propertyKey: property.sourcePropertyKey }),
  });
}

function validateAssets(values: readonly RiveConverterAsset[], limits: RiveConversionLimits, resolvedResources: ReadonlyMap<string, NeutralResolvedResource>, approvedExternalOrigins: ReadonlySet<string>): RiveConverterAsset[] {
  const ids = new Set<string>(), resourceObjectIds = new Set<string>(); let total = 0;
  const result = values.map((asset, index) => {
    const path = `$.evaluation.assets[${index}]`; identifier(asset.id, `${path}.id`);
    if (asset.kind !== 'embedded' && asset.kind !== 'external') conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', 'Unknown asset kind.', `${path}.kind`);
    exactKeys(asset, asset.kind === 'embedded'
      ? ['id', 'neutralResourceObjectId', 'kind', 'mimeType', 'bytes', 'revision', 'licenseId']
      : ['id', 'neutralResourceObjectId', 'kind', 'mimeType', 'uri', 'sha256', 'byteLength', 'revision', 'licenseId'], path);
    if (ids.has(asset.id)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Duplicate asset id.', `${path}.id`); ids.add(asset.id);
    const expected = resolvedResources.get(asset.neutralResourceObjectId);
    if (!expected || resourceObjectIds.has(asset.neutralResourceObjectId)) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', 'Asset does not map exactly once to a resolved neutral resource.', `${path}.neutralResourceObjectId`);
    resourceObjectIds.add(asset.neutralResourceObjectId);
    if (!asset.mimeType.trim() || !asset.revision.trim() || !asset.licenseId.trim()) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', 'Asset metadata is incomplete.', path);
    if (asset.mimeType !== expected.mimeType || asset.revision !== expected.revision) conversionFail('E_RIVE_CONVERT_ASSET_INTEGRITY', 'Asset metadata differs from the resolved neutral resource.', path);
    if (asset.kind === 'embedded') {
      if (!(asset.bytes instanceof Uint8Array)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Embedded asset bytes must be Uint8Array.', `${path}.bytes`);
      if (asset.bytes.byteLength > limits.maxEmbeddedAssetBytes) limit('embedded asset bytes', asset.bytes.byteLength, limits.maxEmbeddedAssetBytes, `${path}.bytes`);
      total += asset.bytes.byteLength;
      if (total > limits.maxTotalEmbeddedAssetBytes) limit('total embedded asset bytes', total, limits.maxTotalEmbeddedAssetBytes, '$.evaluation.assets');
      if (asset.bytes.byteLength !== expected.byteLength) conversionFail('E_RIVE_CONVERT_ASSET_INTEGRITY', 'Embedded asset byte length differs from the resolved neutral resource.', `${path}.bytes`);
      return Object.freeze({ ...asset, bytes: new Uint8Array(asset.bytes) });
    }
    if (!HASH.test(asset.sha256) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) conversionFail('E_RIVE_CONVERT_ASSET_INTEGRITY', 'External asset requires lowercase SHA-256 and a non-negative byte length.', path);
    if (asset.sha256 !== expected.contentSha256 || asset.byteLength !== expected.byteLength) conversionFail('E_RIVE_CONVERT_ASSET_INTEGRITY', 'External asset integrity differs from the resolved neutral resource.', path);
    let url: URL; try { url = new URL(asset.uri); } catch { conversionFail('E_RIVE_CONVERT_ASSET_MISSING', 'External asset URI is invalid.', `${path}.uri`); }
    if (url.protocol !== 'https:') conversionFail('E_RIVE_CONVERT_ASSET_MISSING', 'External asset URI must use HTTPS.', `${path}.uri`);
    if (!approvedExternalOrigins.has(url.origin)) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', `External asset origin "${url.origin}" is not approved.`, `${path}.uri`);
    return Object.freeze({ ...asset });
  }).sort((left, right) => compareUtf8(left.id, right.id));
  for (const objectId of resolvedResources.keys()) if (!resourceObjectIds.has(objectId)) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', `Resolved neutral resource "${objectId}" is absent from converter assets.`, '$.evaluation.assets');
  return result;
}

function validateLedger(entries: readonly RiveFeatureLedgerEntry[], artifactsById: ReadonlyMap<string, RiveCapabilityArtifact>): RiveFeatureLedgerEntry[] {
  const features = new Set<string>(), representedArtifacts = new Set<string>();
  const result = entries.map((entry, index) => {
    const path = `$.evaluation.featureLedger[${index}]`;
    exactKeys(entry, ['feature', 'capability', 'representation', 'count', 'artifactId'], path);
    identifier(entry.feature, `${path}.feature`);
    if (entry.capability !== 'hya-core' && !CAPABILITIES.has(entry.capability)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', 'Unknown neutral capability.', `${path}.capability`);
    if (!REPRESENTATIONS.has(entry.representation)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Unknown representation.', `${path}.representation`);
    if (features.has(entry.feature)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Duplicate feature ledger entry.', `${path}.feature`); features.add(entry.feature);
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) conversionFail('E_RIVE_CONVERT_FORMAT', 'Feature count must be a non-negative integer.', `${path}.count`);
    const artifact = entry.artifactId === undefined ? undefined : artifactsById.get(entry.artifactId);
    if (entry.artifactId !== undefined && !artifact) conversionFail('E_RIVE_CONVERT_FORMAT', 'Feature ledger references an unknown artifact.', `${path}.artifactId`);
    if (artifact && (artifact.capability !== entry.capability || artifact.representation !== entry.representation)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Feature ledger capability/representation differs from its artifact.', path);
    if (artifact) representedArtifacts.add(artifact.id);
    return Object.freeze({ ...entry });
  }).sort((left, right) => compareUtf8(left.feature, right.feature));
  for (const artifactId of artifactsById.keys()) if (!representedArtifacts.has(artifactId)) conversionFail('E_RIVE_CONVERT_UNSUPPORTED', `Artifact "${artifactId}" is absent from the feature ledger.`, '$.evaluation.featureLedger');
  return result;
}

function scanForbiddenSourceKeys(value: unknown, path: string, seen: Set<object>): void {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Float32Array || value instanceof Uint32Array) return;
  if (seen.has(value)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Cyclic evaluator output is forbidden.', path); seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => scanForbiddenSourceKeys(item, `${path}[${index}]`, seen));
  else for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SOURCE_KEYS.has(key)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Source-specific identifiers may not cross the adapter boundary.', `${path}.${key}`);
    scanForbiddenSourceKeys(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function identifier(value: string, path: string): void { if (typeof value !== 'string' || !IDENTIFIER.test(value)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Expected a stable identifier.', path); }
function limit(label: string, observed: number, maximum: number, path: string): never { return conversionFail('E_RIVE_CONVERT_LIMIT', `${label} count ${observed} exceeds limit ${maximum}.`, path); }

function validateApprovedOrigins(values: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  values.forEach((value, index) => {
    let url: URL; try { url = new URL(value); } catch { conversionFail('E_RIVE_CONVERT_FORMAT', 'Approved external origin is invalid.', `$.options.approvedExternalOrigins[${index}]`); }
    if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') conversionFail('E_RIVE_CONVERT_FORMAT', 'Approved external origin must be an exact HTTPS origin.', `$.options.approvedExternalOrigins[${index}]`);
    if (result.has(value)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Approved external origin is duplicated.', `$.options.approvedExternalOrigins[${index}]`);
    result.add(value);
  });
  return result;
}

function exactKeys(value: object, allowed: readonly string[], path: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', `Unknown field "${key}".`, `${path}.${key}`);
}
