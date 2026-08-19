import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CORPUS_ROOT = resolve(ROOT, 'animation-spec/corpus');
export const CACHE_ROOT = resolve(CORPUS_ROOT, '.cache');
export const ASSET_ROOT = resolve(CACHE_ROOT, 'assets');
export const GENERATED_ROOT = resolve(CACHE_ROOT, 'generated');
export const MANIFEST_PATH = resolve(CORPUS_ROOT, 'manifest.json');
export const BROWSER_INPUT_PATH = resolve(CACHE_ROOT, 'browser-input.json');
export const NODE_RESULT_PATH = resolve(CACHE_ROOT, 'node-report.json');
export const CANDIDATE_RESULT_PATH = resolve(CACHE_ROOT, 'candidate-report.json');
export const RESULT_PATH = resolve(CORPUS_ROOT, 'results/latest.json');
export const DASHBOARD_REPORT_PATH = resolve(ROOT, 'examples/hya-lottie-corpus-dashboard/report.json');
export const CAPABILITY_SUPPORT_PATH = resolve(ROOT, 'examples/hya-lottie-corpus-dashboard/capabilities.json');

export function readCorpusManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (
    ![1, 2].includes(manifest.schemaVersion)
    || manifest.corpus !== 'hya-lottie-real-v1'
    || typeof manifest.source?.revision !== 'string'
    || !/^[a-f0-9]{40}$/.test(manifest.source.revision)
    || manifest.source.dataLicense !== 'CC0-1.0'
    || !Array.isArray(manifest.entries)
  ) {
    throw new Error('Invalid HYA Lottie corpus manifest header.');
  }
  const sources = manifest.schemaVersion === 1
    ? { legacy: manifest.source }
    : manifest.sources;
  if (!sources || typeof sources !== 'object' || !sources.legacy) {
    throw new Error('HYA Lottie corpus manifest has no legacy source.');
  }
  for (const [sourceId, source] of Object.entries(sources)) {
    if (
      !sourceId
      || typeof source?.repository !== 'string'
      || typeof source?.revision !== 'string'
      || !/^[a-f0-9]{40}$/.test(source.revision)
      || typeof source?.dataLicense !== 'string'
      || typeof source?.rawBaseUrl !== 'string'
    ) throw new Error(`Invalid HYA Lottie corpus source: ${sourceId}.`);
  }
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty corpus id: ${entry.id}`);
    ids.add(entry.id);
    const sourceId = entry.source?.sourceId ?? 'legacy';
    if (!sources[sourceId]) throw new Error(`Unknown source "${sourceId}" for ${entry.id}.`);
    validateRelativePath(entry.source?.path, `${entry.id}.source.path`);
    validateHash(entry.source?.sha256, `${entry.id}.source.sha256`);
    validateBytes(entry.source?.bytes, `${entry.id}.source.bytes`);
    if (entry.sizeClass !== undefined && !['small', 'large'].includes(entry.sizeClass)) {
      throw new Error(`Invalid sizeClass for ${entry.id}.`);
    }
    if (!['supported', 'degraded', 'unsupported'].includes(entry.expectation)) {
      throw new Error(`Invalid corpus expectation for ${entry.id}.`);
    }
    for (const resource of entry.resources ?? []) {
      validateRelativePath(resource.uri, `${entry.id}.resources.uri`);
      validateRelativePath(resource.path, `${entry.id}.resources.path`);
      validateHash(resource.sha256, `${entry.id}.resources.sha256`);
      validateBytes(resource.bytes, `${entry.id}.resources.bytes`);
      const resourceSourceId = resource.sourceId ?? sourceId;
      if (!sources[resourceSourceId]) throw new Error(`Unknown resource source "${resourceSourceId}" for ${entry.id}.`);
      if (resource.url !== undefined) validateHttpsUrl(resource.url, `${entry.id}.resources.url`);
      if (resource.kind === 'font') validateFontResource(resource, `${entry.id}.resources`);
      else if (resource.kind !== undefined) throw new Error(`Invalid resource kind for ${entry.id}: ${String(resource.kind)}`);
    }
    if (!Array.isArray(entry.frames) || entry.frames.length === 0) {
      throw new Error(`Corpus entry ${entry.id} has no fidelity frames.`);
    }
    for (const frame of entry.frames) {
      if (!Number.isSafeInteger(frame.frame) || frame.frame < 0) {
        throw new Error(`Invalid frame number in ${entry.id}.`);
      }
      validateRelativePath(frame.referencePath, `${entry.id}.frames.referencePath`);
      validateHash(frame.sha256, `${entry.id}.frames.sha256`);
      validateBytes(frame.bytes, `${entry.id}.frames.bytes`);
    }
  }
  return manifest;
}

export function corpusAssetPath(relativePath) {
  validateRelativePath(relativePath, 'asset path');
  const path = resolve(ASSET_ROOT, relativePath);
  if (path !== ASSET_ROOT && !path.startsWith(`${ASSET_ROOT}${sep}`)) {
    throw new Error(`Corpus asset escapes cache root: ${relativePath}`);
  }
  return path;
}

export function generatedHyaPath(id) {
  return resolve(GENERATED_ROOT, `${safeId(id)}.hya`);
}

export function entrySizeClass(entry) {
  return entry.sizeClass === 'large' ? 'large' : 'small';
}

export function entrySource(manifest, entry) {
  const sourceId = entry.source.sourceId ?? 'legacy';
  const source = manifest.sources?.[sourceId] ?? (sourceId === 'legacy' ? manifest.source : null);
  if (!source) throw new Error(`Unknown source "${sourceId}" for ${entry.id}.`);
  return { sourceId, source };
}

export function entrySourceAssetPath(manifest, entry) {
  const { sourceId } = entrySource(manifest, entry);
  return corpusAssetPath(sourceId === 'legacy' ? entry.source.path : `${sourceId}/${entry.source.path}`);
}

export function entryResourceAssetPath(manifest, entry, resource) {
  const { sourceId } = entryResourceSource(manifest, entry, resource);
  return corpusAssetPath(sourceId === 'legacy' ? resource.path : `${sourceId}/${resource.path}`);
}

export function entryResourceSource(manifest, entry, resource) {
  const entrySourceId = entrySource(manifest, entry).sourceId;
  const sourceId = resource.sourceId ?? entrySourceId;
  const source = manifest.sources?.[sourceId] ?? (sourceId === 'legacy' ? manifest.source : null);
  if (!source) throw new Error(`Unknown resource source "${sourceId}" for ${entry.id}.`);
  return { sourceId, source };
}

export function entryFontMappings(manifest, entry) {
  const mappings = {};
  for (const resource of entry.resources ?? []) {
    if (resource.kind !== 'font') continue;
    const uri = projectUrl(entryResourceAssetPath(manifest, entry, resource));
    for (const font of resource.fonts) {
      if (mappings[font.name]) throw new Error(`Duplicate font mapping "${font.name}" for ${entry.id}.`);
      mappings[font.name] = {
        uri,
        family: font.family,
        style: font.style,
        weight: font.weight,
        mimeType: resource.mimeType,
        integrity: resource.sha256,
        metrics: font.metrics,
      };
    }
  }
  return mappings;
}

export function entrySourceUrl(manifest, entry) {
  const { source } = entrySource(manifest, entry);
  return new URL(entry.source.path, source.rawBaseUrl).href;
}

export function frameReferenceAssetPath(frame) {
  if (!frame.referenceKind) return corpusAssetPath(frame.referencePath);
  validateRelativePath(frame.referencePath, 'local reference path');
  const path = resolve(CORPUS_ROOT, frame.referencePath);
  if (path !== CORPUS_ROOT && !path.startsWith(`${CORPUS_ROOT}${sep}`)) {
    throw new Error(`Corpus reference escapes corpus root: ${frame.referencePath}`);
  }
  return path;
}

export function projectUrl(path) {
  const relative = path.slice(ROOT.length).split(sep).join('/');
  return relative.startsWith('/') ? relative : `/${relative}`;
}

export async function syncCorpus(manifest, { offline = false } = {}) {
  mkdirSync(ASSET_ROOT, { recursive: true });
  const files = new Map();
  for (const entry of manifest.entries) {
    const { sourceId, source } = entrySource(manifest, entry);
    addRemoteFile(
      files,
      entrySourceAssetPath(manifest, entry),
      new URL(entry.source.path, source.rawBaseUrl).href,
      entry.source.sha256,
    );
    for (const resource of entry.resources ?? []) {
      const { source: resourceSource } = entryResourceSource(manifest, entry, resource);
      addRemoteFile(
        files,
        entryResourceAssetPath(manifest, entry, resource),
        resource.url ?? new URL(resource.path, resourceSource.rawBaseUrl).href,
        resource.sha256,
      );
    }
    for (const frame of entry.frames) {
      if (frame.referenceKind) {
        addLocalFile(files, frameReferenceAssetPath(frame), frame.sha256);
      } else {
        addRemoteFile(
          files,
          corpusAssetPath(frame.referencePath),
          new URL(frame.referencePath, sourceId === 'legacy' ? manifest.source.rawBaseUrl : source.rawBaseUrl).href,
          frame.sha256,
        );
      }
    }
  }

  let downloaded = 0;
  let reused = 0;
  for (const file of files.values()) {
    const { path, expectedHash } = file;
    if (existsSync(path) && sha256(readFileSync(path)) === expectedHash) {
      reused++;
      continue;
    }
    if (!file.url) throw new Error(`Pinned local corpus reference is missing or stale: ${path}`);
    if (offline) throw new Error(`Corpus cache is missing or stale: ${path}`);
    const url = file.url;
    const response = await fetch(url, {
      headers: { 'user-agent': 'haiyue-hya-corpus/1.0' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(`Corpus hash mismatch for ${path}: expected ${expectedHash}, received ${actualHash}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.download`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
    downloaded++;
  }
  return { files: files.size, downloaded, reused };
}

function addRemoteFile(files, path, url, expectedHash) {
  addFile(files, { path, url, expectedHash });
}

function addLocalFile(files, path, expectedHash) {
  addFile(files, { path, url: null, expectedHash });
}

function addFile(files, file) {
  const previous = files.get(file.path);
  if (previous && (previous.expectedHash !== file.expectedHash || previous.url !== file.url)) {
    throw new Error(`Conflicting corpus asset declarations for ${file.path}.`);
  }
  files.set(file.path, file);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function clearGeneratedCorpus() {
  rmSync(GENERATED_ROOT, { recursive: true, force: true });
  mkdirSync(GENERATED_ROOT, { recursive: true });
}

function safeId(id) {
  return id.replace(/[^a-z0-9._-]+/gi, '__');
}

function validateRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').includes('..')
  ) throw new Error(`Invalid ${label}: ${String(value)}`);
}

function validateHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function validateBytes(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}.`);
}

function validateHttpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${label}: ${String(value)}`); }
  if (parsed.protocol !== 'https:') throw new Error(`Invalid ${label}: only HTTPS is allowed.`);
}

function validateFontResource(resource, label) {
  if (resource.mimeType !== 'font/woff2') throw new Error(`Invalid ${label}.mimeType for a font resource.`);
  if (!Array.isArray(resource.fonts) || resource.fonts.length === 0) {
    throw new Error(`Invalid ${label}.fonts: expected at least one authored-font mapping.`);
  }
  if (resource.license?.spdx !== 'OFL-1.1') throw new Error(`Invalid ${label}.license.spdx.`);
  validateHttpsUrl(resource.license.url, `${label}.license.url`);
  const names = new Set();
  for (const [index, font] of resource.fonts.entries()) {
    const fontLabel = `${label}.fonts[${index}]`;
    if (typeof font?.name !== 'string' || !font.name || names.has(font.name)) {
      throw new Error(`Invalid or duplicate ${fontLabel}.name.`);
    }
    names.add(font.name);
    if (typeof font.family !== 'string' || !font.family) throw new Error(`Invalid ${fontLabel}.family.`);
    if (!['normal', 'italic'].includes(font.style)) throw new Error(`Invalid ${fontLabel}.style.`);
    if (!(typeof font.weight === 'number' || typeof font.weight === 'string')) throw new Error(`Invalid ${fontLabel}.weight.`);
    const metrics = font.metrics;
    if (!metrics || !Number.isFinite(metrics.unitsPerEm) || metrics.unitsPerEm <= 0
      || !Number.isFinite(metrics.ascent) || !Number.isFinite(metrics.descent)) {
      throw new Error(`Invalid ${fontLabel}.metrics.`);
    }
  }
}
