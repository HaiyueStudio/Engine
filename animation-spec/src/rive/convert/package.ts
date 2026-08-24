import type { AdaptedRiveConversion } from './adapter.js';
import type { CompiledRiveFile } from './compiler.js';
import type { RiveConversionLimits, RiveHyaPackageManifest, RivePackageAssetEntry, RivePackageFileEntry } from './types.js';
import { RIVE_HYA_PACKAGE_FORMAT, RIVE_HYA_PACKAGE_VERSION } from './types.js';
import { conversionFail } from './diagnostics.js';
import { throwIfAborted } from './diagnostics.js';
import { compareUtf8, normalizePackagePath, sha256, stableJsonBytes } from './stable.js';

const MAGIC = new TextEncoder().encode('HYAPKG1\0');
const DECODER = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

export interface PreparedPackageAsset extends RivePackageAssetEntry {}
export interface PreparedRiveAssets { readonly entries: readonly PreparedPackageAsset[]; readonly files: readonly CompiledRiveFile[]; readonly byId: ReadonlyMap<string, PreparedPackageAsset>; }
export interface AssembledRivePackage { readonly packageBytes: Uint8Array; readonly manifest: RiveHyaPackageManifest; readonly manifestBytes: Uint8Array; }

export async function prepareRiveAssets(adapted: AdaptedRiveConversion, signal: AbortSignal): Promise<PreparedRiveAssets> {
  const entries: PreparedPackageAsset[] = [], files = new Map<string, CompiledRiveFile>(), byId = new Map<string, PreparedPackageAsset>();
  for (const asset of adapted.assets) {
    throwIfAborted(signal);
    if (asset.kind === 'embedded') {
      const digest = await sha256(asset.bytes), path = `assets/${digest}`;
      throwIfAborted(signal);
      if (digest !== adapted.resolvedResources.get(asset.neutralResourceObjectId)!.contentSha256) conversionFail('E_RIVE_CONVERT_ASSET_INTEGRITY', 'Embedded asset SHA-256 differs from the resolved neutral resource.', `$.evaluation.assets[id=${asset.id}].bytes`);
      const entry: PreparedPackageAsset = Object.freeze({ id: asset.id, kind: 'embedded', mimeType: asset.mimeType, sha256: digest, byteLength: asset.bytes.byteLength, revision: asset.revision, licenseId: asset.licenseId, path });
      entries.push(entry); byId.set(asset.id, entry);
      if (!files.has(path)) files.set(path, Object.freeze({ path, mediaType: asset.mimeType, bytes: new Uint8Array(asset.bytes) }));
    } else {
      const entry: PreparedPackageAsset = Object.freeze({ id: asset.id, kind: 'external', mimeType: asset.mimeType, sha256: asset.sha256, byteLength: asset.byteLength, revision: asset.revision, licenseId: asset.licenseId, uri: asset.uri });
      entries.push(entry); byId.set(asset.id, entry);
    }
  }
  entries.sort((left, right) => compareUtf8(left.id, right.id));
  return Object.freeze({ entries: Object.freeze(entries), files: Object.freeze([...files.values()].sort((left, right) => compareUtf8(left.path, right.path))), byId });
}

export async function assembleRivePackage(
  compiledFiles: readonly CompiledRiveFile[],
  preparedAssets: PreparedRiveAssets,
  adapted: AdaptedRiveConversion,
  input: Readonly<{ rivSha256: string; neutralIrSha256: string }>,
  limits: RiveConversionLimits,
  signal: AbortSignal,
): Promise<AssembledRivePackage> {
  throwIfAborted(signal);
  const payload = new Map<string, CompiledRiveFile>();
  for (const file of [...compiledFiles, ...preparedAssets.files]) addFile(payload, file);
  const initialEntries = await describeFiles([...payload.values()]);
  throwIfAborted(signal);
  const hya = initialEntries.find(file => file.path === 'animation.hya');
  if (!hya) conversionFail('E_RIVE_CONVERT_INTERNAL', 'Compiled package is missing animation.hya.', '$package');
  const evidenceBytes = stableJsonBytes({
    schema: 'haiyue-rive-hya-package-evidence', version: 1, tuple: adapted.evaluation.tuple, input,
    hyaSha256: hya.sha256, files: initialEntries, featureLedger: adapted.featureLedger,
    coverage: { objects: adapted.objectCount, properties: adapted.propertyCount, uncoveredObjects: 0, uncoveredProperties: 0 },
    classification: adapted.evaluation.classification, diagnostics: [],
  });
  addFile(payload, { path: 'report/conversion-evidence.json', mediaType: 'application/vnd.haiyue.rive-hya-conversion-report+json', bytes: evidenceBytes });
  const entries = await describeFiles([...payload.values()]);
  throwIfAborted(signal);
  const manifest: RiveHyaPackageManifest = Object.freeze({
    format: RIVE_HYA_PACKAGE_FORMAT, version: RIVE_HYA_PACKAGE_VERSION, hya: 'animation.hya', tuple: adapted.evaluation.tuple, input,
    files: Object.freeze(entries), assets: preparedAssets.entries, featureLedger: adapted.featureLedger,
  });
  const manifestBytes = stableJsonBytes(manifest);
  addFile(payload, { path: 'manifest.json', mediaType: 'application/vnd.haiyue.rive-hya-package-manifest+json', bytes: manifestBytes });
  if (payload.size > limits.maxPackageFiles) conversionFail('E_RIVE_CONVERT_LIMIT', `Package file count ${payload.size} exceeds ${limits.maxPackageFiles}.`, '$package.files');
  const packageBytes = encodeRiveHyaArchive([...payload.values()]);
  if (packageBytes.byteLength > limits.maxPackageBytes) conversionFail('E_RIVE_CONVERT_LIMIT', `Package byte length ${packageBytes.byteLength} exceeds ${limits.maxPackageBytes}.`, '$package');
  return Object.freeze({ packageBytes, manifest, manifestBytes });
}

