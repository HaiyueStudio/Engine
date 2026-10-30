import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {verifyServedBytes,stageQualifiedPackages,sha256} from './packed-browser.mjs';

test('HTTP provenance rejects missing, modified, truncated and escaping served assets',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'hya-provenance-'));
 try{
  const packed=resolve(root,'packed');mkdirSync(packed);writeFileSync(resolve(packed,'asset.js'),'export {};');
  const mounts=[{prefix:'/g12-packed',directory:packed}],entry={sourcePath:'g12-packed/asset.js',byteLength:10,sha256:sha256('export {};')};
  const verify=files=>verifyServedBytes(root,mounts,{httpProvenance:{files}},{requiredPackages:[]});
  assert.equal(verify([entry]).status,'passed');assert.equal(verify([]).status,'failed');
  assert.deepEqual(verifyServedBytes(root,mounts,{httpProvenance:{files:[entry]}}).missingPackages,['engine','extensions','animation-spec']);
  for(const patch of [{byteLength:9},{sha256:sha256('changed')},{sourcePath:'g12-packed/missing'},{sourcePath:'g12-packed/../outside'},{sourcePath:'../outside'}])assert.equal(verify([{...entry,...patch}]).status,'failed');
  writeFileSync(resolve(packed,'asset.js'),'modified');assert.equal(verify([entry]).status,'failed');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('package staging rejects failed, duplicate and tampered qualifications before extraction',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'hya-qualified-'));
 try{
  const report=resolve(root,'report.json'),stage=value=>{writeFileSync(report,JSON.stringify(value));return()=>stageQualifiedPackages(root,report,resolve(root,'output'));};
  assert.throws(stage({gate:{status:'failed'},packages:[]}));
  assert.throws(stage({gate:{status:'passed'},packages:Array(4).fill({workspace:'engine'})}));
  writeFileSync(resolve(root,'changed.tgz'),'not the qualified tarball');
  const packages=['engine','animation-spec','extensions','shader-language'].map(workspace=>({workspace,name:'@haiyue/'+workspace,artifact:'changed.tgz',sha256:'0'.repeat(64)}));
  assert.throws(stage({gate:{status:'passed'},packages}),/Qualified tarball changed/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
