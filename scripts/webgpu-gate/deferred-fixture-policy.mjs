import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function parseDeferredFixtureOptions(args) {
  const supported=new Set(['--full','--room','--integrated']);
  for(const arg of args)if(!supported.has(arg))throw new Error(`Unknown Deferred fixture option: ${arg}`);
  if(args.includes('--full')&&args.includes('--room'))throw new Error('Select --full or --room, not both.');
  const mode=args.includes('--room')?'room':args.includes('--full')?'reference':'smoke';
  return {mode,preference:args.includes('--integrated')?'low-power':'high-performance',tier:`diagnostic-g02-${mode}`};
}

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function deferredRuntimeFingerprint(root) {
  const paths=['engine/src','scripts/benchmark','config/rollup.shared.js','package-lock.json',
    'scripts/webgpu-gate/build-deferred-fixture.mjs','scripts/webgpu-gate/deferred-reference-runtime.mjs',
    'scripts/webgpu-gate/deferred-fixture.tsconfig.json'];
  const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','--',...paths],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort();
  return fingerprintFiles(root,files);
}

export async function deferredHarnessFingerprint(root) {
  const files=['deferred-reference-fixture.html','deferred-reference-fixture.mjs','deferred-room-fixture.mjs',
    'deferred-material-fixture.mjs','deferred-submission-fixture.mjs','deferred-view-fixture.mjs','deferred-vertex-color-fixture.mjs','float-texture-readback.mjs','deferred-fixture-policy.mjs','run-deferred-fixture.mjs','chrome-runner.mjs'];
  return fingerprintFiles(root,files.map(file=>`scripts/webgpu-gate/${file}`));
}

async function fingerprintFiles(root,files) {
  const entries=await Promise.all(files.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})));
  return {sha256:sha256(JSON.stringify(entries)),fileCount:entries.length};
}

export function validateDeferredFixtureEvidence(result, options) {
  if(result.status!=='passed'||result.schemaVersion!==1)throw new Error('Deferred fixture did not pass its schema.');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw new Error('A native identified WebGPU adapter is required.');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length)throw new Error('WebGPU validation errors are present or missing.');
  if(result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw new Error('Deferred cleanup has residual or missing resource counts.');
  const expected=options.mode==='room'?[128,256,128,256]:[0,1,8,9,32,128,256];
  if(JSON.stringify(result.cases?.map(c=>c.count))!==JSON.stringify(expected))throw new Error('Missing named Deferred light cases.');
  if(options.mode==='room') {
    if(JSON.stringify(result.resolution)!=='[1280,720]'||result.cases.some(c=>!c.completeCoverage||c.litPixels<92160))throw new Error('Incomplete room coverage.');
  } else if(options.mode==='reference') {
    const contributions=result.oracle?.find(c=>c.id==='all-independent-contributions')?.contributions;
    if(contributions?.length!==256||new Set(contributions.map(c=>c.gpuId)).size!==256)throw new Error('Missing independent stable-ID contributions.');
    for(const id of ['vertex-color-interpolation','vertex-color-forward-deferred','vertex-alpha-auxiliary','normal-map','uv0-uv1-transform-samplers','texture-alpha-mask','clipping-update','double-sided','environment-ambient-once','light-color-remove-add']) {
      if(!result.geometryAssertions?.some(c=>c.id===id))throw new Error(`Missing material assertion ${id}.`);
    }
    const submission=result.oracle?.find(c=>c.id==='submitted-arena-ordering');
    if(submission?.frames!==32||submission.checkedWords!==128||submission.stableBinding!==true)throw new Error('Missing submitted-arena-ordering coverage.');
    if(result.oracle.filter(c=>c.id==='view-reconstruction').length!==8)throw new Error('Missing projection/depth combinations.');
    if(result.oracle.find(c=>c.id==='gpu-driven-indirect')?.status!=='unavailable') validateDeferredReuseEvidence(result.oracle);
    for(const id of ['jitter-reconstruction','four-view-source-reuse','gpu-driven-indirect','submitted-arena-ordering']) {
      if(!result.oracle.some(c=>c.id===id))throw new Error(`Missing view assertion ${id}.`);
    }
  }
}


export function validateDeferredReuseEvidence(oracle) {
  const stationary=oracle.find(c=>c.id==='stationary-resource-reuse');
  const dynamic=oracle.find(c=>c.id==='dynamic-resource-reuse');
  if(stationary?.frames!==8||dynamic?.frames!==8)throw new Error('Missing resource-reuse frames.');
  for(const key of ['buffers','bindGroups','pipelines','sourceUploads']) {
    const value=stationary.baseline?.[key];
    if(!Number.isSafeInteger(value)||value<0||stationary.current?.[key]!==value||dynamic.current?.[key]!==value) {
      throw new Error(`Stationary resource-reuse mismatch: ${key}`);
    }
    if(dynamic.dynamic?.[key]!==value+(key==='sourceUploads'?7:0))throw new Error(`Dynamic resource-reuse mismatch: ${key}`);
  }
  if(!Array.isArray(dynamic.createdGroups)||dynamic.createdGroups.length)throw new Error('Dynamic resource-reuse created bind groups or lacks diagnostics.');
}

export function parseDeferredFixtureBuildOptions(args) {
  if (args.some(arg => !['--tiled', '--compatibility', '--performance', '--framegraph'].includes(arg))) throw new Error('Unknown Deferred fixture build option.');
  if (args.length > 1) throw new Error('Select exactly one Deferred fixture build target.');
  return { goal: args.includes('--framegraph') ? 'g09' : args.includes('--performance') ? 'g05' : args.includes('--compatibility') ? 'g04' : args.includes('--tiled') ? 'g03' : 'g02' };
}
