import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { classifyArtifact, createRetentionPlan, resolveRetentionContext, safeArtifactPath, validateRetentionPolicy } from './artifact-retention-policy.mjs';
import { compactRecord, hashFile, readBoundJson, removeVerifiedSources, pruneEmptyArtifactParents, safeSource, validateArtifactRoot, verifyArchive, writeArchive } from './artifact-retention-archive.mjs';

const now = Date.parse('2026-11-03T00:00:00Z');
const old = now - 100 * 3600000;
const policy = {
  schemaVersion: 1, targetBytes: 1000, lowWaterBytes: 700, minimumAgeHours: 72,
  batchBytes: 400, batchFiles: 2, metadataMaximumBytes: 200,
  summaryMaximumBytes: 500, summaryNames: ['report.json'],
  protectedPrefixes: ['.retention/', 'current/'], metadataExtensions: ['.json', '.log'],
  cacheDirectoryNames: ['node_modules', 'checkout'],
};
const file = (path, bytes, mtimeMs = old) => ({ path, bytes, mtimeMs });

test('repository retention preserves fixed WebGPU policy inputs and current performance references', async () => {
  const current = validateRetentionPolicy(JSON.parse(await readFile(new URL('../config/artifact-retention.json', import.meta.url), 'utf8')));
  for (const path of ['webgpu/lighting-scaling-diagnostic.json', 'webgpu/lighting-scaling.json', 'webgpu/planar-reflection.json', 'performance/html-in-canvas-gui-comparison.json']) {
    assert.equal(classifyArtifact(file(path, 3000000), current, now), 'pinned', path);
  }
});

test('alternate workspace artifacts require an explicit policy and retain distinct owner journals', () => {
  const workspace = resolve(tmpdir(), 'haiyue-retention-context');
  const repository = resolve(workspace, 'Engine');
  const defaultContext = resolveRetentionContext(repository);
  assert.equal(defaultContext.root, resolve(repository, 'artifacts'));
  assert.equal(defaultContext.ownerRoot, repository);
  const root = resolve(workspace, 'Native/examples/ios/artifacts');
  const context = resolveRetentionContext(repository, { 'artifact-root': root, policy: resolve(workspace, 'native-policy.json') });
  assert.equal(context.root, root);
  assert.equal(context.ownerRoot, resolve(workspace, 'Native'));
  assert.equal(context.stateRoot, resolve(root, '.retention'));
  assert.throws(() => resolveRetentionContext(repository, { 'artifact-root': root }), /explicit policy/u);
});

test('workspace root selection rejects repository roots, sibling escapes and Git internals', () => {
  const workspace = resolve(tmpdir(), 'haiyue-retention-context');
  const repository = resolve(workspace, 'Engine');
  for (const root of [workspace, repository, resolve(workspace, '../other/artifacts'), resolve(repository, '.git/artifacts')]) {
    assert.throws(() => resolveRetentionContext(repository, { 'artifact-root': root, policy: 'policy.json' }), /Retention root/u);
  }
});

test('retention rejects absolute, traversal, empty, backslash, ADS and control-character paths', () => {
  for (const path of ['/a', '../a', 'a/../b', 'a//b', 'a/./b', 'C:/a', 'a\\b', 'a:stream', 'a/\0b', '']) {
    assert.throws(() => safeArtifactPath(path), /Unsafe/u);
  }
  assert.equal(safeArtifactPath('历史/采样 result.etl'), '历史/采样 result.etl');
});

test('retention validates quota, age, batches and permanent journal protection', () => {
  assert.equal(validateRetentionPolicy(policy), policy);
  for (const change of [{ targetBytes: 0 }, { lowWaterBytes: 1000 }, { batchFiles: 1.5 },
    { protectedPrefixes: ['current/'] }, { protectedPrefixes: ['.retention/', '../'] },
    { metadataExtensions: ['json'] }, { cacheDirectoryNames: ['a/b'] }]) {
    assert.throws(() => validateRetentionPolicy({ ...policy, ...change }));
  }
});

