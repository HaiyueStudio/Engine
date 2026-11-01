// Browser-compatible protocol. No filesystem, clocks, timers or process side effects.
export const PLANAR_BUDGET_CASE_IDS=Object.freeze([
  'render3d.planar-reflection.1000e.1m.1b.1v',
  'render3d.planar-reflection.1000e.2m.3b.4v',
  'render3d.planar-reflection.10000e.4m.5b.1v',
  'render3d.planar-reflection.10000e.4m.8b.4v',
]);
export function createPlanarConfigurations(mode) {
  if(mode!=='full')return [
    {entityCount:1000,mirrorCount:1,maxBounces:1,viewCount:1},
    {entityCount:1000,mirrorCount:2,maxBounces:3,viewCount:4},
    {entityCount:10000,mirrorCount:4,maxBounces:5,viewCount:1},
    {entityCount:10000,mirrorCount:4,maxBounces:8,viewCount:4},
  ];
  return [1000,10000].flatMap(entityCount=>[1,4].flatMap(viewCount=>[1,2,4].flatMap(mirrorCount=>[1,3,5,8].map(maxBounces=>({entityCount,mirrorCount,maxBounces,viewCount})))));
}
export function planarFixtureProtocol({mode='smoke',warmup=3,samples=40}={}) {
  if(!['smoke','full'].includes(mode)||!Number.isSafeInteger(warmup)||warmup<3||!Number.isSafeInteger(samples)||samples<1)throw Error('Invalid original planar sampling protocol');
  return {schemaVersion:1,suite:'render3d.planar-reflection',mode,warmup,samples,
    configurations:createPlanarConfigurations(mode),budgetCaseIds:PLANAR_BUDGET_CASE_IDS,pixelCases:4,
    nonBudgetMatrixSamples:1,resultWaitTimeoutMs:mode==='full'?900000:300000,
    timeoutScope:'One shared result-wait deadline for all benchmark and pixel cases, never reset per case. Browser startup retains the shared runner limits.'};
}
export function validatePlanarProgress(value) {
  if(value?.schemaVersion!==1||value.suite!=='render3d.planar-reflection'||!['adapter','case-setup','pipeline-warmup','warmup','samples','case-complete','pixels','complete','error'].includes(value.phase)
    ||!['smoke','full'].includes(value.mode)||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0)throw Error('Invalid planar progress record');
  if(value.frame!==undefined&&(!Number.isSafeInteger(value.frame)||value.frame<0))throw Error('Invalid planar progress frame');
  return value;
}
