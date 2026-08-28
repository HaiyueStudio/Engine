import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assertFormalRepositoryIdentity, captureRepositoryIdentity } from '../formal-evidence/repository-identity.mjs';

const MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const HASH = /^[a-f0-9]{64}$/u;
const CLOSURE_SCANS = Object.freeze(['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests']);

export function scanRiveBrowserClosure({ denyList, artifacts }) {
  const scans = [];
  for (const artifact of artifacts) {
    if (!artifact.path || !existsSync(artifact.path)) {
      scans.push({
        name: artifact.name,
        status: 'not-run',
        reason: 'Artifact path was not supplied or does not exist.',
        sha256: null,
        forbiddenPackageCount: null,
        forbiddenFileCount: null,
        forbiddenStaticPatternCount: null,
        forbiddenNetworkCount: null,
        rawRivCount: null,
      });
      continue;
    }
    if (artifact.name === 'networkRequests') scans.push(scanNetwork(artifact, denyList));
    else scans.push(scanFiles(artifact, denyList));
  }
  return Object.freeze({
    officialOracleBuildTimeOnly: true,
    unclassifiedFailureCount: 0,
    scans: Object.freeze(scans),
  });
}

export function validateRiveBrowserClosureReport(report, { formal = false, expectedRevision = null } = {}) {
  const violations = [];
  equal(report?.schemaVersion, 1, 'schemaVersion');
  equal(report?.kind, 'haiyue-rive-browser-closure-scan', 'kind');
  if (!['passed', 'failed', 'incomplete'].includes(report?.status)) violations.push('status is invalid');
  if (typeof report?.formalEvidence !== 'boolean') violations.push('formalEvidence must be boolean');
  if (!Number.isFinite(Date.parse(report?.generatedAt ?? ''))) violations.push('generatedAt is invalid');
  if (!/^[a-f0-9]{40}$/u.test(report?.engineRevision ?? '')) violations.push('Engine revision is invalid');
  if (expectedRevision) equal(report?.engineRevision, expectedRevision, 'expected Engine revision');
  if (typeof report?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  equal(report?.evidenceClass, report?.engineDirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate', 'evidence class');
  if (typeof report?.nodeVersion !== 'string' || !/^v\d+\./u.test(report.nodeVersion)) violations.push('Node version identity is missing');
  if (!HASH.test(report?.denyListSha256 ?? '')) violations.push('deny-list hash is invalid');
  equal(report?.officialOracleBuildTimeOnly, true, 'official oracle build-time boundary');
  equal(report?.unclassifiedFailureCount, 0, 'unclassified failure count');
  if (!Array.isArray(report?.scans)) violations.push('scans must be an array');
  const scans = Array.isArray(report?.scans) ? report.scans : [];
  const names = new Set();
  for (const scan of scans) {
    if (names.has(scan?.name)) violations.push(`duplicate closure scan ${String(scan?.name)}`);
    names.add(scan?.name);
    if (!CLOSURE_SCANS.includes(scan?.name)) violations.push(`unknown closure scan ${String(scan?.name)}`);
    if (!['passed', 'failed', 'not-run'].includes(scan?.status)) violations.push(`${String(scan?.name)} status is invalid`);
    if (scan?.status === 'not-run') {
      if (typeof scan?.reason !== 'string' || scan.reason.trim() === '') violations.push(`${String(scan?.name)} not-run reason is missing`);
      continue;
    }
    if (!HASH.test(scan?.sha256 ?? '')) violations.push(`${String(scan?.name)} artifact hash is invalid`);
    for (const key of ['forbiddenPackageCount', 'forbiddenFileCount', 'forbiddenStaticPatternCount', 'forbiddenNetworkCount', 'rawRivCount']) {
      nonnegativeInteger(scan?.[key], `${String(scan?.name)} ${key}`);
      if (scan?.status === 'passed') equal(scan?.[key], 0, `${String(scan?.name)} ${key}`);
    }
  }
  for (const name of CLOSURE_SCANS) if (!names.has(name)) violations.push(`missing closure scan ${name}`);
  const failed = scans.some(scan => scan?.status === 'failed');
  const notRun = scans.some(scan => scan?.status === 'not-run');
  equal(report?.status, failed ? 'failed' : notRun ? 'incomplete' : 'passed', 'derived closure status');
  if (formal) {
    equal(report?.formalEvidence, true, 'formal evidence identity');
    equal(report?.engineDirty, false, 'formal Engine dirty state');
    if (Number(String(report?.nodeVersion).replace(/^v/u, '').split('.')[0]) < 22) violations.push('formal closure evidence requires Node.js 22 or later');
    equal(report?.status, 'passed', 'formal closure status');
    for (const name of CLOSURE_SCANS) equal(scans.find(value => value.name === name)?.status, 'passed', `${name} formal status`);
  }
  return Object.freeze({ schemaVersion: 1, contract: 'haiyue-rive-browser-closure-scan@1', mode: formal ? 'formal' : 'diagnostic', status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations) });

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function nonnegativeInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 0) violations.push(`${label} is invalid`); }
}

