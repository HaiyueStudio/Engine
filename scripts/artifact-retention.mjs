import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, unlink, statfs, link } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, setPriority } from 'node:os';
import { createGunzip } from 'node:zlib';
import { classifyArtifact, createRetentionPlan, resolveRetentionContext, safeArtifactPath, validateRetentionPolicy } from './artifact-retention-policy.mjs';
import { compactRecord, durableJson, hashFile, readBoundJson, removeVerifiedSources, pruneEmptyArtifactParents, sha256, validateArtifactRoot, verifyArchive, writeArchive } from './artifact-retention-archive.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let { root, stateRoot, policyPath, ownerRoot } = resolveRetentionContext(repository);

function parseArguments(argv) {
  const action = argv.shift() ?? 'plan';
  if (!['plan', 'apply', 'maintain', 'verify', 'restore', 'status', 'recover-lock'].includes(action)) throw new Error(`Unknown retention action ${action}`);
  const options = {};
  for (const argument of argv) {
    const match = /^--(cold-root|inventory|plan|path|output|max-batches|artifact-root|policy)=(.+)$/u.exec(argument);
    if (!match || options[match[1]]) throw new Error(`Unknown/duplicate option ${argument}`);
    options[match[1]] = match[2];
  }
  if (options['max-batches'] && !/^[1-9][0-9]*$/u.test(options['max-batches'])) throw new Error('Invalid max-batches');
  return { action, options };
}

async function inventory(path) {
  const result = [];
  if (path) {
    const input = createReadStream(resolve(path));
    const decoded = path.endsWith('.gz') ? input.pipe(createGunzip()) : input;
    const lines = createInterface({ input: decoded, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const value = JSON.parse(line.replace(/("mtimeNs"\s*:\s*)([0-9]+)/u, '$1"$2"'));
        result.push({ path: value.path, bytes: value.bytes, mtimeMs: value.mtimeMs ?? Number(BigInt(value.mtimeNs) / 1000000n) });
      }
    } finally { lines.close(); input.destroy(); decoded.destroy(); }
  } else {
    let last = Date.now();
    async function walk(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const identity = prefix + entry.name;
        if (entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path, `${identity}/`);
        else if (entry.isFile()) {
          const info = await lstat(path, { bigint: true });
          result.push({ path: identity, bytes: Number(info.size), mtimeMs: Number(info.mtimeNs / 1000000n) });
        }
        if (Date.now() - last > 15000) { console.log(JSON.stringify({ phase: 'inventory', files: result.length, path: identity })); last = Date.now(); }
      }
    }
    await walk(root);
  }
  return result;
}

async function validateColdRoot(path) {
  const destination = resolve(path);
  const rel = relative(root, destination);
  const repoRelative = relative(ownerRoot, destination);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) || dirname(destination) === destination ||
      !repoRelative || (!repoRelative.startsWith(`..${sep}`) && repoRelative !== '..' && !isAbsolute(repoRelative)) ||
      destination.split(/[\\/]/u).some(part => part.toLowerCase() === '.git')) {
    throw new Error('Cold archive must be outside artifacts and must not be a drive root');
  }
  // Do not allow an existing junction/symlink to redirect cold writes.
  let current = destination;
  while (dirname(current) !== current) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Reparse/symlink cold archive: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  return destination;
}

function shortPlan(plan) {
  return { status: plan.targetBlocked ? 'protected-data-exceeds-target' : plan.selectedFiles ? 'planned' : 'within-target',
    plan: plan.planPath, beforeBytes: plan.beforeBytes, projectedBytes: plan.projectedBytes,
    targetBytes: plan.targetBytes, selectedFiles: plan.selectedFiles, batches: plan.batches.length,
    selectedBytes: plan.selectedBytes, protected: plan.counts, coldRoot: plan.coldRoot };
}

