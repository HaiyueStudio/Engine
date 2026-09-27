import {parseTiledIdleMs,validateTiledRoomResult,summarizeTiledRoomTiming} from './deferred-tiled-room-policy.mjs';
import {validateG01HostSamples} from '../benchmark/lighting-g01-host.mjs';
import {assessG01Stability} from '../benchmark/lighting-g01-policy.mjs';
export function parseTiledCohortOptions(args){
  const modes=args.filter(arg=>['--plan','--run'].includes(arg));
  if(modes.length!==1||args.some(arg=>!['--plan','--run'].includes(arg)&&!arg.startsWith('--idle-ms=')))throw Error('Choose --plan or --run; only inter-case idle may be extended');
  return {mode:modes[0],idleMs:parseTiledIdleMs(args)};
}
export function tiledCohortPlan(idleMs=30000){
  parseTiledIdleMs([`--idle-ms=${idleMs}`]);
  const runs=[];
  for(let cohort=0;cohort<3;cohort++){
    const cases=[{count:256,overlap:false},{count:128,overlap:true}];
    const adapters=['high-performance','low-power'],algorithms=['reference','tiled'];
    if(cohort%2){cases.reverse();adapters.reverse();algorithms.reverse();}
    for(const workload of cases)for(const preference of adapters)for(const algorithm of algorithms)runs.push({cohort,...workload,preference,algorithm,full:true,idleMs});
  }
  return runs;
}
export function evaluateTiledCohorts(captures,contract){
  const plan=tiledCohortPlan(captures[0]?.evidence.options?.idleMs??30000);
  if(captures.length!==plan.length)throw Error('Expected all 24 interleaved captures');
  const first=captures[0].evidence;
  for(let i=0;i<plan.length;i++){
    const {cohort,...options}=plan[i],capture=captures[i],e=capture.evidence;
    if(capture.cohort!==cohort||Object.keys(options).some(key=>(key==='idleMs'?(e.options?.idleMs??30000):e.options?.[key])!==options[key]))throw Error('Cohort order/workload mismatch');
    if(e.tier!=='diagnostic-g03-performance-candidate'||e.inputs?.sha256!==first.inputs?.sha256||e.harness?.sha256!==first.harness?.sha256||!e.inputs?.sha256||!e.harness?.sha256||e.revision!==first.revision||e.dirty!==first.dirty)throw Error('Mixed source or evidence population');
    if(!Number.isFinite(e.interCaseIdleMs)||e.interCaseIdleMs<Math.max(contract.sampling.interCaseIdleMs,options.idleMs)||e.hostSamples?.length!==2||validateG01HostSamples(e.hostSamples).length)throw Error('Host protocol incomplete');
    const device=contract.devices.find(d=>d.powerPreference===options.preference);
    if(e.result?.adapter?.vendor!==device.vendor||e.result.adapter.architecture!==device.architecture)throw Error('Wrong named adapter');
    validateTiledRoomResult(e.result,options);
  }
  const comparisons=[];
  for(const device of contract.devices)for(const overlap of [false,true]){
    const matching=captures.filter(c=>c.evidence.options.preference===device.powerPreference&&c.evidence.options.overlap===overlap);
    const pooled=algorithm=>matching.filter(c=>c.evidence.options.algorithm===algorithm).flatMap(c=>c.evidence.result.raw);
    const reference=summarizeTiledRoomTiming(pooled('reference')),tiled=summarizeTiledRoomTiming(pooled('tiled'));
    const ratio=overlap?tiled.gpuSpanMs/reference.gpuSpanMs:tiled.lightingMs/reference.lightingMs;
    const limit=overlap?1+contract.relativeBudgets.overlap128FrameGpuP95RegressionRatio:1-contract.relativeBudgets.sparse256CullLightingP95ImprovementRatio;
    const stability=Object.fromEntries(['reference','tiled'].map(algorithm=>[algorithm,Object.fromEntries(
      ['cpuRuntimeMs','gpuSpanMs','lightingMs','frameWallMs'].map(key=>[key,assessG01Stability(matching.filter(c=>c.evidence.options.algorithm===algorithm).map(c=>summarizeTiledRoomTiming(c.evidence.result.raw)[key]))]))]));
    comparisons.push({device:device.id,count:overlap?128:256,overlap,samplesPerAlgorithm:900,reference,tiled,ratio,limit,passed:ratio<=limit,
      stability,
      absoluteBudgets:{cpu:{observed:tiled.cpuRuntimeMs,limit:device.cpuP95Ms,passed:tiled.cpuRuntimeMs<=device.cpuP95Ms},gpu:{observed:tiled.gpuSpanMs,limit:device.gpuP95Ms,passed:tiled.gpuSpanMs<=device.gpuP95Ms},frameWall:{observed:tiled.frameWallMs,limit:device.frameWallP95Ms,passed:tiled.frameWallMs<=device.frameWallP95Ms}},
      cohorts:matching.map(c=>({cohort:c.cohort,algorithm:c.evidence.options.algorithm,p95:summarizeTiledRoomTiming(c.evidence.result.raw)}))});
  }
  return {schemaVersion:1,tier:'diagnostic-g03-paired-cohorts',productQualification:false,inputs:first.inputs.sha256,harness:first.harness.sha256,revision:first.revision,dirty:first.dirty,interCaseIdleMs:plan[0].idleMs,
    stabilityPassed:comparisons.every(c=>Object.values(c.stability).every(channels=>Object.values(channels).every(channel=>channel.stable))),
    relativeBudgetsPassed:comparisons.every(c=>c.passed),absoluteBudgetsPassed:comparisons.every(c=>Object.values(c.absoluteBudgets).every(b=>b.passed)),comparisons};
}