function scanFiles(artifact, denyList) {
  const paths = statSync(artifact.path).isDirectory() ? walk(artifact.path) : [artifact.path];
  const directory = statSync(artifact.path).isDirectory();
  const physicalFiles = paths.map(path => ({ path, relative: directory ? relative(artifact.path, path).split('\\').join('/') : basename(path), bytes: readFileSync(path) }));
  const archiveErrors = [];
  const files = physicalFiles.flatMap(file => expandArchive(file, archiveErrors));
  const fileMatches = [];
  const packageMatches = [];
  const staticMatches = [];
  let rawRivCount = 0;
  for (const file of files) {
    const normalized = file.relative.toLowerCase();
    if (normalized.endsWith('.riv')) rawRivCount++;
    for (const pattern of denyList.forbiddenFileGlobs) {
      if (matchesFileGlob(normalized, pattern.toLowerCase())) fileMatches.push({ path: file.relative, pattern });
    }
    if (!isTextFile(file.relative, file.bytes)) continue;
    const text = file.bytes.toString('utf8');
    for (const pattern of denyList.forbiddenPackages) {
      if (text.includes(pattern)) packageMatches.push({ path: file.relative, pattern });
    }
    for (const pattern of denyList.forbiddenStaticPatterns) {
      if (text.includes(pattern)) staticMatches.push({ path: file.relative, pattern });
    }
  }
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.relative.localeCompare(right.relative))) {
    digest.update(`${file.relative}\0${file.bytes.byteLength}\0`);
    digest.update(file.bytes);
  }
  const failed = fileMatches.length + packageMatches.length + staticMatches.length + rawRivCount + archiveErrors.length > 0;
  return {
    name: artifact.name,
    status: failed ? 'failed' : 'passed',
    sha256: digest.digest('hex'),
    fileCount: files.length,
    byteLength: files.reduce((total, file) => total + file.bytes.byteLength, 0),
    physicalByteLength: physicalFiles.reduce((total, file) => total + file.bytes.byteLength, 0),
    archiveErrorCount: archiveErrors.length,
    forbiddenPackageCount: packageMatches.length,
    forbiddenFileCount: fileMatches.length,
    forbiddenStaticPatternCount: staticMatches.length,
    forbiddenNetworkCount: 0,
    rawRivCount,
    matches: { packages: packageMatches, files: fileMatches, staticPatterns: staticMatches, network: [], archiveErrors },
  };
}

