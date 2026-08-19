#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { encodeAnimationBinary } from '../../dist/index.js';
import { convertCubismCaptureToHya } from '../../dist/live2d.js';
import { createDeformableMesh2DFormatRegistry } from '../../dist/deformable2d.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log([
    'Usage: hya-live2d-convert --input capture.json --output model.hya [options]',
    '',
    'Options:',
    '  --data <path>    Deformable sidecar output (default: <output>.hydm)',
    '  --report <path>  Conversion report output (default: <output>.report.json)',
    '  --strict         Reject every fidelity warning',
  ].join('\n'));
  process.exit(0);
}

const inputPath = requiredPath('--input');
const outputPath = requiredPath('--output');
if (!outputPath.toLowerCase().endsWith('.hya')) throw new Error('--output must use the .hya extension.');
const stem = outputPath.slice(0, -4);
const dataPath = optionalPath('--data') ?? `${stem}.hydm`;
const reportPath = optionalPath('--report') ?? `${stem}.report.json`;
const dataUri = toAssetUri(relative(dirname(outputPath), dataPath) || basename(dataPath));

const capture = normalizeTextureUris(JSON.parse(await readFile(inputPath, 'utf8')));
const result = convertCubismCaptureToHya(capture, { dataUri, strict: args.includes('--strict') });
const registry = createDeformableMesh2DFormatRegistry();
const binary = encodeAnimationBinary(result.document, { extensions: registry });
await Promise.all([dirname(outputPath), dirname(dataPath), dirname(reportPath)].map(path => mkdir(path, { recursive: true })));
await Promise.all([
  writeFile(outputPath, new Uint8Array(binary)),
  writeFile(dataPath, new Uint8Array(result.data)),
  writeFile(reportPath, `${JSON.stringify({ ...result.report, diagnostics: result.diagnostics }, null, 2)}\n`),
]);

for (const diagnostic of result.diagnostics) {
  console.error(`${diagnostic.severity}: ${diagnostic.code} ${diagnostic.path} - ${diagnostic.message}`);
}
console.log(`Converted ${result.report.drawableCount} drawables / ${result.report.frameCount} frames to ${outputPath} + ${dataPath}.`);

function requiredPath(flag) {
  const value = valueAfter(flag);
  if (!value) throw new Error(`Missing required ${flag} <path>. Use --help for usage.`);
  return resolve(value);
}

function optionalPath(flag) {
  const value = valueAfter(flag);
  return value ? resolve(value) : undefined;
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function toAssetUri(value) {
  return value.split(sep).join('/');
}

function normalizeTextureUris(capture) {
  if (!Array.isArray(capture?.textures)) return capture;
  return {
    ...capture,
    textures: capture.textures.map(texture => {
      if (typeof texture?.uri !== 'string' || /^[a-z][a-z\d+.-]*:/iu.test(texture.uri) || texture.uri.startsWith('//')) return texture;
      const absolute = resolve(dirname(inputPath), texture.uri);
      return { ...texture, uri: toAssetUri(relative(dirname(outputPath), absolute) || basename(absolute)) };
    }),
  };
}
