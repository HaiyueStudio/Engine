import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLive2DDashboardStatus, createLive2DFeatureCorpusCandidate } from './live2d-feature-corpus-policy.mjs';

const options = parseArguments(process.argv.slice(2));
const manifestBytes = readFileSync(resolve(options.manifest));
const manifest = JSON.parse(manifestBytes);
const report = JSON.parse(readFileSync(resolve(options.report), 'utf8'));
const bundledFileInventory = verifyBundledFiles(manifest);
const baseCandidate = createLive2DFeatureCorpusCandidate(manifest, report, {
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
});
const candidate = Object.freeze({ ...baseCandidate, bundledFileInventory });
const candidateJson = `${JSON.stringify(candidate, null, 2)}\n`;
if (options.out) writeFileSync(resolve(options.out), candidateJson);
if (options.dashboardOut) writeFileSync(resolve(options.dashboardOut), `${JSON.stringify(createLive2DDashboardStatus(candidate), null, 2)}\n`);
process.stdout.write(candidateJson);

function parseArguments(args) {
  const result = { manifest: null, report: null, out: null, dashboardOut: null };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--manifest') result.manifest = requireValue(args, ++index, option);
    else if (option === '--report') result.report = requireValue(args, ++index, option);
    else if (option === '--out') result.out = requireValue(args, ++index, option);
    else if (option === '--dashboard-out') result.dashboardOut = requireValue(args, ++index, option);
    else throw new Error(`Unknown option ${option}.`);
  }
  if (!result.manifest || !result.report) throw new Error('--manifest and --report are required.');
  return result;
}

function requireValue(args, index, option) { if (!args[index]) throw new Error(`${option} requires a value.`); return args[index]; }

function verifyBundledFiles(manifest) {
  let fileCount = 0;
  for (const sample of manifest.samples.filter(sample => sample.sourcePolicy === 'bundled-redistributable')) {
    for (const file of sample.files) {
      const bytes = readFileSync(resolve(import.meta.dirname, '..', file.path));
      if (bytes.byteLength !== file.byteLength) throw new Error(`Bundled file length drifted: ${file.path}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== file.sha256) throw new Error(`Bundled file hash drifted: ${file.path}`);
      fileCount++;
    }
  }
  return Object.freeze({ status: 'passed', fileCount });
}
