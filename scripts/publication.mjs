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
if(args.length||!['plan','preflight','status','unlock-stale','verify','publish'].includes(mode))throw Error('Usage: publication.mjs plan --packages REPORT --qualification COMPLETE-QUALIFICATION --plan NEW-FILE | preflight --plan FILE | status|verify|publish --plan FILE --journal FILE | unlock-stale --plan FILE --journal FILE --confirm-plan-id SHA256');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const sha=(b,a='sha256')=>createHash(a).update(b).digest(a==='sha512'?'base64':'hex');

function packageIdentities(report) {
  return report.packages.map(entry => {
    const file = resolve(root, entry.artifact);
    const bytes = readFileSync(file);
    if (sha(bytes) !== entry.sha256) throw Error('Package report bytes changed: ' + entry.name);
    return { name:entry.name, version:entry.version, file, sha256:entry.sha256, integrity:'sha512-'+sha(bytes,'sha512') };
  });
}

function qualifiedPackages(report, qualification, reportHash) {
  if(report.gate?.status!=='passed'||report.sourceState?.workingTreeDirty!==false)throw Error('Plan requires passing packages from a clean candidate.');
  const g07 = qualification.goal === 'g07-integration-candidate';
  const completed = g07 ? qualification.fullG07Complete === true
    : qualification.goal === 'g13-integration-release' && qualification.fullG13Complete === true
      || qualification.goal === 'g11-integration-candidate' && qualification.fullG11Complete === true;
  if (!completed || qualification.releaseQualified !== true || qualification.revision !== report.sourceState.revision ||
      qualification.packageReport?.sha256 !== reportHash) throw Error('Candidate qualification does not match these clean candidate packages.');
  const packages = packageIdentities(report);
  if (!g07) return packages;

  const { versions } = read('config/visual-novel-024-contract.json');
  const expected = { ...versions.publish, ...versions.unchanged };
  if (qualification.targetVersion !== '0.2.4' || packages.length !== Object.keys(expected).length ||
      new Set(packages.map(entry => entry.name)).size !== packages.length ||
      packages.some(entry => expected[entry.name] !== entry.version)) throw Error('G07 package versions differ from the frozen 0.2.4 contract.');
  for (const name of ['windowsDevice', 'macDevice', 'productionPerformance', 'globalGate', 'rehearsal']) {
    if (qualification.verification?.[name] !== 'passed') throw Error('G07 qualification is missing a passing ' + name + ' result.');
  }
  for (const entry of packages.filter(entry => Object.hasOwn(versions.unchanged, entry.name))) {
    const unchanged = qualification.unchangedPackages?.[entry.name];
    if (unchanged?.version !== entry.version || unchanged.sha256 !== entry.sha256 || unchanged.integrity !== entry.integrity) {
      throw Error('G07 unchanged package does not match the qualified registry bytes: ' + entry.name);
    }
  }
  return Object.keys(versions.publish).map(name => packages.find(entry => entry.name === name));
}

if(mode==='plan'){
  if(!reportPath||!planPath||!qualificationPath||journalPath||retryAuth||confirmPlanId)throw Error('Plan requires a package report, completed candidate qualification and new plan destination.');
  const report=read(reportPath);
  const qualification=read(qualificationPath);
  const reportHash=sha(readFileSync(resolve(root,reportPath)));
  const packages=qualifiedPackages(report,qualification,reportHash);
  const version=qualification.targetVersion??report.packages?.[0]?.version;
  if (version==='0.2.4'&&qualification.goal!=='g07-integration-candidate')throw Error('0.2.4 publication requires G07 qualification.');
  const plan={schemaVersion:qualification.goal==='g13-integration-release'?1:2,version,revision:report.sourceState.revision,dirty:false,
    qualification:{path:qualificationPath,sha256:sha(readFileSync(resolve(root,qualificationPath)))},
    packageReport:{path:reportPath,sha256:reportHash},packages};
  validatePublicationPlan(plan);mkdirSync(dirname(resolve(root,planPath)),{recursive:true});writeFileSync(resolve(root,planPath),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'planned-not-published',planId:publicationPlanId(plan),plan:planPath}));
}else{
  if(!planPath||(!journalPath&&mode!=='preflight')||reportPath||qualificationPath)throw Error('Verification/publication requires a frozen plan and journal.');
  if(retryAuth&&mode!=='publish')throw Error('--retry-auth applies only to a manually reauthorized publish operation.');
  const plan=read(planPath);validatePublicationPlan(plan);
  if(sha(readFileSync(resolve(root,plan.packageReport.path)))!==plan.packageReport.sha256)throw Error('Frozen package report changed.');
  if(sha(readFileSync(resolve(root,plan.qualification.path)))!==plan.qualification.sha256)throw Error('Frozen candidate qualification changed.');
  if (plan.version === '0.2.4' || plan.packages.some(entry => entry.version === '0.2.4')) {
    const qualification = read(plan.qualification.path);
    if (qualification.goal !== 'g07-integration-candidate' || plan.version !== qualification.targetVersion || plan.revision !== qualification.revision ||
        JSON.stringify(plan.packages) !== JSON.stringify(qualifiedPackages(read(plan.packageReport.path), qualification, plan.packageReport.sha256))) {
      throw Error('Frozen plan does not match the G07 publication set.');
    }
  }
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
