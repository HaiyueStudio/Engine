import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'haiyue-publication-policy-'));
  const report=resolve(directory,'packages.json'),qualification=resolve(directory,'qualification.json'),plan=resolve(directory,'plan.json');
  const bytes=Buffer.from('test-only immutable bytes'),file=resolve(directory,'test.tgz');writeFileSync(file,bytes);
  const source={gate:{status:'passed'},sourceState:{revision:'a'.repeat(40),workingTreeDirty:false},
    packages:['engine','animation-spec','extensions','shader-language'].map(n=>({name:'@haiyue/'+n,version:'0.2.2',artifact:file,sha256:hash(bytes)}))};
  const save=()=>{writeFileSync(report,JSON.stringify(source));writeFileSync(qualification,JSON.stringify({goal:'g13-integration-release',revision:source.sourceState.revision,
    fullG13Complete:true,releaseQualified:true,packageReport:{sha256:hash(readFileSync(report))}}));};save();
  return{directory,source,report,qualification,plan,save,run:()=>spawnSync(process.execPath,['scripts/publication.mjs','plan','--packages',report,'--qualification',qualification,'--plan',plan],{cwd:root,encoding:'utf8'})};
}
test('offline CLI freezes exact report/qualification/tarball bytes without publication and refuses overwrite',()=>{
  const f=fixture();try{
    const r=f.run();assert.equal(r.status,0,r.stderr);const plan=JSON.parse(readFileSync(f.plan));
    assert.equal(plan.packages.length,4);assert.equal(plan.dirty,false);assert.ok(plan.packages.every(p=>p.sha256===f.source.packages[0].sha256));
    assert.notEqual(f.run().status,0,'immutable plan cannot be overwritten');
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('dirty or unqualified candidate cannot produce a publication plan',()=>{
  const f=fixture();try{
    f.source.sourceState.workingTreeDirty=true;f.save();assert.notEqual(f.run().status,0);assert.equal(existsSync(f.plan),false);
    f.source.sourceState.workingTreeDirty=false;f.save();const q=JSON.parse(readFileSync(f.qualification));q.fullG13Complete=false;writeFileSync(f.qualification,JSON.stringify(q));
    assert.notEqual(f.run().status,0);assert.equal(existsSync(f.plan),false);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('tampered package bytes stop plan creation before any network request',()=>{
  const f=fixture();try{writeFileSync(f.source.packages[0].artifact,'changed');assert.notEqual(f.run().status,0);assert.equal(existsSync(f.plan),false);}
  finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('G11 per-package plan and local preflight execute without a network or submission',()=>{
  const f=fixture();try{
    for(const p of f.source.packages)p.version=p.name==='@haiyue/animation-spec'?'0.2.2':'0.2.3';f.save();
    const q=JSON.parse(readFileSync(f.qualification));Object.assign(q,{goal:'g11-integration-candidate',fullG11Complete:true,targetVersion:'0.2.3'});writeFileSync(f.qualification,JSON.stringify(q));
    const result=f.run();assert.equal(result.status,0,result.stderr);const plan=JSON.parse(readFileSync(f.plan));assert.equal(plan.schemaVersion,2);assert.equal(plan.version,'0.2.3');
    const journal=resolve(f.directory,'journal.json');const preflight=spawnSync(process.execPath,['scripts/publication.mjs','preflight','--plan',f.plan,'--journal',journal],{cwd:root,encoding:'utf8'});
    assert.equal(preflight.status,0,preflight.stderr);const state=JSON.parse(preflight.stdout);assert.equal(state.networkUsed,false);assert.equal(state.submitted,false);assert.equal(existsSync(journal),false);
    const noJournal=spawnSync(process.execPath,['scripts/publication.mjs','preflight','--plan',f.plan],{cwd:root,encoding:'utf8'});assert.equal(noJournal.status,0,noJournal.stderr);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('G07 plans only the two new versions and rejects incomplete device qualification',()=>{
  const f=fixture();
  try{
    for(const entry of f.source.packages)entry.version=entry.name==='@haiyue/animation-spec'?'0.2.2':
      entry.name==='@haiyue/shader-language'?'0.2.3':'0.2.4';
    f.save();
    const q=JSON.parse(readFileSync(f.qualification));
    const unchanged=f.source.packages.filter(entry=>entry.version!=='0.2.4');
    Object.assign(q,{goal:'g07-integration-candidate',fullG07Complete:true,targetVersion:'0.2.4',
      verification:{windowsDevice:'passed',macDevice:'pending',productionPerformance:'passed',globalGate:'passed',rehearsal:'passed'},
      unchangedPackages:Object.fromEntries(unchanged.map(entry=>[entry.name,{
        version:entry.version,sha256:entry.sha256,integrity:'sha512-'+createHash('sha512').update(readFileSync(entry.artifact)).digest('base64'),
      }]))});
    const save=()=>writeFileSync(f.qualification,JSON.stringify(q));
    save();
    assert.match(f.run().stderr,/macDevice/);
    assert.equal(existsSync(f.plan),false);
    q.verification.macDevice='passed';
    const original=q.unchangedPackages['@haiyue/animation-spec'].sha256;
    q.unchangedPackages['@haiyue/animation-spec'].sha256='f'.repeat(64);
    save();
    assert.match(f.run().stderr,/unchanged package/);
    q.unchangedPackages['@haiyue/animation-spec'].sha256=original;
    save();
    const planned=f.run();assert.equal(planned.status,0,planned.stderr);
    const plan=JSON.parse(readFileSync(f.plan));
    assert.deepEqual(plan.packages.map(entry=>entry.name),['@haiyue/engine','@haiyue/extensions']);
    const preflight=()=>spawnSync(process.execPath,['scripts/publication.mjs','preflight','--plan',f.plan],{cwd:root,encoding:'utf8'});
    assert.equal(preflight().status,0);
    plan.packages.reverse();writeFileSync(f.plan,JSON.stringify(plan));
    assert.match(preflight().stderr,/publication set/);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