test('current prefixes, exact pins, recent files, future files and links are never evicted', () => {
  assert.equal(classifyArtifact(file('current/capture.etl', 10000), policy, now), 'pinned');
  assert.equal(classifyArtifact(file('elsewhere/input.bin', 10000), policy, now, new Set(['elsewhere/input.bin'])), 'pinned');
  assert.equal(classifyArtifact(file('old/a.bin', 10000, now), policy, now), 'recent');
  assert.equal(classifyArtifact(file('old/a.bin', 10000, now + 1000), policy, now), 'recent');
  assert.equal(classifyArtifact({ ...file('old/link.bin', 10000), link: true }, policy, now), 'link');
});

test('small conclusions remain hot, but dependency metadata is archived losslessly with its cache', () => {
  assert.equal(classifyArtifact(file('old/result.json', 100), policy, now), 'metadata');
  assert.equal(classifyArtifact(file('old/run.log', 100), policy, now), 'metadata');
  assert.equal(classifyArtifact(file('old/node_modules/package/package.json', 100), policy, now), 'archive-cache');
  assert.equal(classifyArtifact(file('old/samples.json', 300), policy, now), 'archive-evidence');
  assert.equal(classifyArtifact(file('old/report.json', 400), policy, now), 'metadata');
});

test('selection releases largest files first and stops below low-water mark', () => {
  const plan = createRetentionPlan([file('old/a.bin', 100), file('old/b.bin', 600), file('old/c.bin', 800)], policy, { nowMs: now });
  assert.equal(plan.beforeBytes, 1500);
  assert.equal(plan.projectedBytes, 700);
  assert.equal(plan.selectedFiles, 1);
  assert.equal(plan.batches[0].files[0].path, 'old/c.bin');
  assert.equal(plan.targetBlocked, false);
});

test('protected data exceeding target is reported without weakening protection', () => {
  const plan = createRetentionPlan([file('current/a.bin', 1200), file('old/a.bin', 800)], policy, { nowMs: now });
  assert.equal(plan.projectedBytes, 1200);
  assert.equal(plan.targetBlocked, true);
  assert.deepEqual(plan.batches.flatMap(batch => batch.files).map(entry => entry.path), ['old/a.bin']);
});

test('below quota is a no-op, batches are bounded except indivisible large files', () => {
  assert.equal(createRetentionPlan([file('old/a.bin', 800)], policy, { nowMs: now }).batches.length, 0);
  const plan = createRetentionPlan([file('a.bin', 600), file('b.bin', 300), file('c.bin', 300), file('d.bin', 300), file('current/a.bin', 1000)], policy, { nowMs: now });
  for (const batch of plan.batches) assert.ok(batch.files.length <= 2 && (batch.bytes <= 400 || batch.files.length === 1));
});

test('malformed, duplicate and case-colliding inventory identities stop planning', () => {
  assert.throws(() => createRetentionPlan([file('a', -1)], policy, { nowMs: now }), /inventory/u);
  assert.throws(() => createRetentionPlan([file('a', 1), file('A', 1)], policy, { nowMs: now }), /Duplicate/u);
});

