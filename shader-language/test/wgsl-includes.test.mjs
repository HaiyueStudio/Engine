import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rollup} from 'rollup';
import {expandWgslIncludes,mapWgslIncludePosition,wgslBuildIncludes} from '../scripts/wgsl-includes.mjs';
async function fixture(t,files){const root=await mkdtemp(join(tmpdir(),'wgsl-include-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const [path,code] of Object.entries(files))await writeFile(join(root,path),code);return root;}
const modules=names=>names.map(id=>({id,path:`${id}.wgslinc`}));
test('nested/diamond imports emit one declaration and preserve source locations and fingerprints',async t=>{
 const root=await fixture(t,{'entry.wgslinc':'#include <left>\n#include <right>\nfn main() {}\n','left.wgslinc':'#include <shared>\nfn left() {}\n','right.wgslinc':'#include <shared>\nfn right() {}\n','shared.wgslinc':'fn shared() {}\n'});
 const options={root,entry:'entry.wgslinc',modules:modules(['left','right','shared'])},a=await expandWgslIncludes(options);
 assert.equal(a.code.match(/fn shared/g).length,1);assert.equal(a.dependencies.length,4);
 const line=a.code.split('\n').findIndex(l=>l.includes('fn right'))+1;
 assert.deepEqual(mapWgslIncludePosition(a,line,4),{sourceName:'right.wgslinc',line:2,column:4});
 assert.equal(mapWgslIncludePosition(a,0),null);assert.deepEqual(a,await expandWgslIncludes(options));
 await writeFile(join(root,'shared.wgslinc'),'fn shared() { let changed = 1; }\n');
 const b=await expandWgslIncludes(options);assert.notEqual(a.sha256,b.sha256);assert.notEqual(a.code,b.code);
});
test('missing, cyclic, duplicate module IDs and symbol/binding conflicts fail with origin context',async t=>{
 const root=await fixture(t,{'entry.wgslinc':'#include <a>\n#include <b>','a.wgslinc':'fn duplicated() {}','b.wgslinc':'fn duplicated() {}'});
 const options={root,entry:'entry.wgslinc',modules:modules(['a','b'])};
 await assert.rejects(expandWgslIncludes(options),/b.wgslinc:1: duplicate WGSL symbol/);
 await assert.rejects(expandWgslIncludes({...options,modules:modules(['a','a'])}),/duplicate WGSL module/);
 await assert.rejects(expandWgslIncludes({...options,modules:modules(['a'])}),/entry.wgslinc:2: missing/);
 await writeFile(join(root,'a.wgslinc'),'#include <b>');await writeFile(join(root,'b.wgslinc'),'#include <a>');
 await assert.rejects(expandWgslIncludes(options),/cycle:.*a -> b -> a/);
 await writeFile(join(root,'a.wgslinc'),'@group(3) @binding(2) var<uniform> a: vec4<f32>;');
 await writeFile(join(root,'b.wgslinc'),'@binding(2) @group(3) var<uniform> b: vec4<f32>;');
 await assert.rejects(expandWgslIncludes(options),/b.wgslinc:1: duplicate WGSL binding 3:2/);
});
test('imports reject traversal/symlink escapes and statement insertion; comments remain inert',async t=>{
 const root=await fixture(t,{'entry.wgslinc':'#include <a>','a.wgslinc':'fn a() {}'});
 const options={root,entry:'entry.wgslinc',modules:modules(['a'])};
 await mkdir(join(root,'inner'));await symlink(join(root,'a.wgslinc'),join(root,'inner','escape.wgslinc'));
 await assert.rejects(expandWgslIncludes({root:join(root,'inner'),entry:'escape.wgslinc',modules:[]}),/escapes/);
 await assert.rejects(expandWgslIncludes({...options,modules:[{id:'../a',path:'a.wgslinc'}]}),/Invalid/);
 await writeFile(join(root,'entry.wgslinc'),'fn main() {\n#include <a>\n}');await assert.rejects(expandWgslIncludes(options),/module-level/);
 await writeFile(join(root,'entry.wgslinc'),'/* outer /* inner */\n#include <missing>\n*/\n// #include <missing>\n#include <a>');
 const result=await expandWgslIncludes(options);assert.equal(result.dependencies.length,2);assert.ok(result.code.endsWith('fn a() {}'));
});
test('Rollup emits build-only provenance, watches every dependency, and rebuilds a changed leaf using cache',async t=>{
 const root=await fixture(t,{'entry.wgslinc':'#include <a>','a.wgslinc':'fn first() {}','registry.json':JSON.stringify({schemaVersion:1,modules:modules(['a'])})});
 async function build(cache){const bundle=await rollup({input:join(root,'entry.wgslinc'),cache,plugins:[wgslBuildIncludes({root,registryPath:join(root,'registry.json')})]});try{return {cache:bundle.cache,watched:bundle.watchFiles,output:(await bundle.generate({format:'es'})).output};}finally{await bundle.close();}}
 const first=await build();const cached=await build(first.cache);assert.deepEqual(cached.output.map(o=>o.type==='chunk'?o.code:o.source),first.output.map(o=>o.type==='chunk'?o.code:o.source));assert.ok(first.watched.includes(join(root,'a.wgslinc')));assert.ok(first.watched.includes(join(root,'registry.json')));
 await writeFile(join(root,'a.wgslinc'),'fn second() {}');const second=await build(first.cache);
 assert.match(second.output.find(o=>o.type==='chunk').code,/fn second/);
 const proof=JSON.parse(second.output.find(o=>o.fileName==='wgsl-includes.provenance.json').source);
 assert.equal(proof.entries.length,1);assert.equal(proof.entries[0].dependencies.length,2);
});
test('production PBR include frontend is byte-identical to the previous module concatenation',async()=>{
 // node:test may run with the workspace as cwd.
 const actualRoot=new URL('../src/',import.meta.url),actualRegistry=JSON.parse(await readFile(new URL('../wgsl-module-registry.json',import.meta.url),'utf8'));
 const {fileURLToPath}=await import('node:url');
 const result=await expandWgslIncludes({root:fileURLToPath(actualRoot),entry:'material-lighting/stdlib/pbr-common.wgslinc',modules:actualRegistry.modules});
 const previous=(await Promise.all(actualRegistry.modules.map(m=>readFile(new URL(m.path,actualRoot),'utf8')))).join('\n\n');
 assert.equal(result.code,previous);
});