export function encodeRiveHyaArchive(files: readonly CompiledRiveFile[]): Uint8Array {
  const ordered = [...files].map((file, index) => ({ ...file, path: normalizePackagePath(file.path, `$.files[${index}].path`) })).sort((left, right) => compareUtf8(left.path, right.path));
  const seen = new Set<string>(); let total = 12;
  const records = ordered.map((file, index) => {
    if (seen.has(file.path)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Duplicate archive path.', `$.files[${index}].path`); seen.add(file.path);
    const path = ENCODER.encode(file.path), media = ENCODER.encode(file.mediaType);
    if (path.length > 0xffff || media.length > 0xffff || file.bytes.byteLength > 0xffffffff) conversionFail('E_RIVE_CONVERT_LIMIT', 'Archive entry exceeds binary field limits.', `$.files[${index}]`);
    total += 8 + path.length + media.length + file.bytes.byteLength;
    return { path, media, bytes: file.bytes };
  });
  const output = new Uint8Array(total); output.set(MAGIC, 0); const view = new DataView(output.buffer); view.setUint32(8, records.length, true); let offset = 12;
  for (const record of records) {
    view.setUint16(offset, record.path.length, true); view.setUint16(offset + 2, record.media.length, true); view.setUint32(offset + 4, record.bytes.byteLength, true); offset += 8;
    output.set(record.path, offset); offset += record.path.length; output.set(record.media, offset); offset += record.media.length; output.set(record.bytes, offset); offset += record.bytes.byteLength;
  }
  return output;
}

export function decodeRiveHyaArchive(bytes: Uint8Array, limits: Pick<RiveConversionLimits, 'maxPackageBytes' | 'maxPackageFiles'>): readonly CompiledRiveFile[] {
  if (bytes.byteLength > limits.maxPackageBytes) conversionFail('E_RIVE_CONVERT_LIMIT', 'Archive exceeds package byte limit.', '$archive');
  if (bytes.byteLength < 12 || !MAGIC.every((byte, index) => bytes[index] === byte)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive magic is invalid.', '$archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(8, true);
  if (count > limits.maxPackageFiles) conversionFail('E_RIVE_CONVERT_LIMIT', 'Archive exceeds file count limit.', '$archive');
  const files: CompiledRiveFile[] = []; let offset = 12; const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 8 > bytes.byteLength) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive entry header is truncated.', `$.archive[${index}]`);
    const pathLength = view.getUint16(offset, true), mediaLength = view.getUint16(offset + 2, true), dataLength = view.getUint32(offset + 4, true); offset += 8;
    if (offset + pathLength + mediaLength + dataLength > bytes.byteLength) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive entry data is truncated.', `$.archive[${index}]`);
    let path: string, mediaType: string;
    try { path = DECODER.decode(bytes.subarray(offset, offset + pathLength)); offset += pathLength; mediaType = DECODER.decode(bytes.subarray(offset, offset + mediaLength)); offset += mediaLength; }
    catch (error) { conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive metadata is not valid UTF-8.', `$.archive[${index}]`, undefined, error); }
    path = normalizePackagePath(path, `$.archive[${index}].path`);
    if (seen.has(path)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive contains a duplicate path.', `$.archive[${index}].path`); seen.add(path);
    const data = new Uint8Array(dataLength); data.set(bytes.subarray(offset, offset + dataLength)); offset += dataLength;
    files.push(Object.freeze({ path, mediaType, bytes: data }));
  }
  if (offset !== bytes.byteLength) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive has trailing bytes.', '$archive');
  const sorted = [...files].sort((left, right) => compareUtf8(left.path, right.path));
  if (files.some((file, index) => file.path !== sorted[index]!.path)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Archive entries are not canonically ordered.', '$archive');
  return Object.freeze(files);
}

async function describeFiles(files: readonly CompiledRiveFile[]): Promise<RivePackageFileEntry[]> {
  const result: RivePackageFileEntry[] = [];
  for (const file of [...files].sort((left, right) => compareUtf8(left.path, right.path))) result.push(Object.freeze({ path: file.path, mediaType: file.mediaType, byteLength: file.bytes.byteLength, sha256: await sha256(file.bytes) }));
  return result;
}
function addFile(files: Map<string, CompiledRiveFile>, file: CompiledRiveFile): void {
  const path = normalizePackagePath(file.path); if (files.has(path)) conversionFail('E_RIVE_CONVERT_FORMAT', `Duplicate package path "${path}".`, '$package.files');
  files.set(path, Object.freeze({ path, mediaType: file.mediaType, bytes: new Uint8Array(file.bytes) }));
}