async function fixture(t, contents = [['old/a.bin', Buffer.from('original bytes')], ['old/empty.bin', Buffer.alloc(0)]]) {
  const directory = await mkdtemp(join(tmpdir(), 'haiyue-retention-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('haiyue-retention-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'artifacts');
  const files = [];
  for (const [identity, bytes] of contents) {
    const target = join(root, ...identity.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    const info = await lstat(target, { bigint: true });
    files.push({ path: identity, bytes: Number(info.size), mtimeMs: Number(info.mtimeNs / 1000000n), kind: 'archive-evidence' });
  }
  const archive = join(directory, 'batch.tar.gz');
  const manifest = await writeArchive(root, files, archive);
  return { directory, root, files, archive, manifest };
}

test('artifact root preflight binds its physical workspace before journal writes', async t => {
  const f = await fixture(t);
  assert.equal(await validateArtifactRoot(f.root, f.directory), await realpath(f.root));
  await assert.rejects(validateArtifactRoot(f.root, join(f.directory, 'unrelated')), /escapes/u);
});

test('artifact root preflight rejects a junction above an otherwise ordinary artifacts folder', async t => {
  const f = await fixture(t);
  const portal = join(f.directory, 'portal');
  await symlink(f.directory, portal, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateArtifactRoot(join(portal, 'artifacts'), f.directory), /symlink\/reparse/u);
  assert.equal(await readFile(join(f.root, 'old/a.bin'), 'utf8'), 'original bytes');
});

test('streaming archive round-trips binary, zero-byte, Unicode and long original identities', async t => {
  const long = '旧诊断/' + Array.from({ length: 8 }, (_, i) => `long-directory-${i}-${'a'.repeat(20)}`).join('/') + '/capture.bin';
  const payload = randomBytes(3 * 1024 * 1024 + 7);
  const f = await fixture(t, [[long, payload], ['empty', Buffer.alloc(0)]]);
  const chunks = [];
  const proof = await verifyArchive(f.archive, f.manifest, { consume: (entry, chunk) => { if (entry.path === long) chunks.push(Buffer.from(chunk)); } });
  assert.equal(proof.files, 2);
  assert.deepEqual(Buffer.concat(chunks), payload);
  const removed = await removeVerifiedSources(f.root, f.manifest.files, proof);
  assert.equal(removed.removedFiles, 2);
  assert.equal((await verifyArchive(f.archive, f.manifest)).files, 2);
});

test('source removal rejects fabricated proof and a proof for a different file inventory', async t => {
  const f = await fixture(t);
  await assert.rejects(removeVerifiedSources(f.root, f.manifest.files, {}), /proof/u);
  const proof = await verifyArchive(f.archive, f.manifest);
  const changed = f.manifest.files.map(entry => ({ ...entry, path: entry.path + '-other' }));
  await assert.rejects(removeVerifiedSources(f.root, changed, proof), /proof/u);
  assert.equal((await readFile(join(f.root, 'old/a.bin'))).toString(), 'original bytes');
});

test('corrupt/truncated compressed bytes fail readback while originals remain', async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.archive);
  await writeFile(f.archive, bytes.subarray(0, bytes.length - 4));
  await assert.rejects(verifyArchive(f.archive, f.manifest));
  assert.equal((await readFile(join(f.root, 'old/a.bin'))).toString(), 'original bytes');
});

test('wrong compressed SHA, wrong member and wrong file SHA all stop verification', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyArchive(f.archive, { ...f.manifest, archiveSha256: '0'.repeat(64) }), /Compressed/u);
  const changedMember = { ...f.manifest, files: f.manifest.files.map(entry => ({ ...entry, member: '../unsafe' })) };
  await assert.rejects(verifyArchive(f.archive, changedMember), /member/u);
  const changedHash = { ...f.manifest, files: f.manifest.files.map(entry => ({ ...entry, sha256: '0'.repeat(64) })) };
  await assert.rejects(verifyArchive(f.archive, changedHash), /SHA-256/u);
});

test('changed original, including same-length content with restored timestamp, is retained', async t => {
  const f = await fixture(t);
  const proof = await verifyArchive(f.archive, f.manifest);
  const source = join(f.root, 'old/a.bin');
  const before = await lstat(source);
  await writeFile(source, 'modified bytes');
  await utimes(source, before.atime, before.mtime);
  await assert.rejects(removeVerifiedSources(f.root, f.manifest.files, proof), /changed source/u);
  assert.equal((await readFile(source)).toString(), 'modified bytes');
});

test('archive changed after readback invalidates its removal proof', async t => {
  const f = await fixture(t);
  const proof = await verifyArchive(f.archive, f.manifest);
  await writeFile(f.archive, 'changed');
  await assert.rejects(removeVerifiedSources(f.root, f.manifest.files, proof), /proof/u);
  assert.equal((await readFile(join(f.root, 'old/a.bin'))).toString(), 'original bytes');
});

test('interrupted source removal resumes from verified archive with absent originals accounted for', async t => {
  const f = await fixture(t);
  await verifyArchive(f.archive, f.manifest);
  await rm(join(f.root, 'old/a.bin'));
  const freshProof = await verifyArchive(f.archive, f.manifest);
  const removed = await removeVerifiedSources(f.root, f.manifest.files, freshProof);
  assert.equal(removed.alreadyAbsent, 1);
  assert.equal(removed.removedFiles, 1);
});

test('changed source since plan is not archived and is never removed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'old/a.bin'), 'updated original with a different length');
  await assert.rejects(writeArchive(f.root, f.files, join(f.directory, 'another.tar.gz')), /changed since plan/u);
  assert.ok((await readFile(join(f.root, 'old/a.bin'))).length > f.files[0].bytes);
});

