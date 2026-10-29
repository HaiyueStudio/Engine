import {resolve,relative,isAbsolute} from 'node:path';
import {WINDOWS_RENDER_JOBS,validateWindowsRenderReport,validateWindowsG05BudgetSummary} from './g13-windows-final-policy.mjs';
import {ENGINE_022_SPARSE256_CPU_DECISION} from './engine-021-evidence-policy.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const G13_REUSED_KINDS=Object.freeze(['resources','rooms','correctness']);
const supportNames=['roomDecision','correctnessAudit','hyaByteAudit','productionLauncher','layout','corpus','ime','gamepad'];
const safe=p=>typeof p==='string'&&p.startsWith('artifacts/')&&!p.includes('\\')&&!p.split('/').some(s=>!s||s==='.'||s==='..');
const binding=b=>b&&safe(b.file)&&/^[a-f0-9]{64}$/.test(b.sha256);
export function validateWindowsRemainingConfig(c){
  check(c?.schemaVersion===1&&c.targetVersion==='0.2.2'&&/^[a-f0-9]{40}$/.test(c.captureRevision),'Pinned 0.2.2 capture required');
  check(same(Object.keys(c).sort(),['schemaVersion','targetVersion','captureRevision','checkout','sourceRun','reports','support'].sort()),'Unknown remaining configuration fields');
  check(/^artifacts\/engine-0\.2\.2\/g13\/windows-final-\d{13}-[a-f0-9]{8}\/checkout$/.test(c.checkout),'Pinned isolated checkout required');
  check(binding(c.sourceRun),'Original failed-run digest required');
  check(same(Object.keys(c.reports??{}).sort(),[...G13_REUSED_KINDS].sort()),'Exactly three reused renderer reports required');
  const paths=new Set();for(const kind of G13_REUSED_KINDS){const b=c.reports[kind];check(binding(b)&&b.captureRevision===c.captureRevision&&!paths.has(b.file),'Distinct capture-bound renderer reports required');paths.add(b.file);}
  check(same(Object.keys(c.support??{}).sort(),supportNames.slice().sort())&&supportNames.every(n=>binding(c.support[n])),'Complete pinned input and HYA receipts required');
  return c;
}
export function windowsRemainingPlan(){
  const jobs=WINDOWS_RENDER_JOBS.filter(j=>!G13_REUSED_KINDS.includes(j.id)).map(j=>({...j,args:[...j.args]}));
  return {targetVersion:'0.2.2',jobs,captures:jobs.reduce((n,j)=>n+j.captures,0),reused:G13_REUSED_KINDS.map(id=>({id,captures:WINDOWS_RENDER_JOBS.find(j=>j.id===id).captures})),totalRendererCaptures:580,reusedHyaProductionCaptures:30,
    following:['independent seven-report raw audit and four rebuilt runtimes','complete global release gate','no-publication rehearsal','independent rehearsal bundle and four-tarball audit'],
    originalBudgetsUnchanged:true,originalFailuresRetained:true,automaticRetry:false,macQualified:false,iPhoneQualified:false,externalPublishPerformed:false,baselinePromoted:false};
}
export function windowsRemainingOutput(root,id){check(/^\d{13}-[a-f0-9]{8}$/.test(id),'Fresh remaining-run identity required');return resolve(root,'artifacts/engine-0.2.2/g13/windows-remaining-'+id);}
export function assertWindowsRemainingOutput(root,out){const local=relative(resolve(root,'artifacts/engine-0.2.2/g13'),resolve(out));check(!isAbsolute(local)&&/^windows-remaining-\d{13}-[a-f0-9]{8}$/.test(local),'Remaining output must be one named G13 child');return resolve(out);}
export function validateWindowsRemainingReuse(c,run,reports,support){
  validateWindowsRemainingConfig(c);check(run?.status==='failed'&&run.revision===c.captureRevision&&run.dirty===false,'Original clean failed run must be retained');
  for(const kind of G13_REUSED_KINDS){const r=reports[kind];validateWindowsRenderReport(WINDOWS_RENDER_JOBS.find(j=>j.id===kind),r,c.captureRevision);if(kind!=='correctness')check(['file','sha256','captureRevision'].every(k=>run.reports[kind]?.[k]===c.reports[kind][k])&&r.status===run.reports[kind].originalStatus,'Reused binding or original status differs from original run');}
  const rooms=validateWindowsG05BudgetSummary({id:'rooms'},reports.rooms);
  check(support.roomDecision?.decision===ENGINE_022_SPARSE256_CPU_DECISION&&support.roomDecision.status==='passed-adr0137-g05-prerequisite-only'&&support.roomDecision.captureRevision===c.captureRevision,'ADR 0137 reassessment required');
  check(support.roomDecision.originalReport.sha256===c.reports.rooms.sha256,'Room reassessment digest differs');
  check(support.correctnessAudit?.status==='passed-independent-correctness-audit'&&support.correctnessAudit.report.sha256===c.reports.correctness.sha256&&support.correctnessAudit.audit.captures===224&&support.correctnessAudit.audit.pixelPairs===72,'Complete independently audited correctness required');
  check(support.hyaByteAudit?.status==='passed-independent-hya-byte-bindings'&&support.hyaByteAudit.productionCaptures?.length===30&&support.hyaByteAudit.rounds?.length===3,'Complete HYA byte receipts required');
  check(support.productionLauncher?.status==='passed-local-hya-production'&&support.productionLauncher.originalGpuRegressionLimit===.05&&support.productionLauncher.independentlyAuditedCaptures===30,'Original HYA GPU 5% qualification required');
  check(support.layout?.status==='passed'&&support.layout.cohorts?.length===27,'All layout cohorts required');
  check(support.corpus?.status==='passed'&&support.corpus.rounds?.length===3&&support.corpus.unchangedDenominator===23,'Complete original corpus required');
  check(support.gamepad?.status==='passed-physical-gamepad'&&support.gamepad.physicalInputAccepted===true&&support.gamepad.errors?.length===0,'Real gamepad qualification required');
  check(support.ime?.status==='passed-real-browser-ime'&&support.ime.errors?.length===0,'Real IME qualification required');
  return {status:'passed-reuse-prerequisites-only',rooms,fullG13Complete:false,releaseQualified:false};
}
