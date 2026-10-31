import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';
import {runTerminalNpm,assertPublicationTerminal} from './publication-terminal.mjs';
import {resolveNpmCli} from './npm-process.mjs';
import {writeAtomicState,acquireStateLock,inspectStateLock,removeStaleStateLock} from './release-workflow-state.mjs';
import {publicationPlanId, validatePublicationPlan, verifyPublicationBytes, runPublication} from './publication-policy.mjs';

const root=resolve(import.meta.dirname,'..'), args=process.argv.slice(2);
const mode=args.shift(), value=flag=>{const at=args.indexOf(flag);if(at<0)return;const v=args[at+1];if(!v||v.startsWith('--'))throw Error('Missing '+flag);args.splice(at,2);return v;};
const planPath=value('--plan'), reportPath=value('--packages'), journalPath=value('--journal'), qualificationPath=value('--qualification'),retryAuth=value('--retry-auth'),confirmPlanId=value('--confirm-plan-id');
if(args.length||!['plan','preflight','status','unlock-stale','verify','publish'].includes(mode))throw Error('Usage: publication.mjs plan --packages <report> --plan <new-plan> | verify|publish --plan <plan> --journal <journal>');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const sha=(b,a='sha256')=>createHash(a).update(b).digest(a==='sha512'?'base64':'hex');

if(mode==='plan'){
  if(!reportPath||!planPath||!qualificationPath||journalPath||retryAuth||confirmPlanId)throw Error('Plan requires a package report, complete G13 qualification and new plan destination.');
  const report=read(reportPath);
  if(report.gate?.status!=='passed'||report.sourceState?.workingTreeDirty!==false)throw Error('Plan requires passing packages from a clean candidate.');
  const qualification=read(qualificationPath);
  if(!((qualification.goal==='g13-integration-release'&&qualification.fullG13Complete===true)||(qualification.goal==='g11-integration-candidate'&&qualification.fullG11Complete===true))||qualification.releaseQualified!==true
    ||qualification.revision!==report.sourceState.revision||qualification.packageReport?.sha256!==sha(readFileSync(resolve(root,reportPath))))
    throw Error('G13 qualification does not match these clean candidate packages.');
  const plan={schemaVersion:qualification.goal==='g11-integration-candidate'?2:1,version:qualification.targetVersion??report.packages?.[0]?.version,revision:report.sourceState.revision,dirty:false,
    qualification:{path:qualificationPath,sha256:sha(readFileSync(resolve(root,qualificationPath)))},
    packageReport:{path:reportPath,sha256:sha(readFileSync(resolve(root,reportPath)))},
    packages:report.packages.map(p=>{const file=resolve(root,p.artifact),bytes=readFileSync(file);if(sha(bytes)!==p.sha256)throw Error('Package report bytes changed');return{name:p.name,version:p.version,file,sha256:sha(bytes),integrity:'sha512-'+sha(bytes,'sha512')};})};
  validatePublicationPlan(plan);mkdirSync(dirname(resolve(root,planPath)),{recursive:true});writeFileSync(resolve(root,planPath),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'planned-not-published',planId:publicationPlanId(plan),plan:planPath}));
}else{
  if(!planPath||!journalPath||reportPath||qualificationPath)throw Error('Verification/publication requires a frozen plan and journal.');
  if(retryAuth&&mode!=='publish')throw Error('--retry-auth applies only to a manually reauthorized publish operation.');
  const plan=read(planPath);validatePublicationPlan(plan);
  if(sha(readFileSync(resolve(root,plan.packageReport.path)))!==plan.packageReport.sha256)throw Error('Frozen package report changed.');
  if(sha(readFileSync(resolve(root,plan.qualification.path)))!==plan.qualification.sha256)throw Error('Frozen G13 qualification changed.');
  for(const p of plan.packages)verifyPublicationBytes(p,readFileSync(p.file));
  if(mode==='preflight'){console.log(JSON.stringify({status:'local-preflight-passed',planId:publicationPlanId(plan),packages:plan.packages.map(p=>({name:p.name,version:p.version})),networkUsed:false,submitted:false}));process.exit(0);}
  const journalFile=resolve(root,journalPath);
  if(mode==='status'){
    const lock=inspectStateLock(journalFile+'.lock',publicationPlanId(plan));
    console.log(JSON.stringify({status:'read-only-state',planId:publicationPlanId(plan),journal:existsSync(journalFile)?read(journalFile):null,lock,networkUsed:false}));process.exit(0);
  }
  if(mode==='unlock-stale'){
    removeStaleStateLock(journalFile+'.lock',publicationPlanId(plan),confirmPlanId);console.log(JSON.stringify({status:'stale-lock-removed',journalPreserved:true,submitted:false}));process.exit(0);
  }
  if(confirmPlanId)throw Error('--confirm-plan-id only applies to explicit stale unlock');
  mkdirSync(dirname(journalFile),{recursive:true});
  // Exclusive lock prevents a second terminal submitting while the first awaits authorization.
  const lock=journalFile+'.lock';let lease;
  try{
    lease=acquireStateLock(lock,{planId:publicationPlanId(plan)});
    const journal=existsSync(journalFile)?read(journalFile):null;
    const result=await runPublication(plan,journal,{
      prepareSubmit:async()=>{assertPublicationTerminal();resolveNpmCli();},
      localBytes:async p=>readFileSync(p.file),now:()=>Date.now(),wait:ms=>new Promise(r=>setTimeout(r,ms)),
      save:async state=>writeAtomicState(journalFile,state),
      observe:async p=>{
        const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(p.name)+'/'+p.version,{signal:AbortSignal.timeout(30000)});
        if(response.status===404)return{status:'absent'};
        if(response.status===202)return{status:'processing'};
        if(!response.ok)throw Error('Registry query failed: HTTP '+response.status);
        const data=await response.json();if(data.name!==p.name||data.version!==p.version)throw Error('Registry identity mismatch.');
        const url=new URL(data.dist?.tarball);if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org')throw Error('Unexpected registry tarball host.');
        return{status:'visible',integrity:data.dist?.integrity,url:url.href};
      },
      download:async(p,remote)=>{const response=await fetch(remote.url,{signal:AbortSignal.timeout(120000),redirect:'error'});if([202,404,408,429,500,502,503,504].includes(response.status))return {status:'unavailable',detail:'Registry metadata visible; tarball not yet downloadable: HTTP '+response.status};if(!response.ok)throw Error('Tarball download failed: HTTP '+response.status);return new Uint8Array(await response.arrayBuffer());},
      submit:async p=>{
        assertPublicationTerminal();
        const log=journalFile+'.'+basename(p.file)+'.'+Date.now()+'.log';
        console.log('Use only the NEW npm authorization URL in this terminal. Keep the terminal open.');
        return runTerminalNpm(['publish',p.file,'--ignore-scripts','--access=public','--registry=https://registry.npmjs.org'],{cwd:root,logPath:log});
      },
    },{allowSubmit:mode==='publish',retryAuth:retryAuth?[retryAuth]:[]});
    console.log(JSON.stringify(result,null,2));if(result.status!=='verified')process.exitCode=2;
  }finally{
    // Keep a crash lock for explicit inspection; a successfully unwound process owns only its own lock.
    lease?.release();
  }
}
