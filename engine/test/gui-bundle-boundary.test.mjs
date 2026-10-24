import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {rollup} from 'rollup';
import {nodeResolve} from '@rollup/plugin-node-resolve';

test('scene pipeline accessors do not eagerly assemble GUI or scene renderers', async () => {
  const entry = fileURLToPath(new URL('./scene-access-lazy-consumer.mjs', import.meta.url));
  const bundle = await rollup({ input: entry, plugins: [{
    name: 'scene-access-lazy-consumer',
    resolveId(id) { if (id === entry) return id; },
    load(id) { if (id === entry) return `
      export {getSceneRenderPipeline,getSceneRenderIntegration} from '@haiyue/engine/experimental';
      export async function loadGui(){return import('@haiyue/engine/gui');}
    `; },
  }, nodeResolve()], onwarn(warning, handler) {
    if (warning.code !== 'CIRCULAR_DEPENDENCY') handler(warning);
  } });
  try {
    const {output} = await bundle.generate({format:'es', chunkFileNames:'[name]-[hash].js'});
    const chunks = output.filter(value => value.type === 'chunk');
    const initial = new Set();
    const visit = file => {if (initial.has(file)) return; initial.add(file);
      for (const next of chunks.find(chunk => chunk.fileName === file).imports) visit(next);};
    for (const chunk of chunks.filter(value => value.isEntry)) visit(chunk.fileName);
    // Rollup may co-locate the private accessor in a library Scene chunk. Check
    // the emitted reachable code: a filename alone does not prove retained code.
    const eager = chunks.filter(chunk => initial.has(chunk.fileName)).map(chunk => chunk.code).join('\n');
    assert.match(eager, /function getSceneRenderPipeline/);
    assert.doesNotMatch(eager, /class (?:Scene|GuiSystem)|Render3DSystem|opentype|GuiRenderer/);
    const guiOwners = chunks.filter(chunk => Object.keys(chunk.modules).some(id => id.includes('GuiSystem')));
    assert.equal(guiOwners.length, 1, 'deferred GUI uses one shared implementation');
    assert.ok(!initial.has(guiOwners[0].fileName));
  } finally {await bundle.close();}
});

test('public GUI can load as a deferred ESM bundle without the 3D renderer or OpenType parser',async()=>{
  const entry=fileURLToPath(new URL('./gui-lazy-consumer.mjs',import.meta.url));
  const bundle=await rollup({
    input:entry,
    external:id=>id==='wgpu-matrix',
    plugins:[{
      name:'gui-lazy-consumer',
      resolveId(id){if(id===entry)return id;},
      load(id){if(id===entry)return "export async function loadGui(){const {GuiSystem,GuiButton,GuiInput}=await import('@haiyue/engine/gui');return {GuiSystem,GuiButton,GuiInput};}";},
    },nodeResolve()],
    onwarn(warning,defaultHandler){if(warning.code!=='CIRCULAR_DEPENDENCY')defaultHandler(warning);},
  });
  try{
    const {output}=await bundle.generate({format:'es',entryFileNames:'app.js',chunkFileNames:'[name]-[hash].js'});
    const chunks=output.filter(value=>value.type==='chunk'),initial=chunks.find(value=>value.isEntry);
    assert.ok(initial.dynamicImports.length>0,'GUI has a separate deferred chunk');
    assert.deepEqual(Object.keys(initial.modules),[entry],'the application entry has no eagerly loaded GUI implementation');
    const gui=chunks.find(value=>value.isDynamicEntry);
    for(const symbol of ['GuiSystem','GuiButton','GuiInput'])assert.ok(gui.exports.includes(symbol));
    const modules=chunks.flatMap(chunk=>Object.keys(chunk.modules)).join('\n');
    assert.doesNotMatch(modules,/Render3D|PBRMaterial|Rapier|opentype|hya-production|hya-player/i);
    assert.equal(chunks.filter(chunk=>Object.keys(chunk.modules).some(id=>id.includes('GuiSystem'))).length,1,'one shared GUI runtime');
  }finally{await bundle.close();}
});
