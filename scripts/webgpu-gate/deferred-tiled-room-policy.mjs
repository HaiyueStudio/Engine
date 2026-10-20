import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sha256} from './deferred-fixture-policy.mjs';
import {tiledHarnessFingerprint} from './deferred-tiled-policy.mjs';
export function parseTiledIdleMs(args){
  const flags=args.filter(arg=>arg.startsWith('--idle-ms='));
  if(flags.length>1)throw Error('Choose one inter-case idle duration');
  const value=flags.length?flags[0].slice('--idle-ms='.length):'30000';
  const ms=Number(value);
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(ms)||ms<30000||ms>300000)throw Error('Inter-case idle must be an integer from 30000 to 300000 ms');
  return ms;
}
export function parseTiledRoomOptions(args){
  for(const arg of args)if(!['--integrated','--reference','--overlap','--full','--count=128','--count=256'].includes(arg)&&!arg.startsWith('--idle-ms='))throw Error(`Unknown tiled room option: ${arg}`);
  if(args.includes('--count=128')&&args.includes('--count=256'))throw Error('Choose one light count');
  return {preference:args.includes('--integrated')?'low-power':'high-performance',algorithm:args.includes('--reference')?'reference':'tiled',
    overlap:args.includes('--overlap'),count:args.includes('--count=128')?128:256,full:args.includes('--full'),idleMs:parseTiledIdleMs(args)};
}
export async function tiledRoomHarnessFingerprint(root){
  const base=await tiledHarnessFingerprint(root);
  const paths=['scripts/webgpu-gate/deferred-room-fixture.mjs','scripts/webgpu-gate/deferred-tiled-room-fixture.html',
    'scripts/webgpu-gate/deferred-tiled-room-fixture.mjs','scripts/webgpu-gate/deferred-tiled-room-scene.mjs',
    'scripts/webgpu-gate/deferred-tiled-room-policy.mjs','scripts/webgpu-gate/run-deferred-tiled-room.mjs',
    'scripts/benchmark/lighting-g01-host.mjs','config/lighting-performance-021.json'];
  const files=[...base.files,...await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(resolve(root,path)))})))];
  return {sha256:sha256(JSON.stringify(files)),files};
}
export function validateTiledRoomResult(result,options){
  if(result.status!=='passed'||result.schemaVersion!==1)throw Error('Room fixture failed');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native room adapter missing');
  if(result.fixtureId!=='deferred-room-021-v1'||JSON.stringify(result.resolution)!=='[1280,720]')throw Error('Room content or resolution mismatch');
  for(const key of ['count','algorithm','overlap'])if(result[key]!==options[key])throw Error(`Room ${key} mismatch`);
  if(result.samples!==(options.full?300:3)||result.warmup!==(options.full?120:2)||result.raw?.length!==result.samples)throw Error('Missing room samples');
  for(const [frame,sample] of result.raw.entries()){
    if(sample.frame!==frame)throw Error('Room sample order changed');
    for(const key of ['cpuRuntimeMs','cpuRecordMs','cpuSubmitMs','queueWaitMs','frameWallMs','authoredMutationMs','gpuSpanMs','gpuPassSumMs','cullMs','resolveMs'])if(!Number.isFinite(sample[key])||sample[key]<0)throw Error(`Invalid ${key}`);
    if(!['deferred-tiled','deferred-reference'].includes(sample.effective)||options.algorithm==='reference'&&sample.effective!=='deferred-reference')throw Error('Unexpected effective lighting path');
    if(options.algorithm==='tiled'&&(sample.effective!=='deferred-tiled'||sample.bypassReason!==null&&!['empty-source','all-lights-cover-near-plane'].includes(sample.bypassReason)))throw Error('Undocumented low-benefit fallback');
    if(sample.gpuSpanMs<=0||sample.resolveMs<=0||sample.gpuSpanMs+1e-6<sample.gpuPassSumMs)throw Error('Incomplete GPU timing span');
    if(sample.passes.filter(p=>p.kind==='compute'&&p.label==='DeferredTiles.cull').length!==(sample.effective==='deferred-tiled'&&!sample.bypassReason?1:0))throw Error('Cull timing missing');
  }
  if(result.tiles?.heatmap?.length!==3600||result.tiles.plan?.tileCount!==3600||!Number.isFinite(result.tiles.resolveListReferences))throw Error('Room tile heatmap missing');
  if(result.source?.pointCount!==options.count||result.source.directionalCount!==1||result.source.ambientCount!==1||result.completeCoverage!==true)throw Error('Incomplete room light population');
  if(!Number.isFinite(result.pixels?.maxHdrDelta)||!Number.isFinite(result.pixels?.maxLdrDelta)||result.pixels.maxLdrDelta>2.001||result.pixels.litPixels<92160)throw Error('Room pixels incomplete');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length||result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Room errors or resource residue');
}
export function summarizeTiledRoomTiming(raw){
  const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  return Object.fromEntries(['cpuRuntimeMs','frameWallMs','gpuSpanMs','gpuPassSumMs','cullMs','resolveMs','lightingMs'].map(key=>[key,p95(raw.map(s=>key==='lightingMs'?s.cullMs+s.resolveMs:s[key]))]));
}
