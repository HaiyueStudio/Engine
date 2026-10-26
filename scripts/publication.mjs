import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';
import {spawn} from 'node:child_process';
import {npmArgs, npmCommand} from './npm-process.mjs';
import {publicationPlanId, validatePublicationPlan, verifyPublicationBytes, redactPublicationLog, runPublication} from './publication-policy.mjs';

const root=resolve(import.meta.dirname,'..'), args=process.argv.slice(2);
const mode=args.shift(), value=flag=>{const at=args.indexOf(flag);if(at<0)return;const v=args[at+1];if(!v||v.startsWith('--'))throw Error('Missing '+flag);args.splice(at,2);return v;};
const planPath=value('--plan'), reportPath=value('--packages'), journalPath=value('--journal'), qualificationPath=value('--qualification');
if(args.length||!['plan','verify','publish'].includes(mode))throw Error('Usage: publication.mjs plan --packages <report> --plan <new-plan> | verify|publish --plan <plan> --journal <journal>');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const sha=(b,a='sha256')=>createHash(a).update(b).digest(a==='sha512'?'base64':'hex');

if(mode==='plan'){
  if(!reportPath||!planPath||!qualificationPath||journalPath)throw Error('Plan requires a package report, complete G13 qualification and new plan destination.');
  const report=read(reportPath);
  if(report.gate?.status!=='passed'||report.sourceState?.workingTreeDirty!==false)throw Error('Plan requires passing packages from a clean candidate.');
  const qualification=read(qualificationPath);
  if(qualification.goal!=='g13-integration-release'||qualification.fullG13Complete!==true||qualification.releaseQualified!==true
    ||qualification.revision!==report.sourceState.revision||qualification.packageReport?.sha256!==sha(readFileSync(resolve(root,reportPath))))
    throw Error('G13 qualification does not match these clean candidate packages.');
  const plan={schemaVersion:1,version:report.packages?.[0]?.version,revision:report.sourceState.revision,dirty:false,
    qualification:{path:qualificationPath,sha256:sha(readFileSync(resolve(root,qualificationPath)))},
    packageReport:{path:reportPath,sha256:sha(readFileSync(resolve(root,reportPath)))},
    packages:report.packages.map(p=>{const file=resolve(root,p.artifact),bytes=readFileSync(file);if(sha(bytes)!==p.sha256)throw Error('Package report bytes changed');return{name:p.name,version:p.version,file,sha256:sha(bytes),integrity:'sha512-'+sha(bytes,'sha512')};})};
  validatePublicationPlan(plan);mkdirSync(dirname(resolve(root,planPath)),{recursive:true});writeFileSync(resolve(root,planPath),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'planned-not-published',planId:publicationPlanId(plan),plan:planPath}));
}else{
  if(!planPath||!journalPath||reportPath||qualificationPath)throw Error('Verification/publication requires a frozen plan and journal.');
  const plan=read(planPath);validatePublicationPlan(plan);
  if(sha(readFileSync(resolve(root,plan.packageReport.path)))!==plan.packageReport.sha256)throw Error('Frozen package report changed.');
  if(sha(readFileSync(resolve(root,plan.qualification.path)))!==plan.qualification.sha256)throw Error('Frozen G13 qualification changed.');
  const journalFile=resolve(root,journalPath);mkdirSync(dirname(journalFile),{recursive:true});
  // Exclusive lock prevents a second terminal submitting while the first awaits authorization.
  const lock=journalFile+'.lock';let lockFd;
  try{
    lockFd=openSync(lock,'wx');writeFileSync(lockFd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),planId:publicationPlanId(plan)}));fsyncSync(lockFd);
    const journal=existsSync(journalFile)?read(journalFile):null;
    const result=await runPublication(plan,journal,{
      localBytes:async p=>readFileSync(p.file),now:()=>Date.now(),wait:ms=>new Promise(r=>setTimeout(r,ms)),
      save:async state=>{const tmp=journalFile+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(state,null,2)+'\n');const fd=openSync(tmp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,journalFile);},
      observe:async p=>{
        const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(p.name)+'/'+p.version,{signal:AbortSignal.timeout(30000)});
        if(response.status===404)return{status:'absent'};
        if(response.status===202)return{status:'processing'};
        if(!response.ok)throw Error('Registry query failed: HTTP '+response.status);
        const data=await response.json();if(data.name!==p.name||data.version!==p.version)throw Error('Registry identity mismatch.');
        const url=new URL(data.dist?.tarball);if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org')throw Error('Unexpected registry tarball host.');
        return{status:'visible',integrity:data.dist?.integrity,url:url.href};
      },
      download:async(p,remote)=>{const response=await fetch(remote.url,{signal:AbortSignal.timeout(120000),redirect:'error'});if(!response.ok)throw Error('Tarball download failed: HTTP '+response.status);const bytes=new Uint8Array(await response.arrayBuffer());verifyPublicationBytes(p,bytes);return bytes;},
      submit:p=>new Promise((resolveSubmit,reject)=>{
        const log=journalFile+'.'+basename(p.file)+'.'+Date.now()+'.log';let pending='',tail='';
        writeFileSync(log,'Live authorization request started '+new Date().toISOString()+'\n',{flag:'wx'});
        const consume=chunk=>{pending+=chunk.toString();if(pending.length>1048576){child.kill();reject(Error('npm output exceeded bounded line size'));return;}const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){const safe=redactPublicationLog(line)+'\n';process.stdout.write(safe);const stored=safe.replace(/https:\/\/www\.npmjs\.com\/auth\/cli\/[^\s]+/g,'[live authorization URL omitted]');writeFileSync(log,stored,{flag:'a'});tail=(tail+stored).slice(-16384);}};
        console.log('Use only the NEW npm authorization URL below. If expired, stop; do not reopen an old URL.');
        const child=spawn(npmCommand(),npmArgs(['publish',p.file,'--access=public','--registry=https://registry.npmjs.org']),{cwd:root,windowsHide:true,stdio:['inherit','pipe','pipe']});
        child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('error',reject);child.once('close',code=>{if(pending)consume('\n');resolveSubmit(code===0?{status:'accepted'}:{status:/EOTP|E401|ENEEDAUTH|E403/.test(tail)?'rejected':'indeterminate',detail:'npm exited '+code+'; sanitized log '+log});});
      }),
    },{allowSubmit:mode==='publish'});
    console.log(JSON.stringify(result,null,2));if(result.status!=='verified')process.exitCode=2;
  }finally{
    // Keep a crash lock for explicit inspection; a successfully unwound process owns only its own lock.
    if(lockFd!==undefined){closeSync(lockFd);const {unlinkSync}=await import('node:fs');unlinkSync(lock);}
  }
}
