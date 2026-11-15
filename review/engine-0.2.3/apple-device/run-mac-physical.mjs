import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const scanIntervalMs = 1000;
const cleanupBudgetMs = 20000;
const gateDirectory = 'artifacts/engine-0.2.3/g11';
const identity = row => row.pid + ' ' + row.started;

export function parseMacProcessList(text) {
  return text.trim().split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), group: Number(row[3]), started: row[4], command: row[5] }] : [];
  });
}

export function findOwnedProcesses(rows, group, profileFlag, observed) {
  const owned = new Set(rows.filter(row =>
    row.group === group || row.command.includes(profileFlag) || observed.has(identity(row)),
  ).map(row => row.pid));
  for (let size = -1; size !== owned.size;) {
    size = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  }
  return rows.filter(row => owned.has(row.pid));
}

function readMacProcesses() {
  const text = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024,
  });
  const rows = parseMacProcessList(text);
  assert.ok(rows.some(row => row.pid === process.pid), '进程快照缺少采集器自身。');
  return rows;
}

async function run(profile, directory) {
  assert.equal(process.platform, 'darwin', '此入口用于 macOS。');
  assert.ok(['keyboard-ime', 'audio'].includes(profile) && directory,
    '用法：node run-mac-physical.mjs <keyboard-ime|audio> <解包目录>');
  const root = realpathSync(directory);
  const engine = join(root, 'Engine');
  const qualification = JSON.parse(readFileSync(new URL('./qualification.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'handoff-manifest.json'), 'utf8'));
  assert.equal(manifest.revision, qualification.engineRevision);
  assert.equal(manifest.candidate.sha256, qualification.candidateSha256);
  assert.equal(manifest.nativeCandidateId, qualification.nativeCandidateId);
  readMacProcesses();
  execFileSync(process.execPath, ['verify-current-device.mjs'], { cwd: root, stdio: 'inherit' });

  const candidate = relative(engine, resolve(root, manifest.candidate.path));
  const id = 'physical-darwin-' + profile + '-' + Date.now() + '-' + randomBytes(3).toString('hex');
  const output = join(engine, gateDirectory, id);
  const scope = realpathSync(mkdtempSync(join(tmpdir(), 'haiyue-g11-mac-')));
  const profileFlag = '--user-data-dir=' + join(scope, 'haiyue-webgpu-gate-');
  const child = spawn(process.execPath, [join(gateDirectory, 'qualify-physical.mjs'), profile, candidate, join(gateDirectory, id)], {
    cwd: engine,
    detached: true,
    env: { ...process.env, TMPDIR: scope },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const observed = new Map();
  const failures = new Set();
  let exit = null;
  let browserObserved = false;
  let scans = 0;
  let remaining = null;
  const closed = new Promise(resolveClose => {
    child.once('error', error => resolveClose({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  }).then(result => { exit = result; });
  const keepTerminal = () => console.error('请在浏览器保存本轮记录，等待退出检查结束。');
  process.on('SIGINT', keepTerminal);

  function scan() {
    if (!child.pid) return;
    try {
      const owned = findOwnedProcesses(readMacProcesses(), child.pid, profileFlag, observed);
      for (const row of owned) {
        const { command, ...processIdentity } = row;
        const usesTestProfile = command.includes(profileFlag);
        browserObserved ||= usesTestProfile && row.group === child.pid && row.ppid === child.pid;
        observed.set(identity(row), { ...processIdentity, usesTestProfile });
      }
      remaining = owned.map(({ pid, ppid, group, started }) => ({ pid, ppid, group, started }));
      scans++;
    } catch (error) {
      remaining = null;
      failures.add(error.message);
    }
  }

  try {
    while (!exit) {
      scan();
      await Promise.race([closed, delay(scanIntervalMs)]);
    }
    const deadline = performance.now() + cleanupBudgetMs;
    let clearScans = 0;
    while (performance.now() < deadline && clearScans < 2) {
      scan();
      clearScans = remaining?.length === 0 ? clearScans + 1 : 0;
      if (clearScans < 2) await delay(scanIntervalMs);
    }
    let scopeRemoved = false;
    if (clearScans === 2) {
      try { rmdirSync(scope); scopeRemoved = true; } catch (error) { failures.add(error.message); }
    }
    const resultPath = join(output, 'result.json');
    const resultBytes = existsSync(resultPath) ? readFileSync(resultPath) : null;
    const result = resultBytes && JSON.parse(resultBytes);
    const resultSha256 = resultBytes && createHash('sha256').update(resultBytes).digest('hex');
    const status = exit.code === 0 && browserObserved && clearScans === 2 && scopeRemoved
      && failures.size === 0 && result?.profile === profile
      && result.status === 'awaiting-operator-confirmation'
      && result.candidate?.sha256 === qualification.candidateSha256
      && result.browserDiagnostics?.profileCleanup?.status === 'passed' ? 'passed' : 'failed';
    mkdirSync(output, { recursive: true });
    const reportPath = join(output, 'mac-process-cleanup.json');
    writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1, platform: 'darwin', profile, status, resultSha256,
      candidateSha256: qualification.candidateSha256, processGroup: child.pid,
      browserObserved, scans, clearScans, cleanupBudgetMs, scopeRemoved, exit,
      observed: [...observed.values()], remaining, errors: [...failures],
    }, null, 2) + '\n', { flag: 'wx' });
    console.log('Mac 进程退出检查 ' + status + ' · ' + reportPath);
    if (status !== 'passed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', keepTerminal);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(...process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