async function prepare(options, policy, policyHash) {
  const coldRoot = await validateColdRoot(options['cold-root'] ?? resolve(repository, '../_archives/engine-artifact-retention'));
  const files = await inventory(options.inventory);
  const selection = createRetentionPlan(files, policy);
  const core = { ...selection, artifactRoot: root, coldRoot, policySha256: policyHash };
  const id = sha256(JSON.stringify(core)).slice(0, 24);
  const planPath = resolve(stateRoot, 'plans', `${id}.json`);
  const plan = { ...core, id, planPath };
  await durableJson(planPath, plan, { exclusive: true });
  console.log(JSON.stringify(shortPlan(plan)));
  return plan;
}

async function receipts() {
  const folder = resolve(stateRoot, 'receipts');
  try { return (await readdir(folder)).filter(name => /^[a-f0-9]{24}-[0-9]{5}\.json$/u.test(name)).sort().map(name => resolve(folder, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function boundReceipt(path) {
  const receipt = await readBoundJson(path);
  await validateColdRoot(receipt.coldRoot);
  const manifestPath = resolve(receipt.coldRoot, receipt.manifest);
  if (!/^[a-f0-9]{24}-[0-9]{5}\.json$/u.test(receipt.manifest)) throw new Error('Unsafe manifest identity');
  const manifest = await readBoundJson(manifestPath, receipt.manifestSha256);
  if (!/^[a-f0-9]{24}-[0-9]{5}\.tar\.gz$/u.test(manifest.archive) || manifest.artifactRoot !== root) throw new Error('Unsafe archive binding');
  return { receipt, manifest, archive: resolve(receipt.coldRoot, manifest.archive) };
}

function progressPrinter(batch) {
  let last = 0;
  return value => { if (Date.now() - last > 15000) { console.log(JSON.stringify({ batch, ...value })); last = Date.now(); } };
}

async function checkSpace(destination, bytes) {
  // The archive is streamed directly to cold storage, never through the nearly-full source drive.
  try {
    const info = await statfs(destination, { bigint: true });
    const available = info.bavail * info.bsize;
    if (available < BigInt(Math.ceil(bytes * 1.02) + 128 * 1024 * 1024)) throw new Error('Insufficient cold-storage space for next batch');
  } catch (error) { if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error; }
}

async function apply(plan, policy, policyHash, options) {
  const { id: planId, planPath: _planPath, ...core } = plan;
  if (plan.schemaVersion !== 1 || plan.artifactRoot !== root || plan.policySha256 !== policyHash ||
      !/^[a-f0-9]{24}$/u.test(plan.id) || !Array.isArray(plan.batches) ||
      sha256(JSON.stringify(core)).slice(0, 24) !== planId) throw new Error('Plan identity/root/policy binding mismatch');
  const coldRoot = await validateColdRoot(plan.coldRoot);
  await mkdir(coldRoot, { recursive: true });
  await mkdir(resolve(stateRoot, 'receipts'), { recursive: true });
  let done = 0, executed = 0, removedBytes = 0, removedFiles = 0, completedBytes = 0, completedFiles = 0;
  const batchLimit = Number(options['max-batches'] ?? Infinity);
  for (let index = 0; index < plan.batches.length; index++) {
    await validateArtifactRoot(root, dirname(repository));
    const batch = plan.batches[index];
    for (const file of batch.files) {
      if (!classifyArtifact(file, policy, Date.now()).startsWith('archive-')) throw new Error(`Plan attempts to evict protected data: ${file.path}`);
    }
    const id = `${plan.id}-${index.toString().padStart(5, '0')}`;
    const receiptPath = resolve(stateRoot, 'receipts', `${id}.json`);
    const completionPath = resolve(stateRoot, 'receipts', `${id}.removed.json`);
    try {
      const completed = await readBoundJson(completionPath);
      if (completed.planId !== plan.id || completed.batch !== index) throw new Error('Invalid completion receipt');
      done++;
      completedBytes += batch.bytes; completedFiles += batch.files.length;
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (executed >= batchLimit) break;
    const progress = progressPrinter(id);
    const manifestPath = resolve(coldRoot, `${id}.json`);
    const archivePath = resolve(coldRoot, `${id}.tar.gz`);
    const statePath = resolve(coldRoot, `${id}.packing.json`);
    let manifest, proof;
    try {
      manifest = await readBoundJson(manifestPath);
      if (manifest.schemaVersion !== 1 || manifest.artifactRoot !== root || manifest.archive !== `${id}.tar.gz` ||
          manifest.planId !== plan.id || manifest.batch !== index ||
          JSON.stringify(manifest.files.map(({ path, bytes, mtimeMs, kind }) => ({ path, bytes, mtimeMs, kind }))) !==
          JSON.stringify(batch.files.map(({ path, bytes, mtimeMs, kind }) => ({ path, bytes, mtimeMs, kind })))) throw new Error('Existing archive does not match this plan');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A crash before the durable manifest cannot have removed any sources. Only our bound incomplete batch may be retried.
      try {
        const packing = await readBoundJson(statePath);
        if (packing.planId !== plan.id || packing.batch !== index) throw new Error('Unbound incomplete archive');
        try { await unlink(archivePath); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
        try { await lstat(archivePath); throw new Error('Archive exists without a transaction record'); }
        catch (found) { if (found.code !== 'ENOENT') throw found; }
      }
      await checkSpace(coldRoot, batch.bytes);
      await durableJson(statePath, { schemaVersion: 1, planId: plan.id, batch: index, phase: 'packing' });
      console.log(JSON.stringify({ phase: 'batch-start', batch: id, files: batch.files.length, bytes: batch.bytes }));
      const packed = await writeArchive(root, batch.files, archivePath, progress);
      manifest = { schemaVersion: 1, planId: plan.id, batch: index, artifactRoot: root,
        archive: `${id}.tar.gz`, ...packed };
      proof = await verifyArchive(archivePath, manifest, { progress });
      await durableJson(manifestPath, manifest, { exclusive: true });
    }
    // On resume verify the archive again, even when some original files have already been removed.
    proof ??= await verifyArchive(archivePath, manifest, { progress });
    const manifestSha256 = await hashFile(manifestPath);
    await durableJson(receiptPath, { schemaVersion: 1, planId: plan.id, batch: index, coldRoot,
      manifest: `${id}.json`, manifestSha256, verified: proof, verifiedAt: new Date().toISOString() });
    const removed = await removeVerifiedSources(root, manifest.files, proof, progress);
    await durableJson(completionPath, { schemaVersion: 1, planId: plan.id, batch: index,
      manifestSha256, ...removed, completedAt: new Date().toISOString() });
    removedBytes += removed.removedBytes; removedFiles += removed.removedFiles; done++; executed++;
    completedBytes += batch.bytes; completedFiles += batch.files.length;
    console.log(JSON.stringify({ phase: 'batch-complete', batch: id, ...proof, ...removed }));
  }
  const removedDirectories = done === plan.batches.length ? await pruneEmptyArtifactParents(root, plan.batches.flatMap(batch => batch.files), progressPrinter('finalize')) : 0;
  const planPath = done === plan.batches.length ? await compactRecord(resolve(stateRoot, 'plans', `${plan.id}.json`)) : plan.planPath;
  const summary = { status: done === plan.batches.length ? 'completed' : 'paused-between-batches', planId: plan.id, planPath,
    doneBatches: done, totalBatches: plan.batches.length, removedFiles: completedFiles, removedBytes: completedBytes, removedDirectories,
    invocationRemovedFiles: removedFiles, invocationRemovedBytes: removedBytes,
    projectedBytes: plan.projectedBytes, targetBlocked: plan.targetBlocked, coldRoot,
    originalEvidencePreserved: true, runtimeOrAcceptanceBudgetsChanged: false };
  await durableJson(resolve(stateRoot, 'last-apply.json'), summary);
  console.log(JSON.stringify(summary));
}

async function verifyAll() {
  let files = 0, bytes = 0, archives = 0;
  for (const path of await receipts()) {
    const { manifest, archive } = await boundReceipt(path);
    const proof = await verifyArchive(archive, manifest, { progress: progressPrinter(manifest.archive) });
    files += proof.files; bytes += proof.bytes; archives++;
    console.log(JSON.stringify({ archive: manifest.archive, status: 'verified', ...proof }));
  }
  console.log(JSON.stringify({ status: 'verified', archives, files, bytes }));
}

async function restoreOne(options) {
  const identity = safeArtifactPath(options.path);
  for (const path of await receipts()) {
    const { manifest, archive } = await boundReceipt(path);
    const file = manifest.files.find(entry => entry.path === identity);
    if (!file) continue;
    const destination = resolve(options.output ?? resolve(root, ...identity.split('/')));
    // Existing destinations must never be overwritten, even if they contain identical bytes.
    try { await lstat(destination); throw new Error(`Restore destination already exists: ${destination}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), { recursive: true });
    // Validate the newly created destination ancestors before opening a file.
    let ancestor = dirname(destination);
    while (dirname(ancestor) !== ancestor) {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Restore destination has a symlink/reparse ancestor');
      ancestor = dirname(ancestor);
    }
    const temporary = `${destination}.restore-${process.pid}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await verifyArchive(archive, manifest, { consume: async (entry, chunk) => { if (entry.path === identity) await handle.writeFile(chunk); },
        progress: progressPrinter(manifest.archive) });
      await handle.sync(); await handle.close();
      if (await hashFile(temporary) !== file.sha256) throw new Error('Restored file SHA-256 mismatch');
      // Same-directory hard linking installs the fully verified file atomically and never overwrites.
      await link(temporary, destination);
      await unlink(temporary);
      console.log(JSON.stringify({ status: 'restored', path: identity, destination, sha256: file.sha256, bytes: file.bytes }));
      return;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }
  throw new Error(`No verified cold archive for ${identity}`);
}

async function main() {
  const { action, options } = parseArguments(process.argv.slice(2));
  ({ root, stateRoot, policyPath, ownerRoot } = resolveRetentionContext(repository, options));
  await validateArtifactRoot(root, dirname(repository));
  const policyBytes = await readFile(policyPath);
  const policy = validateRetentionPolicy(JSON.parse(policyBytes));
  const policyHash = sha256(policyBytes);
  try { setPriority(0, constants.priority.PRIORITY_NORMAL); }
  catch (error) { console.log(JSON.stringify({ phase: 'priority', status: 'unavailable', code: error.code })); }
  await mkdir(stateRoot, { recursive: true });
  const lockPath = resolve(stateRoot, 'owner.lock.json');
  if (action === 'recover-lock') {
    const owner = await readBoundJson(lockPath);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid owner PID; inspect lock manually');
    try { process.kill(owner.pid, 0); throw new Error(`Retention owner PID ${owner.pid} is still alive; lock retained`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lockPath);
    console.log(JSON.stringify({ status: 'recovered-dead-owner-lock', pid: owner.pid }));
    return;
  }
  const lock = await open(lockPath, 'wx').catch(error => { throw new Error(`Retention owner lock exists: ${lockPath}. Check its PID before recovering it. ${error.message}`); });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), action })); await lock.sync();
    if (action === 'plan' || action === 'maintain') {
      const plan = await prepare(options, policy, policyHash);
      if (action === 'maintain') await apply(plan, policy, policyHash, options);
    } else if (action === 'apply') {
      if (!options.plan) throw new Error('apply requires --plan=PATH');
      await apply(await readBoundJson(resolve(options.plan)), policy, policyHash, options);
    } else if (action === 'verify') await verifyAll();
    else if (action === 'restore') await restoreOne(options);
    else {
      const files = await inventory(options.inventory);
      const plan = createRetentionPlan(files, policy);
      console.log(JSON.stringify(shortPlan({ ...plan, coldRoot: options['cold-root'] })));
    }
  } finally { await lock.close(); await unlink(lockPath); }
}

main().catch(error => { console.error(JSON.stringify({ status: 'failed', message: error.message, stack: error.stack })); process.exitCode = 1; });
