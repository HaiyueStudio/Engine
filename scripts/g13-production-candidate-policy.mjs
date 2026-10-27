import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';

export const G13_PRODUCTION_REPORT='artifacts/engine-0.2.2/g13/packages-handoff-compact/public-packages.json';
export const G13_PRODUCTION_REPORT_SHA256='4dda28853d2808ea0c5ea8d1edfc79dd35ead99b4f61e2f305f23c9b34f58527';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Pin the already qualified packages; a new release requires a new explicit handoff. */
export function g13ProductionPlan(root,id,read=path=>readFileSync(path)){
  if(typeof id!=='string'||!/^\d{13}-[a-f0-9]{8}$/.test(id))throw Error('A fresh timestamp/random run identity is required');
  const bytes=read(resolve(root,G13_PRODUCTION_REPORT));
  if(sha(bytes)!==G13_PRODUCTION_REPORT_SHA256)throw Error('Qualified package report changed');
  const report=JSON.parse(bytes);
  if(report.gate?.status!=='passed'||report.packages?.length!==4)throw Error('Passing four-package qualification required');
  for(const pkg of report.packages){
    const file=resolve(root,pkg.artifact),local=relative(root,file);
    if(!local||isAbsolute(local)||local==='..'||local.startsWith('../')||local.startsWith('..\\'))throw Error('Package path escapes repository');
    if(sha(read(file))!==pkg.sha256)throw Error('Qualified package bytes changed: '+pkg.name);
  }
  const output=`artifacts/engine-0.2.2/g12/g13-production-${id}`;
  return {candidateRevision:'70187df17f91d21e64998ea78ac0a05ee77c825d',packageReport:{path:G13_PRODUCTION_REPORT,sha256:G13_PRODUCTION_REPORT_SHA256},
    output,wrapperOutput:`artifacts/engine-0.2.2/g13/production-launch-${id}`,
    args:['scripts/hya-corpus/qualify-production.mjs','--packages',G13_PRODUCTION_REPORT,'--baseline','artifacts/engine-0.2.2/g12/incremental-20261026/haiyue-extensions-0.2.2.tgz','--output',output],
    captures:30,originalGpuRegressionLimit:.05,baselinePromotion:false,releaseQualified:false};
}
