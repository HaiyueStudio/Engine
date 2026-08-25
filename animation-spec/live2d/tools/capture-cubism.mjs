#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../../scripts/webgpu-gate/chrome-runner.mjs';
import { buildCubismFrameworkEvaluator } from './build-framework-evaluator.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log([
    'Usage: npm run cubism:capture -- --core <live2dcubismcore.min.js> --model <model3.json> --output <capture.json> [options]',
    '',
    'Options:',
    '  --core-url <official-url>   Networked verification only; mutually exclusive with --core',
    '  --motion <motion3.json>      Bake one Motion3 clip; omit for setup pose',
    '  --expression <exp3.json>     Apply one expression after motion',
    '  --physics <physics3.json>    Execute official Framework physics',
    '  --pose <pose3.json>          Execute official Framework pose',
    '  --framework-root <path>      Official CubismWebFramework checkout (required by expression/physics/pose)',
    '  --framework-version <value>  Pinned Framework release/revision provenance',
    '  --constant <id=value>        Apply a deterministic parameter input; repeatable',
    '  --duration <seconds>     Setup-pose duration (default: 1)',
    '  --fps <number>           Requested capture rate (default: 30)',
    '  --timeout <ms>           Headless browser timeout (default: 120000)',
    '',
    'The command copies textures beside the capture. It never copies Core or .moc3 to the output.',
  ].join('\n'));
  process.exit(0);
}

const corePath = optionalPath('--core');
const coreUrl = valueAfter('--core-url');
if (Boolean(corePath) === Boolean(coreUrl)) throw new Error('Specify exactly one of --core <path> or --core-url <url>.');
if (coreUrl && !/^https:\/\//u.test(coreUrl)) throw new Error('--core-url must use HTTPS.');
const modelPath = requiredPath('--model');
const outputPath = requiredPath('--output');
const motionPath = optionalPath('--motion');
const expressionPath = optionalPath('--expression');
const physicsPath = optionalPath('--physics');
const posePath = optionalPath('--pose');
const frameworkRoot = optionalPath('--framework-root');
const frameworkVersion = valueAfter('--framework-version');
const constants = repeatedValues('--constant').map(parseConstant);
const frameRate = positiveNumber('--fps', 30);
const duration = positiveNumber('--duration', 1);
const timeoutMs = positiveNumber('--timeout', 120_000);
for (const [label, path] of [...(corePath ? [['Core', corePath]] : []), ['model', modelPath], ...(motionPath ? [['motion', motionPath]] : []), ...(expressionPath ? [['expression', expressionPath]] : []), ...(physicsPath ? [['physics', physicsPath]] : []), ...(posePath ? [['pose', posePath]] : []), ...(frameworkRoot ? [['Framework', frameworkRoot]] : [])]) {
  if (!existsSync(path)) throw new Error(`${label} input does not exist: ${path}`);
}
const needsFramework = Boolean(expressionPath || physicsPath || posePath);
if (needsFramework && !frameworkRoot) throw new Error('--framework-root is required when --expression, --physics, or --pose is requested.');
if (frameworkRoot && !frameworkVersion) throw new Error('--framework-version is required with --framework-root so capture provenance is reproducible.');
if (extname(modelPath).toLowerCase() !== '.json') throw new Error('--model must reference a model3.json file.');

const toolRoot = dirname(fileURLToPath(import.meta.url));
const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-cubism-capture-'));
try {
  const modelRoot = dirname(modelPath);
  const stagedModelRoot = resolve(temporaryRoot, 'model');
  cpSync(modelRoot, stagedModelRoot, { recursive: true });
  if (corePath) cpSync(corePath, resolve(temporaryRoot, 'live2dcubismcore.min.js'));
  cpSync(resolve(toolRoot, 'capture-page.html'), resolve(temporaryRoot, 'capture-page.html'));
  cpSync(resolve(toolRoot, 'capture-page.mjs'), resolve(temporaryRoot, 'capture-page.mjs'));
  if (frameworkRoot) await buildCubismFrameworkEvaluator({ frameworkRoot, output: resolve(temporaryRoot, 'framework-evaluator.js'), version: frameworkVersion });
  const stagedMotion = stageRecipeAsset(motionPath, 'motion.motion3.json', modelRoot, temporaryRoot);
  const stagedExpression = stageRecipeAsset(expressionPath, 'expression.exp3.json', modelRoot, temporaryRoot);
  const stagedPhysics = stageRecipeAsset(physicsPath, 'physics.physics3.json', modelRoot, temporaryRoot);
  const stagedPose = stageRecipeAsset(posePath, 'pose.pose3.json', modelRoot, temporaryRoot);
  const result = await runChromeWebGpuFixture({
    root: temporaryRoot,
    fixture: 'capture-page.html',
    timeoutMs,
    query: {
      model: `model/${basename(modelPath)}`, fps: frameRate, duration,
      ...(coreUrl ? { core: coreUrl } : {}),
      ...(frameworkRoot ? { framework: '1' } : {}),
      ...(stagedMotion ? { motion: stagedMotion } : {}),
      ...(stagedExpression ? { expression: stagedExpression } : {}),
      ...(stagedPhysics ? { physics: stagedPhysics } : {}),
      ...(stagedPose ? { pose: stagedPose } : {}),
      ...(constants.length ? { constants: JSON.stringify(constants) } : {}),
    },
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
function repeatedValues(flag) { const values = []; for (let index = 0; index < args.length; index++) if (args[index] === flag) { const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${flag} requires <id=value>.`); values.push(value); } return values; }
function parseConstant(value) { const separator = value.indexOf('='); const id = value.slice(0, separator).trim(); const number = Number(value.slice(separator + 1)); if (separator <= 0 || !id || !Number.isFinite(number)) throw new Error(`Invalid --constant ${value}; expected <id=finite-number>.`); return { id, value: number }; }
function stageRecipeAsset(path, fallbackName, modelRoot, temporaryRoot) { if (!path) return undefined; const pathRelative = relative(modelRoot, path); const insideModel = pathRelative !== '..' && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative); if (insideModel) return `model/${toUri(pathRelative)}`; cpSync(path, resolve(temporaryRoot, fallbackName)); return fallbackName; }
function toUri(value) { return value.split(sep).join('/'); }
