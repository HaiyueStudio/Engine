import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {ensureFrozenHyaFoundationLayout} from './hya-foundation-layout.mjs';
function fixture(t){const root=mkdtempSync(resolve(tmpdir(),'haiyue-foundation-layout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(resolve(root,'config'));mkdirSync(resolve(root,'animation-spec/src'),{recursive:true});writeFileSync(resolve(root,'config/hya-022-contract.json'),JSON.stringify({foundationModules:{cubism:['licensed-clip-baked'],'cubism.ts':['licensed-clip-baked']}}));return root;}
test('a clean checkout restores only the frozen empty directory and leaves the real module unchanged',t=>{
  const root=fixture(t),source=resolve(root,'animation-spec/src/cubism.ts');writeFileSync(source,'export const actualModule = true;\n');const before=readFileSync(source);
  assert.equal(ensureFrozenHyaFoundationLayout(root).required,true);assert.ok(existsSync(resolve(root,'animation-spec/src/cubism')));assert.deepEqual(readdirSync(resolve(root,'animation-spec/src/cubism')),[]);assert.deepEqual(readFileSync(source),before);assert.doesNotThrow(()=>ensureFrozenHyaFoundationLayout(root));
});
test('a missing actual format module cannot be masked by creating an empty directory',t=>{
  const root=fixture(t);assert.throws(()=>ensureFrozenHyaFoundationLayout(root),/module is missing/);assert.equal(existsSync(resolve(root,'animation-spec/src/cubism')),false);
});
test('an unexpected frozen census or occupied file is never overwritten',t=>{
  const root=fixture(t);writeFileSync(resolve(root,'animation-spec/src/cubism.ts'),'real');writeFileSync(resolve(root,'animation-spec/src/cubism'),'occupied');assert.throws(()=>ensureFrozenHyaFoundationLayout(root),/regular directory/);assert.equal(readFileSync(resolve(root,'animation-spec/src/cubism'),'utf8'),'occupied');writeFileSync(resolve(root,'config/hya-022-contract.json'),'{}');assert.throws(()=>ensureFrozenHyaFoundationLayout(root),/census changed/);
});