function expandArchive(file, errors) {
  if (!/\.(?:tgz|tar\.gz)$/iu.test(file.relative)) return [file];
  try {
    const tar = gunzipSync(file.bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
    return parseTar(tar, file);
  } catch (error) {
    errors.push({ path: file.relative, message: boundedMessage(error) });
    return [];
  }
}

function parseTar(tar, archive) {
  const files = [];
  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(value => value === 0)) break;
    const size = tarOctal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.byteLength) throw new Error('tar entry size is invalid');
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const headerPath = tarPath(header);
    if (type === 'x') {
      pendingPath = parsePaxPath(body) ?? pendingPath;
      continue;
    }
    if (type === 'L') {
      pendingPath = nullTerminated(body);
      continue;
    }
    const path = pendingPath ?? headerPath;
    pendingPath = null;
    if (type === '5') continue;
    if (!['0', '\0'].includes(type)) throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${path}`);
    validateArchivePath(path);
    if (files.length >= MAX_ARCHIVE_ENTRIES) throw new Error(`tar entry count exceeds ${MAX_ARCHIVE_ENTRIES}`);
    files.push({ path: archive.path, relative: `${archive.relative}!/${path}`, bytes: Buffer.from(body) });
  }
  if (files.length === 0) throw new Error('tar archive contains no regular files');
  return files;
}

function tarPath(header) {
  const name = nullTerminated(header.subarray(0, 100));
  const prefix = nullTerminated(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function tarOctal(bytes) {
  const value = nullTerminated(bytes).trim().replace(/^0+/u, '');
  if (value === '') return 0;
  if (!/^[0-7]+$/u.test(value)) return Number.NaN;
  return Number.parseInt(value, 8);
}

function parsePaxPath(bytes) {
  const text = bytes.toString('utf8');
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' ');
    const assignment = separator >= 0 ? line.slice(separator + 1) : line;
    if (assignment.startsWith('path=')) return assignment.slice(5);
  }
  return null;
}

function nullTerminated(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.byteLength : end).toString('utf8');
}

function validateArchivePath(path) {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.split('/').includes('..')) throw new Error(`unsafe tar entry path ${JSON.stringify(path)}`);
}

function boundedMessage(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/gu, ' ').slice(0, 256);
}

function scanNetwork(artifact, denyList) {
  const bytes = readFileSync(artifact.path);
  const value = JSON.parse(bytes.toString('utf8'));
  const requests = Array.isArray(value) ? value : value.requests ?? value.files ?? [];
  const urls = requests.map(item => typeof item === 'string' ? item : item.url ?? item.requestUrl ?? item.sourcePath).filter(value => typeof value === 'string');
  const matches = [];
  let rawRivCount = 0;
  for (const url of urls) {
    const pathname = safePathname(url).toLowerCase();
    if (pathname.endsWith('.riv')) rawRivCount++;
    for (const suffix of denyList.forbiddenNetworkSuffixes) {
      if (pathname.endsWith(suffix.toLowerCase())) matches.push({ url, pattern: suffix });
    }
  }
  const failed = matches.length > 0 || rawRivCount > 0;
  return {
    name: artifact.name,
    status: failed ? 'failed' : 'passed',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    requestCount: urls.length,
    byteLength: bytes.byteLength,
    forbiddenPackageCount: 0,
    forbiddenFileCount: 0,
    forbiddenStaticPatternCount: 0,
    forbiddenNetworkCount: matches.length,
    rawRivCount,
    matches: { packages: [], files: [], staticPatterns: [], network: matches },
  };
}

function matchesFileGlob(path, glob) {
  if (glob === '**/*.riv') return path.endsWith('.riv');
  const suffix = glob.replace(/^\*\*\//u, '').replace(/^\*/u, '');
  return path.endsWith(suffix);
}

function isTextFile(path, bytes) {
  if (bytes.includes(0)) return false;
  return ['.js', '.mjs', '.cjs', '.map', '.json', '.html', '.css', '.txt'].includes(extname(path).toLowerCase());
}

function safePathname(value) {
  try { return new URL(value, 'http://local.invalid').pathname; } catch { return value; }
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const formal = process.argv.includes('--formal');
  if (formal && Number(process.versions.node.split('.')[0]) < 22) throw new Error('Formal Rive browser closure requires Node.js 22 or later.');
  const repositoryStart = captureRepositoryIdentity(root);
  if (formal) assertFormalRepositoryIdentity(repositoryStart, repositoryStart, { label: 'Engine' });
  const denyPath = resolve(root, 'docs/for-ai/rive-hya/browser-runtime-deny-list.json');
  const denyBytes = readFileSync(denyPath);
  const denyList = JSON.parse(denyBytes.toString('utf8'));
  const definitions = [
    ['packedPlayerTarball', '--packed-player'],
    ['browserBundle', '--browser-bundle'],
    ['sourceMap', '--source-map'],
    ['networkRequests', '--network-log'],
  ];
  const closure = scanRiveBrowserClosure({
    denyList,
    artifacts: definitions.map(([name, argument]) => ({ name, path: readArgument(argument) ? resolve(readArgument(argument)) : null })),
  });
  const failed = closure.scans.filter(value => value.status === 'failed');
  const notRun = closure.scans.filter(value => value.status === 'not-run');
  const report = {
    schemaVersion: 1,
    kind: 'haiyue-rive-browser-closure-scan',
    status: failed.length > 0 ? 'failed' : notRun.length > 0 ? 'incomplete' : 'passed',
    formalEvidence: formal && failed.length === 0 && notRun.length === 0,
    generatedAt: new Date().toISOString(),
    engineRevision: repositoryStart.revision,
    engineDirty: repositoryStart.dirty,
    evidenceClass: repositoryStart.dirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
    nodeVersion: process.version,
    denyListSha256: createHash('sha256').update(denyBytes).digest('hex'),
    ...closure,
  };
  const validation = validateRiveBrowserClosureReport(report, { formal, expectedRevision: repositoryStart.revision });
  if (validation.status !== 'passed') throw new Error(`Rive browser closure report failed ${validation.mode} validation:\n- ${validation.violations.join('\n- ')}`);
  if (formal) assertFormalRepositoryIdentity(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' });
  const output = readArgument('--out');
  if (output) {
    const outputPath = resolve(root, output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`[rive-closure] passed=${report.scans.filter(value => value.status === 'passed').length}, failed=${failed.length}, not-run=${report.scans.filter(value => value.status === 'not-run').length}.`);
  if (failed.length > 0) throw new Error(`Rive browser closure contains forbidden material: ${failed.map(value => value.name).join(', ')}.`);
}

function readArgument(name) {
  return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
