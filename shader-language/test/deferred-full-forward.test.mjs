import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileProductionMaterialLightingFamilyV1,createPrecompiledShaderArtifactV2} from '../dist/index.js';
import {loadPrivateBuildModule} from '../scripts/generate-deferred-lighting-production.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourcePath='shader-language/builtin-material-lighting-family.json';
const source=await readFile(new URL('../builtin-material-lighting-family.json',import.meta.url),'utf8');
const base=compileProductionMaterialLightingFamilyV1(source,{sourcePath,sourceSha256:hash(source)}).artifact;
const {buildFullForwardPass}=await loadPrivateBuildModule('shader-language/src/deferred-lighting/full-forward-family.ts');
const {DEFERRED_LIGHTING_ABI_WGSL:abi,DEFERRED_LIGHTING_ABI:layout}=await loadPrivateBuildModule('engine/src/shaders/generated/deferred-lighting-abi.generated.ts');
const lights=await readFile(new URL('../src/deferred-lighting/full-forward.wgsl',import.meta.url),'utf8');
const lightingAo=await readFile(new URL('../src/deferred-lighting/lighting-ao.wgslinc',import.meta.url),'utf8');
const modules={abi,lightingAo,lights,viewHeader:{id:'pass.fullView',alignment:16,byteSize:32,fields:layout.blocks.viewHeader.fields.map(field=>({...field,size:field.type.startsWith('vec4')?16:4}))}};
const ids=['pbr','pbr-clearcoat','pbr-transmission','pbr-transmission-clearcoat'];

test('full-light variants retain every existing material branch and have validated binding reflection',()=>{
  const passes=ids.map(id=>buildFullForwardPass(base.passes[id],modules));
  const artifact=createPrecompiledShaderArtifactV2({compilerVersion:'g04-full-forward',source:{kind:'module-family',path:sourcePath,sha256:hash(source)},canonicalHash:hash(lights),typedModuleHash:hash(lights),passes});
  assert.equal(Object.keys(artifact.passes).length,4);
  for(const [i,pass] of passes.entries()){
    assert.deepEqual(pass.vertexBuffers,base.passes[ids[i]].vertexBuffers);
    assert.deepEqual(pass.bindGroups.slice(0,3),base.passes[ids[i]].bindGroups.slice(0,3));
    assert.equal(pass.bindGroups[3].bindings[0].layout.hasDynamicOffset,true);
    const inherited=structuredClone(pass.bindGroups[3].bindings.slice(0,12));
    inherited[0].layout.hasDynamicOffset=base.passes[ids[i]].bindGroups[3].bindings[0].layout.hasDynamicOffset;
    assert.deepEqual(inherited,base.passes[ids[i]].bindGroups[3].bindings);
    assert.deepEqual(pass.bindGroups[3].bindings.slice(12).map(b=>b.binding),[12,13,14,15]);
    const fragmentBindings=pass.bindGroups.flatMap(g=>g.bindings).filter(b=>b.visibility.includes('fragment'));
    assert.equal(fragmentBindings.filter(b=>b.layout.kind==='buffer'&&b.layout.bufferType.includes('storage')).length,5);
    assert.ok(fragmentBindings.filter(b=>b.layout.kind==='texture').length<=16,'AO must not require a seventeenth sampled texture');
    assert.ok(!pass.passRequirements.includes('eight-light-cap'));
    // Removing only the reviewed light-source edits must reproduce the complete original shader.
    const restored=pass.code.slice(`${lightingAo.replace('__BINDING__','15')}\n\n${abi}\n\n${lights.replaceAll('TRANSMISSION_ENABLED', String(ids[i].includes('transmission')))}\n\n`.length)
      .replace('surface.occlusion * lightingAmbientVisibility(input.clipPos.xy)', 'surface.occlusion')
      .replace('light.color.rgb * light.color.a * lightingAmbientVisibility(input.clipPos.xy)', 'light.color.rgb * light.color.a')
      .replace('  if (!fullForwardOpaqueVisible(input.clipPos)) { discard; }\n', '')
      .replace('index < fullForwardLightCount()','index < min(lights.countVec.x, 8u)')
      .replace('let light = fullForwardLight(index);','let light = lights.lights[index];')
      .replace('light.typeVec.x == 1u && light.typeVec.z < 3u','light.typeVec.x == 1u && index < 3u')
      .replace('shadowVisibility(light.typeVec.z, input.worldPos, n, l)','shadowVisibility(index, input.worldPos, n, l)');
    assert.equal(restored,base.passes[ids[i]].code);
  }
});

