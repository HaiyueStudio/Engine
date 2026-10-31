import {writeAtomicState,acquireStateLock} from './release-workflow-state.mjs';
import {spawn} from 'node:child_process';
import {createReadStream,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assetPlanId,runReleaseAssets} from './release-workflow-assets-policy.mjs';
import {storedPublicationLog} from './publication-policy.mjs';

export function ghBytes(args,{cwd,spawnImpl=spawn,timeoutMs=300000}={}) {
  const child=spawnImpl('gh',args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr=(stderr+storedPublicationLog(b.toString())).slice(-65536);});
  let timer;
  const completion=new Promise((ok,fail)=>{timer=setTimeout(()=>{child.kill();fail(Error('GitHub raw-byte transport deadline exceeded'));},timeoutMs);child.once('error',fail);child.once('close',code=>code===0?ok():fail(Error('gh exited '+code+': '+stderr)));});
  // Attach a rejection handler before the stream starts, while preserving failure for its consumer.
  completion.catch(()=>{});
  return (async function*(){try{for await(const b of child.stdout)yield b;await completion;}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}})();
}
export function createGithubAssetIo(plan,{cwd,save}={}) {
  const prefix=`repos/${plan.repository}`;
  const json=async endpoint=>{const chunks=[];let bytes=0;for await(const b of ghBytes(['api',endpoint],{cwd})){bytes+=b.length;if(bytes>8*1024*1024)throw Error('GitHub metadata exceeds bound');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString());};
  const command=async args=>{for await(const _ of ghBytes(args,{cwd})){};};
  return {save,local:a=>createReadStream(resolve(cwd,a.file)),
    release:()=>json(`${prefix}/releases/${plan.releaseId}`),
    list:async()=>{const pages=[];for(let page=1;page<=32;page++){const entries=await json(`${prefix}/releases/${plan.releaseId}/assets?per_page=100&page=${page}`);pages.push(...entries);if(entries.length<100)return pages;}throw Error('Too many remote asset pages');},
    asset:id=>json(`${prefix}/releases/assets/${id}`),currentUser:()=>json('user'),
    tagRevision:async tag=>{let object=(await json(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`)).object;for(let n=0;n<8;n++){if(object.type==='commit')return object.sha;if(object.type!=='tag')break;object=(await json(`${prefix}/git/tags/${object.sha}`)).object;}throw Error('Unresolvable release tag');},
    download:a=>ghBytes(['api',`${prefix}/releases/assets/${a.id}`,'--header','Accept: application/octet-stream'],{cwd}),
    upload:async(a,label)=>{if(a.file.includes('#')||resolve(cwd,a.file).split(/[/\\]/).at(-1)!==a.name)throw Error('Frozen asset name must match local filename and have an unambiguous label path');await command(['release','upload',plan.tag,resolve(cwd,a.file)+'#'+label,'--repo',plan.repository]);},
    remove:id=>command(['api','--method','DELETE',`${prefix}/releases/assets/${id}`]),
  };
}

async function main(){
  const args=process.argv.slice(2),mode=args.shift();
  const take=flag=>{const at=args.indexOf(flag);if(at<0)return;const value=args[at+1];if(!value||value.startsWith('--'))throw Error('Missing '+flag);args.splice(at,2);return value;};
  const path=take('--plan'),journalPath=take('--journal'),authorize=take('--authorize-plan');
  const repair=args.includes('--repair-owned-incomplete');if(repair)args.splice(args.indexOf('--repair-owned-incomplete'),1);
  if(args.length||!['verify','upload'].includes(mode)||!path||!journalPath)throw Error('Usage: release-workflow-assets.mjs verify|upload --plan FILE --journal FILE [--authorize-plan SHA256] [--repair-owned-incomplete]');
  const cwd=resolve(import.meta.dirname,'..'),plan=JSON.parse(readFileSync(resolve(cwd,path),'utf8')),id=assetPlanId(plan);
  if(mode==='upload'&&authorize!==id)throw Error('Upload requires explicit authorization of this exact plan: '+id);
  if(mode==='verify'&&(authorize||repair))throw Error('Verification has no remote write authorization');
  const output=resolve(cwd,journalPath);mkdirSync(dirname(output),{recursive:true});const lock=output+'.lock';
  let lease;
  try{
    lease=acquireStateLock(lock,{planId:id});
    const journal=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null;
    const io=createGithubAssetIo(plan,{cwd,save:async state=>writeAtomicState(output,state)});
    const result=await runReleaseAssets(plan,journal,io,{allowUpload:mode==='upload',allowRepairIncomplete:repair});
    console.log(JSON.stringify(result,null,2));if(result.status!=='verified')process.exitCode=2;
  }finally{lease?.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(storedPublicationLog(e.stack??e.message));process.exitCode=1;});
