import {summarizePacing} from '../webgpu-gate/framegraph-production-policy.mjs';
export const productionWorkloads=Object.freeze([
 {id:'interactive-small',nodes:128,instances:1,class:'normal'},
 {id:'layout-1k',nodes:1000,instances:1,class:'pressure'},
 {id:'layout-10k-diagnostic',nodes:10000,instances:1,class:'diagnostic'},
 {id:'multi-instance',nodes:128,instances:4,class:'normal'},
]);
export function assessHyaPacing(raw,budget){
 if(!raw?.frames?.length||raw.readyFrames?.length!==budget.readiness.frames||raw.errors?.length)throw Error('Missing actual readiness, frames, or clean GPU validation');
 let previous=0;for(const row of raw.readyFrames){if(![row.started,row.submitted,row.completed].every(Number.isFinite)||row.started<previous||row.submitted<row.started||row.completed<row.submitted)throw Error('Readiness precedes actual submission/completion');previous=row.completed;}
 const first=raw.frames[0].time,start=first+budget.warmupBoundary.seconds*1000,end=start+budget.durationSeconds*1000;
 if(raw.frames.at(-1).time<end||raw.frames.at(-2).time>=end)throw Error('Production measurement window was truncated or extended');
 const intervals=[],startup=[];let contaminated=false;
 for(let i=0;i<raw.frames.length;i++){
  const row=raw.frames[i];if(!row.visible||!row.focused)contaminated=true;
  if(i){const delta=row.time-raw.frames[i-1].time;if(delta<=0)throw Error('Reordered production frames');(raw.frames[i-1].time>=start?intervals:startup).push(delta);}
 }
 if(raw.readyFrames.some(row=>!row.visible||!row.focused)||raw.events?.some(event=>event.time>=first&&event.time<=raw.frames.at(-1).time&&(!event.visible||!event.focused)))contaminated=true;
 const steady=summarizePacing(intervals,budget.longFrameThresholdMs),interactive=summarizePacing(startup,budget.longFrameThresholdMs),failures=[];
 for(const [metric,limit]of [['p95Ms','frameP95Ms'],['p99Ms','frameP99Ms'],['longFrameRatio','maxLongFrameRatio'],['maxConsecutiveLongFrames','maxConsecutiveLongFrames']])for(const [phase,value]of [['steady',steady],['interactive',interactive]])if(value[metric]>budget[limit])failures.push({phase,metric,limit:budget[limit],actual:value[metric]});
 return {status:contaminated?'inconclusive':failures.length?'failed':'passed',steady,interactive,failures,contaminated};
}
export function compareGpuRows(before,after,regressionLimit){
 if(!Number.isFinite(regressionLimit)||regressionLimit<0||before?.length!==30||after?.length!==30)throw Error('Missing paired GPU samples or original regression limit');
 const p95=rows=>{const values=rows.map(row=>row.gpuMs);if(!values.every(value=>Number.isFinite(value)&&value>0))throw Error('Unavailable/nonpositive GPU timing cannot pass');return values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];};
 const baseline=p95(before),candidate=p95(after);return {status:candidate<=baseline*(1+regressionLimit)?'passed':'failed',baselineP95Ms:baseline,candidateP95Ms:candidate,regression:candidate/baseline-1,regressionLimit};
}