test('source contract drift cannot silently leave an eight-light loop or wrong shadow index',()=>{
  const p=base.passes.pbr;
  for(const change of [code=>code.replace('min(lights.countVec.x, 8u)','min(lights.countVec.x, 9u)'),code=>code.replace('let light = lights.lights[index];','let light = lights.lights[0];'),code=>code.replace('shadowVisibility(index,','shadowVisibility(0u,')]){
    assert.throws(()=>buildFullForwardPass({...p,code:change(p.code)},modules),/contract changed/);
  }
  assert.throws(()=>buildFullForwardPass(base.passes.toon,modules),/Unsupported/);
  const collision={...p,bindGroups:p.bindGroups.map(g=>g.physicalGroup===3?{...g,bindings:[...g.bindings,{...g.bindings[0],binding:12}]}:g)};
  assert.throws(()=>buildFullForwardPass(collision,modules),/collide/);
});

test('full Forward production outputs are deterministic and fresh',async()=>{
  const {generateDeferredFullForwardProduction,compileDeferredFullForwardArtifact}=await import('../scripts/generate-deferred-full-forward-production.mjs');
  const result=await generateDeferredFullForwardProduction();
  assert.equal(result.passCount,4);
  assert.deepEqual(result.artifact,await compileDeferredFullForwardArtifact());
});

test('full Forward private artifact contract records exact cost without changing the legacy families',async()=>{
  const contract=JSON.parse(await readFile(new URL('../deferred-full-forward-extension-contract.json',import.meta.url),'utf8'));
  const {generateDeferredFullForwardProduction}=await import('../scripts/generate-deferred-full-forward-production.mjs');
  const result=await generateDeferredFullForwardProduction();
  for(const key of ['artifactHash','passCount','wgslBytes'])assert.equal(result[key],contract[key]);
  assert.equal(contract.publicExport,false);
  assert.deepEqual(Object.keys(result.artifact.passes),contract.variants.map(id=>`deferred-full-${id}`));
});

test('packaged full Forward artifact reconstructs exact WGSL and reflection with shared strings',async()=>{
  const {rollup}=await import('rollup');const {default:ts}=await import('typescript');
  const {wgslRaw}=await import('../../scripts/rollup-plugin-wgsl.js');
  const {compileDeferredFullForwardArtifact}=await import('../scripts/generate-deferred-full-forward-production.mjs');
  const {fileURLToPath}=await import('node:url');
  const input=fileURLToPath(new URL('../../engine/src/shaders/generated/deferred-full-forward-artifact.generated.ts',import.meta.url));
  const bundle=await rollup({input,plugins:[wgslRaw(),{name:'test-strip-types',transform(code,id){if(id.endsWith('.ts'))return {code:ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,map:null};}}]});
  try{
    const {output}=await bundle.generate({format:'es'}),code=output[0].code;
    const {DEFERRED_FULL_FORWARD_SHADER_ARTIFACT:actual}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    assert.deepEqual(actual,await compileDeferredFullForwardArtifact());
    const passes=Object.values(actual.passes);
    for(const field of ['bindGroups','uniformBlocks','vertexBuffers','varyings','renderTargets'])for(const pass of passes)assert.equal(pass[field],passes[0][field]);
    const wgslImports=Object.keys(bundle.cache.modules.reduce((o,m)=>(o[m.id]=true,o),{})).filter(id=>id.endsWith('.wgsl'));
    assert.equal(wgslImports.length,1,'only one complete variant source enters the package');
  }finally{await bundle.close();}
});
