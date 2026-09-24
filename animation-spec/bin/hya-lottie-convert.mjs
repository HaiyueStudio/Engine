#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { encodeAnimationBinary } from '../dist/index.js';
import { convertLottie } from '../dist/lottie.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length < 2) {
  console.log('Usage: hya-convert <input.json> <output.hya|output.json> [--strict] (alias: hya-lottie-convert)');
  process.exit(args.includes('--help') ? 0 : 1);
}

const [inputName, outputName] = args;
if (!inputName || !outputName) process.exit(1);

const inputPath = resolve(inputName);
const outputPath = resolve(outputName);
const input = await readFile(inputPath, 'utf8');
const result = convertLottie(input, { strict: args.includes('--strict') });

if (extname(outputPath).toLowerCase() === '.json') {
  await writeFile(outputPath, `${JSON.stringify(result.document, null, 2)}\n`);
} else {
  await writeFile(outputPath, new Uint8Array(encodeAnimationBinary(result.document)));
}

for (const diagnostic of result.diagnostics) {
  console.error(`${diagnostic.severity}: ${diagnostic.code} ${diagnostic.path} - ${diagnostic.message}`);
}
console.log(`Converted ${result.convertedLayerCount} layer(s), skipped ${result.skippedLayerCount}; wrote ${outputPath}.`);
