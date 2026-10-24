import {rollup} from 'rollup';
import ts from 'typescript';
import {readFileSync,writeFileSync,mkdirSync,existsSync,symlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../..',import.meta.url));
export async function buildProductionDrawCandidate(){
 const out=resolve(root,'artifacts/engine-0.2.2/g11/draw-candidate-'+Date.now());mkdirSync(out,{recursive:true});
 const virtual=resolve(root,'extensions/src/animation/layout/production/private-draw-fixture.ts');if(existsSync(virtual))throw Error('Virtual fixture source collides with a real file');
 const source=`export {ProductionDrawOwner} from './ProductionDrawOwner.js';
export {compileProductionDrawPlan} from './ProductionDrawPlan.js';
export {ProductionTextureOwner,ProductionTexturePending} from './ProductionTextureOwner.js';
export {ProductionLayoutOwner} from './ProductionLayoutOwner.js';
export {ProductionTextOwner} from '../../text/production/ProductionTextOwner.js';
export {createProductionBrowserFontPort} from '../../text/production/ProductionBrowserFontPort.js';
export {createProductionOutlineFontPort} from '../../text/production/ProductionOutlineFontPort.js';
export {LayoutAssetOwner} from '../parameterized/AssetOwner.js';
export {ProductionCompositionOwner} from '../../production/CompositionOwner.js';
export {ProductionResourcePending} from '../../production/ResourceStage.js';`;
 const bundle=await rollup({input:virtual,external:id=>id.startsWith('@haiyue/engine')||id.startsWith('@haiyue/animation-spec')||['earcut','opentype.js','wgpu-matrix','polygon-clipping/dist/polygon-clipping.esm.js'].includes(id),plugins:[{
  name:'private-source-draw-candidate',resolveId(id,importer){if(resolve(id)===virtual)return virtual;if(!id.startsWith('.'))return null;const p=resolve(dirname(importer),id);for(const value of[p,p.replace(/\.js$/u,'.ts'),p+'.ts',resolve(p,'index.ts')])if(existsSync(value))return value;return null;},
  load(id){if(id===virtual)return source;if(id.endsWith('.wgsl'))return 'export default '+JSON.stringify(readFileSync(id,'utf8'))+';';return null;},
  transform(code,id){if(id.endsWith('.ts'))return ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return null;},
 // Re-exported facade constants can become unused in this private consumer.
 // Missing dependencies and all other build warnings remain fatal.
 }],onwarn(warning){if(!['CIRCULAR_DEPENDENCY','UNUSED_EXTERNAL_IMPORT'].includes(warning.code))throw Error(warning.message);}});
 const stage=resolve(out,'staged'),dist=resolve(stage,'dist');mkdirSync(dist,{recursive:true});
 await bundle.write({dir:dist,format:'esm',entryFileNames:'index.js',chunkFileNames:'internal/[name]-[hash].js'});
 const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const sources=Object.fromEntries(bundle.watchFiles.filter(p=>p!==virtual).map(p=>[p,sha(p)]));await bundle.close();
 writeFileSync(resolve(stage,'package.json'),JSON.stringify({name:'@haiyue/g11-draw-candidate',version:'0.0.0-g11',private:true,type:'module',license:'MIT',files:['dist'],exports:{'.':'./dist/index.js'},haiyueScope:'Private original-renderer draw/lifetime candidate; not formal HyaPlayer or official package qualification'},null,2));
 writeFileSync(resolve(stage,'LICENSE'),readFileSync(resolve(root,'LICENSE')));
 const pack=JSON.parse(execFileSync(process.execPath,[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'pack','--offline','--ignore-scripts','--json','--pack-destination',out],{cwd:stage,encoding:'utf8',windowsHide:true}))[0];
 const tarball=resolve(out,pack.filename),consumer=resolve(out,'consumer');mkdirSync(consumer);execFileSync('tar.exe',['-xf',tarball,'-C',consumer],{windowsHide:true});
 symlinkSync(resolve(root,'node_modules'),resolve(consumer,'package/node_modules'),'junction');
 const record={status:'packed-private-draw-candidate',sourceEntry:source,sources,tarball:{path:tarball,sha256:sha(tarball)},entry:resolve(consumer,'package/dist/index.js'),fullG11Complete:false};
 writeFileSync(resolve(out,'result.json'),JSON.stringify(record,null,2)+'\n');
 return {out,record,entry:record.entry,load:()=>import(pathToFileURL(record.entry).href)};
}
