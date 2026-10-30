import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {snapshotSourceInputs,changedSourceInputs} from './source-snapshot.mjs';
test('source snapshots include nested/new files and detect mutation or disappearance',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'hya-source-')),inside=relative(tmpdir(),root);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));
 try{mkdirSync(resolve(root,'src'));writeFileSync(resolve(root,'src/new.ts'),'before');const snapshot=snapshotSourceInputs(root,['src']);assert.deepEqual(Object.keys(snapshot.inputs),['src/new.ts']);assert.deepEqual(changedSourceInputs(root,snapshot),[]);writeFileSync(resolve(root,'src/new.ts'),'after');assert.deepEqual(changedSourceInputs(root,snapshot),['src/new.ts']);rmSync(resolve(root,'src/new.ts'));assert.deepEqual(changedSourceInputs(root,snapshot),['src/new.ts']);}finally{rmSync(root,{recursive:true,force:true});}
});