test('a source changed after bounded prefetch aborts the batch and retains every original', async t => {
  const large = Buffer.alloc(1024 * 1024, 65);
  const small = Buffer.alloc(4096, 66);
  const f = await fixture(t, [['old/large.bin', large], ['old/prefetched.bin', small]]);
  let changed = false;
  await assert.rejects(writeArchive(f.root, f.files, join(f.directory, 'changed-during-prefetch.tar.gz'), event => {
    if (!changed && event.phase === 'compress') {
      changed = true;
      writeFileSync(join(f.root, 'old/prefetched.bin'), Buffer.alloc(small.length + 1, 67));
    }
  }), /Source changed/u);
  assert.deepEqual(await readFile(join(f.root, 'old/large.bin')), large);
  assert.equal((await readFile(join(f.root, 'old/prefetched.bin'))).length, small.length + 1);
});

test('symlink/junction ancestors cannot redirect source reads or deletion', async t => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.bin'), 'outside');
  const originalHash = await hashFile(join(outside, 'secret.bin'));
  await symlink(outside, join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safeSource(f.root, 'redirect/secret.bin'), /Reparse|symlink/u);
  await assert.rejects(safeSource(f.root, '../outside/secret.bin'), /Unsafe/u);
  assert.equal(await hashFile(join(outside, 'secret.bin')), originalHash);
});

test('completed large plan records compact with SHA-256 proof and remain directly readable', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'plan.json');
  const value = { schemaVersion: 1, files: Array.from({ length: 2000 }, (_, i) => ({ path: `repeated-directory/${i}`, bytes: i })) };
  await writeFile(path, JSON.stringify(value, null, 2));
  const originalHash = await hashFile(path);
  const compressed = await compactRecord(path);
  assert.deepEqual(await readBoundJson(compressed), value);
  const proof = await readBoundJson(path + '.compression.json');
  assert.equal(proof.originalSha256, originalHash);
  assert.equal(proof.gzipSha256, await hashFile(compressed));
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await compactRecord(path), compressed);
});

test('a conflicting compressed record never replaces or removes the original plan', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'plan.json');
  await writeFile(path, '{"original":true}');
  await writeFile(path + '.gz', 'corrupt');
  await assert.rejects(compactRecord(path));
  assert.equal((await readFile(path)).toString(), '{"original":true}');
});

test('empty-directory collection only visits archived ancestors and preserves metadata and root', async t => {
  const f = await fixture(t);
  const proof = await verifyArchive(f.archive, f.manifest);
  await removeVerifiedSources(f.root, f.manifest.files, proof);
  await mkdir(join(f.root, 'unrelated-empty'));
  await writeFile(join(f.root, 'conclusion.json'), '{}');
  assert.equal(await pruneEmptyArtifactParents(f.root, f.manifest.files), 1);
  assert.ok((await lstat(f.root)).isDirectory());
  assert.ok((await lstat(join(f.root, 'unrelated-empty'))).isDirectory());
  assert.equal((await readFile(join(f.root, 'conclusion.json'))).toString(), '{}');
});

test('directory collection cannot follow reparse ancestors or remove nonempty folders', async t => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside-empty');
  await mkdir(join(outside, 'child'), { recursive: true });
  await symlink(outside, join(f.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await pruneEmptyArtifactParents(f.root, [file('redirect/child/old.bin', 0), ...f.files]), 0);
  assert.ok((await lstat(join(outside, 'child'))).isDirectory());
  assert.ok((await lstat(join(f.root, 'redirect'))).isSymbolicLink());
});

test('parallel sibling collection finishes children before their common parent', async t => {
  const f = await fixture(t, Array.from({ length: 12 }, (_, index) => [`old/branch-${index}/leaf/value.bin`, Buffer.from('payload')]));
  const proof = await verifyArchive(f.archive, f.manifest);
  await removeVerifiedSources(f.root, f.manifest.files, proof);
  assert.equal(await pruneEmptyArtifactParents(f.root, f.manifest.files), 25);
  await assert.rejects(lstat(join(f.root, 'old')), { code: 'ENOENT' });
  assert.ok((await lstat(f.root)).isDirectory());
});
