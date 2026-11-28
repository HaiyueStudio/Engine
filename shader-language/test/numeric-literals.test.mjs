import test from 'node:test';import assert from 'node:assert/strict';
import {composeShaderModules,compileShaderIrProgramToGlslEs300,defineTypedShaderModule,defineShaderModule} from '../dist/index.js';
import {compileMaterialGraphDocumentV1} from '../dist/material-graph.js';
import {numericLiteralCases,literalProgram} from './fixtures/numeric-literals.mjs';
for(const [id,value,literal] of numericLiteralCases)test(`both shader backends preserve the ${id} float literal`,()=>{
 const typed=literalProgram(id,value),wgsl=composeShaderModules({label:id,entry:typed.module}),glsl=compileShaderIrProgramToGlslEs300(typed.ir),fragment=glsl.entries.find(entry=>entry.stage==='fragment');
 assert(wgsl.code.includes(`vec4<f32>(${literal}f, ${literal}f, ${literal}f, 1.0f)`),wgsl.code);
 assert(fragment.code.includes(`vec4(${literal}, ${literal}, ${literal}, 1.0)`),fragment.code);
 assert.doesNotMatch(wgsl.code+fragment.code,/[eE][+-]?\d+\.0/);
 assert.equal(glsl.canonicalHash,typed.ir.canonicalHash);
});
test('scalar float and vector elements use the same backend literal rule',()=>{
 const type={dataType:'f32'},typed=defineTypedShaderModule({id:'scalar.exponent',entries:[{id:'fragmentMain',name:'fragmentMain',stage:'fragment',output:{type,location:0},build:builder=>builder.literal(type,1e21)}]});
 assert.match(composeShaderModules({label:'scalar.exponent',entry:typed.module}).code,/1e\+21f/);assert.match(compileShaderIrProgramToGlslEs300(typed.ir).entries[0].code,/1e\+21/);
});
test('the public material graph compiler emits valid scientific notation',()=>{
 const graph={format:'haiyue-shader-graph',version:1,kind:'material',profile:'webgpu-portable',resources:[],nodes:[],outputs:{baseColor:{literal:{type:'color3<f32>',value:[1e21,-1e21,1e30],colorSpace:'linear'}}}};
 const result=compileMaterialGraphDocumentV1(graph);assert.equal(result.ok,true,JSON.stringify(result.diagnostics));assert.doesNotMatch(result.artifact.source.code,/[eE][+-]?\d+\.0f/);assert.match(result.artifact.source.code,/1e\+21f/);
});
for(const value of [NaN,Infinity,-Infinity])test(`non-finite ${value} remains rejected before backend emission`,()=>assert.throws(()=>literalProgram('invalid',value)));

for (const value of [1e21, -1e21, 1e30, 1e-7, 42]) {
 test(`specialization default and override preserve the float ${value}`, () => {
  const entry = defaultValue => defineShaderModule({
   id:'numeric.specialization', stages:['fragment'],
   entryPoints:[{id:'fragmentMain',name:'fragmentMain',stage:'fragment'}],
   specializations:[{id:'numeric.value',type:'f32',defaultValue}],
   source: context => `@fragment fn ${context.entryPoint('fragmentMain')}()->@location(0) vec4<f32>{return vec4<f32>(${context.specialization('numeric.value')});}`,
  });
  const defaults=composeShaderModules({label:'numeric',entry:entry(value)});
  const overrides=composeShaderModules({label:'numeric',entry:entry(1),specializationValues:{'numeric.value':value}});
  const text=String(value), literal=Number.isInteger(value)&&!/[eE]/.test(text)?`${text}.0`:text;
  for(const result of [defaults,overrides]) {
   assert.ok(result.code.includes(`: f32 = ${literal};`), result.code);
   assert.doesNotMatch(result.code,/[eE][+-]?\d+\.0/);
  }
  assert.equal(defaults.code,overrides.code);
  assert.equal(overrides.code,composeShaderModules({label:'numeric',entry:entry(1),specializationValues:{'numeric.value':value}}).code);
 });
}
