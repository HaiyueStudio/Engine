import {rollup} from 'rollup';
import ts from 'typescript';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../..',import.meta.url));
let loaded;
export function loadHyaProductionSource(){return loaded??=build();}
async function build(){
 const directory=resolve(root,'artifacts/engine-0.2.2/g10/format-source-'+Date.now()+'-'+process.pid);
 mkdirSync(directory,{recursive:true});
 const bundle=await rollup({input:resolve(root,'animation-spec/src/hya-production.ts'),plugins:[{
  name:'hya-format-source',
  resolveId(source,importer){
   if(!source.startsWith('.'))return;
   const base=resolve(dirname(importer),source);
   for(const name of [base,base.replace(/\.js$/u,'.ts'),base+'.ts',resolve(base,'index.ts')])if(existsSync(name))return name;
  },
  transform(source,id){if(!id.endsWith('.ts'))return;return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;},
 }],onwarn(warning){if(warning.code!=='CIRCULAR_DEPENDENCY')throw Error(warning.message);}});
 const {output}=await bundle.generate({format:'esm'}),chunk=output.find(item=>item.type==='chunk');
 if(output.length!==1||chunk.imports.length||chunk.dynamicImports.length)throw Error('Format prototype must have one self-contained module.');
 const sourceFiles=bundle.watchFiles.map(path=>({path:path.replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
 if(sourceFiles.some(file=>!file.path.startsWith(resolve(root,'animation-spec/src').replaceAll('\\','/')+'/')))throw Error('Format graph crossed its foundation boundary.');
 const file=resolve(directory,'hya-production.mjs');writeFileSync(file,chunk.code);
 const record={schemaVersion:1,qualification:'private source-format mechanics only; official package exports and G11 runtime remain unqualified',path:file,sha256:createHash('sha256').update(chunk.code).digest('hex'),bytes:Buffer.byteLength(chunk.code),sourceFiles};
 writeFileSync(resolve(directory,'build.json'),JSON.stringify(record,null,2)+'\n');await bundle.close();
 return{spec:await import(pathToFileURL(file).href),record,directory};
}
