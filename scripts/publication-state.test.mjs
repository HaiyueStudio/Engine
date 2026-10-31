import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {writeAtomicState,acquireStateLock,inspectStateLock,removeStaleStateLock} from './release-workflow-state.mjs';
function fixture(fn){const dir=mkdtempSync(resolve(tmpdir(),'g02-state-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
test('atomic state updates preserve complete JSON and locks exclude a second controller',()=>fixture(dir=>{
 const path=resolve(dir,'run.json');writeAtomicState(path,{phase:'first'});writeAtomicState(path,{phase:'last'});assert.equal(JSON.parse(readFileSync(path)).phase,'last');
 const lock=path+'.lock',lease=acquireStateLock(lock,{planId:'frozen'});assert.throws(()=>acquireStateLock(lock,{planId:'frozen'}),/EEXIST/);assert.equal(inspectStateLock(lock,'frozen').alive,true);lease.release();lease.release();assert.equal(existsSync(lock),false);
}));
test('stale unlock requires same manifest, explicit consent and verified dead PID, never kills a process',()=>fixture(dir=>{
 const lock=resolve(dir,'lock');writeFileSync(lock,JSON.stringify({pid:123,manifestId:'one'}));
 assert.throws(()=>removeStaleStateLock(lock,'one','wrong',{isAlive:()=>false}),/explicit/);
 assert.throws(()=>removeStaleStateLock(lock,'two','two',{isAlive:()=>false}),/another/);
 assert.throws(()=>removeStaleStateLock(lock,'one','one',{isAlive:()=>true}),/still alive/);
 removeStaleStateLock(lock,'one','one',{isAlive:()=>false});assert.equal(existsSync(lock),false);
}));
test('replacement lock and malformed/negative PID are retained',()=>fixture(dir=>{
 const path=resolve(dir,'lock'),lease=acquireStateLock(path,{planId:'one'});writeFileSync(path,JSON.stringify({planId:'two',pid:123,nonce:'replacement'}));assert.throws(()=>lease.release(),/ownership changed/);assert.equal(existsSync(path),true);
 writeFileSync(path,JSON.stringify({planId:'one',pid:-1}));assert.throws(()=>inspectStateLock(path,'one'),/invalid/);assert.equal(existsSync(path),true);
}));
