import {randomBytes} from 'node:crypto';
import {openSync,closeSync,writeFileSync,readFileSync,fsyncSync,renameSync,unlinkSync,existsSync} from 'node:fs';

export function writeAtomicState(path,value) {
  const temporary=path+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const fd=openSync(temporary,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
}
function ownerId(record){return record.planId??record.manifestId;}
export function inspectStateLock(path,id,{isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}}={}) {
  if(!existsSync(path))return null;
  const record=JSON.parse(readFileSync(path,'utf8'));
  if(ownerId(record)!==id||!Number.isSafeInteger(record.pid)||record.pid<1)throw Error('Lock belongs to another manifest or has an invalid process identity');
  return {...record,alive:isAlive(record.pid)};
}
export function removeStaleStateLock(path,id,confirmation,options) {
  if(confirmation!==id)throw Error('Stale unlock requires explicit confirmation of this exact manifest ID');
  const owner=inspectStateLock(path,id,options);
  if(!owner)throw Error('No existing crash lock to inspect');
  if(owner.alive)throw Error('Controller is still alive; nothing was terminated');
  unlinkSync(path);
}
export function acquireStateLock(path,record) {
  const fd=openSync(path,'wx'),nonce=randomBytes(16).toString('hex');
  try{writeFileSync(fd,JSON.stringify({...record,nonce,pid:process.pid,startedAt:new Date().toISOString()}));fsyncSync(fd);}
  catch(error){closeSync(fd);throw error;}
  let released=false;
  return {release(){
    if(released)return;released=true;closeSync(fd);
    if(!existsSync(path))return;
    if(JSON.parse(readFileSync(path,'utf8')).nonce!==nonce)throw Error('Lock ownership changed; replacement was retained');
    unlinkSync(path);
  }};
}
