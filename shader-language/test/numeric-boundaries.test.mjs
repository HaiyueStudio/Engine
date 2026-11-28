import test from 'node:test';
import assert from 'node:assert/strict';
import {defineTypedShaderModule,defineShaderModule,composeShaderModules,validateShaderIrProgram,compileShaderIrProgramToGlslEs300,computeShaderIrCanonicalHash} from '../dist/index.js';
import {compileMaterialGraphDocumentV1} from '../dist/material-graph.js';
const literal=(dataType,value)=>defineTypedShaderModule({id:'boundary.literal',entries:[{id:'main',name:'main',stage:'fragment',output:{type:{dataType},location:0},build:b=>b.literal({dataType},value)}]});
const module=(type,defaultValue)=>defineShaderModule({id:'boundary.specialization',stages:['fragment'],entryPoints:[{id:'main',name:'main',stage:'fragment'}],specializations:[{id:'boundary.value',type,defaultValue}],source:c=>`@fragment fn ${c.entryPoint('main')}()->@location(0) ${type}{return ${c.specialization('boundary.value')};}`});
const invalid=[['i32',2147483648],['i32',-2147483649],['i32',1.5],['u32',4294967296],['u32',-1],['f32',1e39],['f32',-1e39]];
for(const [type,value]of invalid)test(`${type} ${value} rejects at scalar, vector, external IR and specialization admission`,()=>{
 assert.throws(()=>literal(type,value));
 assert.throws(()=>literal(`vec3<${type}>`,[0,value,1]));
 const external=structuredClone(literal(type,1).ir);external.entries[0].nodes[0].payload.value=value;
 external.canonicalHash=computeShaderIrCanonicalHash(external);
 assert.throws(()=>validateShaderIrProgram(external),/representable|type mismatch/);
 assert.throws(()=>module(type,value));
 assert.throws(()=>composeShaderModules({label:'override',entry:module(type,1),specializationValues:{'boundary.value':value}}));
});
for(const [type,values]of [['i32',[-2147483648,-2147483647,2147483647]],['u32',[0,4294967295]],['f32',[-0,1e-45,1e21,Math.fround(3.4028234663852886e38)]]])for(const value of values)test(`${type} valid boundary ${value} remains accepted`,()=>{
 const typed=literal(type,value);assert.doesNotThrow(()=>validateShaderIrProgram(typed.ir));assert.doesNotThrow(()=>compileShaderIrProgramToGlslEs300(typed.ir));
 const direct=composeShaderModules({label:'boundary',entry:typed.module}),specialized=composeShaderModules({label:'specialized',entry:module(type,value)});
 if(type==='i32'&&value===-2147483648)for(const output of [direct,specialized])assert.match(output.code,/\(-2147483647i - 1i\)/);
});
test('material graph rejects an overflowing f32 with a structured diagnostic',()=>{
 const result=compileMaterialGraphDocumentV1({format:'haiyue-shader-graph',version:1,kind:'material',profile:'webgpu-portable',resources:[],nodes:[],outputs:{baseColor:{literal:{type:'color3<f32>',value:[1e39,0,0],colorSpace:'linear'}}}});
 assert.equal(result.ok,false);assert.ok(result.diagnostics.length);assert.ok(result.diagnostics[0].path);
});
