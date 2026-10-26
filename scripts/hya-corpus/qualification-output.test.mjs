import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {qualificationOutput,createQualificationOutput} from './qualification-output.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {relative,isAbsolute} from 'node:path';
test('qualification outputs cannot overwrite cache/latest or escape the named G12 root',()=>{
  const root=resolve('.');
  for(const value of ['', 'animation-spec/corpus/.cache','animation-spec/corpus/results','artifacts/engine-0.2.2/g12','artifacts/engine-0.2.2/g12/../g11','../other'])
    assert.throws(()=>qualificationOutput(root,value));
  const output=qualificationOutput(root,'artifacts/engine-0.2.2/g12/test/round-1');
  assert.equal(output.browserInput,resolve(root,'artifacts/engine-0.2.2/g12/test/round-1/browser-input.json'));
});
test('a repeated output cannot replace prior evidence, including a failed attempt',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'hya-output-')),inside=relative(tmpdir(),root);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));
 try{const output=createQualificationOutput(root,'artifacts/engine-0.2.2/g12/run');writeFileSync(resolve(output.directory,'result.json'),'failed-original');assert.throws(()=>createQualificationOutput(root,'artifacts/engine-0.2.2/g12/run'),{code:'EEXIST'});assert.equal(readFileSync(resolve(output.directory,'result.json'),'utf8'),'failed-original');}finally{rmSync(root,{recursive:true,force:true});}
});
