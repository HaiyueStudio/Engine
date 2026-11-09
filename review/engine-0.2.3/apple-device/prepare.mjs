import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function prepare() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, '需要 Node.js 22 或更新版本。');
  const qualification = JSON.parse(readFileSync(new URL('./qualification.json', import.meta.url), 'utf8'));
  const { archive } = qualification;
  const archiveUrl = new URL(archive.name, import.meta.url);
  const bytes = readFileSync(archiveUrl);
  if (bytes.subarray(0, 43).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error('当前文件是 Git LFS 指针。请先按 README 执行 git lfs pull。');
  }
  assert.equal(bytes.length, archive.bytes, '验收包大小不符。');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256, '验收包 SHA-256 不符。');

  const outputRoot = fileURLToPath(new URL('../../../artifacts/engine-0.2.3/g11/apple-device-307771a/', import.meta.url));
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, 'run-'));
  try {
    execFileSync('tar', ['-xzf', '-', '-C', output], { input: bytes, windowsHide: true });
    const verification = execFileSync(process.execPath, ['verify-current-device.mjs'], {
      cwd: output,
      encoding: 'utf8',
      windowsHide: true,
    });
    const [handoff, device] = verification.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const manifest = JSON.parse(readFileSync(join(output, 'handoff-manifest.json'), 'utf8'));
    assert.equal(handoff.status, 'verified-handoff');
    assert.equal(device.status, 'verified-current-device-package');
    assert.equal(device.revision, qualification.engineRevision);
    assert.equal(device.nativeCandidateId, qualification.nativeCandidateId);
    assert.equal(manifest.candidate.sha256, qualification.candidateSha256);
    console.error(`已核对 ${handoff.files} 个文件。Engine ${device.revision.slice(0, 7)}，Native ${device.nativeCandidateId}。`);
  } catch (error) {
    console.error(`本次解包目录已保留在 ${output}`);
    throw error;
  }
  console.log(output);
}

try {
  prepare();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
