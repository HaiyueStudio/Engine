import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLive2DDrawableFidelityCandidate,
  createLive2DDrawableFidelityDashboard,
  sha256Bytes,
} from './live2d-drawable-fidelity-corpus-policy.mjs';

const options = parseArguments(process.argv.slice(2));
const manifestPath = resolve(options.manifest);
const reportPath = resolve(options.report);
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const sourceManifestPath = resolve(import.meta.dirname, '..', manifest.sourceManifest.path);
const sourceManifestBytes = readFileSync(sourceManifestPath);
const candidate = createLive2DDrawableFidelityCandidate(manifest, JSON.parse(readFileSync(reportPath, 'utf8')), {
  manifestSha256: sha256Bytes(manifestBytes),
  sourceManifestSha256: sha256Bytes(sourceManifestBytes),
});
const json = `${JSON.stringify(candidate, null, 2)}\n`;
if (options.out) writeFileSync(resolve(options.out), json);
if (options.dashboardOut) writeFileSync(resolve(options.dashboardOut), `${JSON.stringify(createLive2DDrawableFidelityDashboard(candidate), null, 2)}\n`);
process.stdout.write(json);

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

function requireValue(args, index, option) {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}
