#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../../scripts/webgpu-gate/chrome-runner.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log([
    'Usage: npm run cubism:capture -- --core <live2dcubismcore.min.js> --model <model3.json> --output <capture.json> [options]',
    '',
    'Options:',
    '  --motion <motion3.json>  Bake one Motion3 clip; omit for setup pose',
    '  --duration <seconds>     Setup-pose duration (default: 1)',
    '  --fps <number>           Requested capture rate (default: 30)',
    '  --timeout <ms>           Headless browser timeout (default: 120000)',
    '',
    'The command copies textures beside the capture. It never copies Core or .moc3 to the output.',
  ].join('\n'));
  process.exit(0);
}

const corePath = requiredPath('--core');
const modelPath = requiredPath('--model');
const outputPath = requiredPath('--output');
const motionPath = optionalPath('--motion');
const frameRate = positiveNumber('--fps', 30);
const duration = positiveNumber('--duration', 1);
const timeoutMs = positiveNumber('--timeout', 120_000);
for (const [label, path] of [['Core', corePath], ['model', modelPath], ...(motionPath ? [['motion', motionPath]] : [])]) {
  if (!existsSync(path)) throw new Error(`${label} input does not exist: ${path}`);
}
if (extname(modelPath).toLowerCase() !== '.json') throw new Error('--model must reference a model3.json file.');

const toolRoot = dirname(fileURLToPath(import.meta.url));
const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-cubism-capture-'));
try {
  const modelRoot = dirname(modelPath);
  const stagedModelRoot = resolve(temporaryRoot, 'model');
  cpSync(modelRoot, stagedModelRoot, { recursive: true });
  cpSync(corePath, resolve(temporaryRoot, 'live2dcubismcore.min.js'));
  cpSync(resolve(toolRoot, 'capture-page.html'), resolve(temporaryRoot, 'capture-page.html'));
  cpSync(resolve(toolRoot, 'capture-page.mjs'), resolve(temporaryRoot, 'capture-page.mjs'));
  let stagedMotion;
  if (motionPath) {
    const motionRelative = relative(modelRoot, motionPath);
    const insideModel = motionRelative !== '..' && !motionRelative.startsWith(`..${sep}`) && !isAbsolute(motionRelative);
    if (insideModel) stagedMotion = `model/${toUri(motionRelative)}`;
    else { cpSync(motionPath, resolve(temporaryRoot, 'motion.motion3.json')); stagedMotion = 'motion.motion3.json'; }
  }
  const result = await runChromeWebGpuFixture({
    root: temporaryRoot,
    fixture: 'capture-page.html',
    timeoutMs,
    query: { model: `model/${basename(modelPath)}`, fps: frameRate, duration, ...(stagedMotion ? { motion: stagedMotion } : {}) },
  });
  if (!result.capture) throw new Error('Cubism capture page returned no capture payload.');
  const capture = result.capture;
  const model3 = JSON.parse(readFileSync(modelPath, 'utf8'));
  const textureNames = model3.FileReferences?.Textures;
  if (!Array.isArray(textureNames) || textureNames.length !== capture.textures.length) throw new Error('Captured texture table does not match model3.json.');
  const outputDirectory = dirname(outputPath);
  const textureDirectoryName = `${basename(outputPath, extname(outputPath))}.textures`;
  const textureDirectory = resolve(outputDirectory, textureDirectoryName);
  mkdirSync(textureDirectory, { recursive: true });
  capture.textures = textureNames.map((name, index) => {
    const source = resolve(modelRoot, name);
    if (source !== modelRoot && !source.startsWith(`${modelRoot}${sep}`)) throw new Error(`Texture path escapes the model directory: ${name}`);
    if (!existsSync(source)) throw new Error(`Texture does not exist: ${source}`);
    const targetName = `${index}-${basename(source)}`;
    cpSync(source, resolve(textureDirectory, targetName));
    return { ...capture.textures[index], uri: `${textureDirectoryName}/${targetName}` };
  });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`Captured ${capture.frames.length} frames / ${capture.frames[0]?.drawables.length ?? 0} drawables to ${outputPath}.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function requiredPath(flag) { const value = valueAfter(flag); if (!value) throw new Error(`Missing ${flag} <path>. Use --help for usage.`); return resolve(value); }
function optionalPath(flag) { const value = valueAfter(flag); return value ? resolve(value) : undefined; }
function positiveNumber(flag, fallback) { const value = valueAfter(flag); const number = value === undefined ? fallback : Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be positive.`); return number; }
function valueAfter(flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; }
function toUri(value) { return value.split(sep).join('/'); }
