import {createHash} from 'node:crypto';

export function validateAssetPlan(plan) {
  if(plan?.schemaVersion!==1||!/^[-\w.]+\/[-\w.]+$/.test(plan.repository??'')||!Number.isSafeInteger(plan.releaseId)||plan.releaseId<1
    ||!/^v\d+\.\d+\.\d+$/.test(plan.tag??'')||!/^[a-f0-9]{40}$/.test(plan.revision??'')||!Array.isArray(plan.assets)||!plan.assets.length||plan.assets.length>256)throw Error('Invalid frozen release asset plan');
  const names=new Set();
  for(const a of plan.assets){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.name??'')||names.has(a.name)||!a.file||/[\x00\r\n]/.test(a.file)
      ||!Number.isSafeInteger(a.bytes)||a.bytes<0||!/^[a-f0-9]{64}$/.test(a.sha256??''))throw Error('Invalid/duplicate frozen asset');
    names.add(a.name);
  }
}
export function assetPlanId(plan) {validateAssetPlan(plan);return createHash('sha256').update(JSON.stringify(plan)).digest('hex');}
export function assetLabel(plan,a) {return `haiyue:${assetPlanId(plan)}:${a.sha256}`;}

/** Raw bytes only. Text decoding, log filtering and temporary download copies are forbidden here. */
export async function verifyAssetStream(asset,stream) {
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of stream){
    if(!(chunk instanceof Uint8Array))throw Error('Asset transport returned text instead of raw bytes');
    bytes+=chunk.byteLength;if(bytes>asset.bytes)throw Error('Asset download exceeds frozen byte length: '+asset.name);
    hash.update(chunk);
  }
  const sha256=hash.digest('hex');
  if(bytes!==asset.bytes||sha256!==asset.sha256)throw Error('Asset byte/SHA-256 conflict: '+asset.name);
  return {bytes,sha256};
}

export async function runReleaseAssets(plan,journal,io,{allowUpload=false,allowRepairIncomplete=false}={}) {
  const id=assetPlanId(plan);
  if(allowRepairIncomplete&&!allowUpload)throw Error('Incomplete repair requires explicit upload authorization');
  if(journal&&(journal.schemaVersion!==1||journal.planId!==id))throw Error('Asset journal belongs to another frozen plan');
  const state=journal?structuredClone(journal):{schemaVersion:1,planId:id,assets:{}};
  const save=async(name,status,extra={})=>{state.assets[name]={...state.assets[name],status,...extra};await io.save(structuredClone(state));};
  const release=await io.release();
  if(release.id!==plan.releaseId||release.tag_name!==plan.tag||await io.tagRevision(plan.tag)!==plan.revision)throw Error('Remote release/tag differs from frozen candidate');
  // Validate every local file before the first possible remote mutation.
  for(const a of plan.assets)await verifyAssetStream(a,await io.local(a));
  for(const a of plan.assets){
    let remote=(await io.list()).filter(r=>r.name===a.name);
    if(remote.length>1)throw Error('Ambiguous duplicate remote asset: '+a.name);
    const previous=state.assets[a.name];
    if(remote[0]?.state==='uploaded'){
      const r=remote[0];
      if(r.size!==a.bytes||(r.digest&&r.digest!=='sha256:'+a.sha256))throw Error('Completed asset conflicts; never overwrite: '+a.name);
      const verified=await verifyAssetStream(a,await io.download(r));
      await save(a.name,'verified',{attempted:true,remoteId:r.id,...verified});continue;
    }
    if(remote.length){
      const r=remote[0],user=await io.currentUser();
      if(r.state!=='starter'||!allowRepairIncomplete||!release.draft||r.uploader?.id!==user.id||r.label!==assetLabel(plan,a)
        ||!previous?.attempted)throw Error('Incomplete asset is not an authorized owned draft placeholder: '+a.name);
      // Recheck immediately; a completed or changed asset must never be deleted.
      const current=await io.asset(r.id),freshRelease=await io.release();
      if(current.state!=='starter'||current.name!==a.name||current.label!==r.label||current.uploader?.id!==user.id||!freshRelease.draft)throw Error('Draft placeholder changed before repair');
      await save(a.name,'repair-intent',{remoteId:r.id});
      await io.remove(r.id);await save(a.name,'repaired',{history:[...(previous.history??[]),{status:previous.status,remoteId:r.id}]});
      remote=[];
    }else if(previous?.attempted&&!['repaired'].includes(previous.status)){
      await save(a.name,'indeterminate');continue; // Missing acknowledgement is never permission to repeat an upload.
    }
    if(!allowUpload){await save(a.name,'not-uploaded');continue;}
    await save(a.name,'submitting',{attempted:true,label:assetLabel(plan,a)});
    try {await io.upload(a,assetLabel(plan,a));}
    catch(error){await save(a.name,'indeterminate');throw error;}
    const uploaded=(await io.list()).filter(r=>r.name===a.name);
    if(uploaded.length!==1||uploaded[0].state!=='uploaded'){await save(a.name,'pending');continue;}
    if(uploaded[0].size!==a.bytes)throw Error('Uploaded asset size conflict');
    const verified=await verifyAssetStream(a,await io.download(uploaded[0]));
    await save(a.name,'verified',{attempted:true,remoteId:uploaded[0].id,...verified});
  }
  const verified=plan.assets.every(a=>state.assets[a.name]?.status==='verified');
  return {status:verified?'verified':'pending',journal:state,allAssetsVerified:verified,releasePublished:false,pagesDeployed:false};
}
