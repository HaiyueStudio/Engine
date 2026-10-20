import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './deferred-fixture-policy.mjs';
import { createFrameGraphQualification } from './framegraph-qualification-policy.mjs';
import { defaultChromePath } from './chrome-runner.mjs';
import { hostname, release } from 'node:os';
import { execFileSync } from 'node:child_process';

export async function loadFrameGraphQualification(root) {
  const bytes = await readFile(resolve(root, 'config/release-matrix.json'));
  const qualification = createFrameGraphQualification(JSON.parse(bytes), process.platform);
  const osVersion = process.platform === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release();
  if (qualification.path.minimumOsBuild && !(Number(osVersion.split('.')[2]) >= qualification.path.minimumOsBuild) ||
      qualification.path.minimumOsMajor && !(Number(osVersion.split('.')[0]) >= qualification.path.minimumOsMajor)) throw Error('Host OS below qualification minimum or unidentified');
  return { ...qualification, hostname: hostname(), osVersion, matrixSha256: sha256(bytes) };
}

export function frameGraphBrowserPath(browserId) {
  if (browserId === 'edge-windows') return process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  return process.env.CHROME_PATH ?? defaultChromePath();
}

export async function assertFrameGraphQualificationUnchanged(root, qualification) {
  if (JSON.stringify(await loadFrameGraphQualification(root)) !== JSON.stringify(qualification)) throw Error('Qualification contract changed during capture');
}
