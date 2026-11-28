import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {haiyuePlugins} from '../../config/rollup.shared.js';
const root=resolve(import.meta.dirname,'../..'),output=resolve(process.env.F30_F32_OUTPUT??'artifacts/tech-debt-f30-f32/browser');
if(!output.startsWith(resolve(root,'artifacts')+sep))throw Error('Fixture output must stay under Engine/artifacts');
const before=process.env.F30_F32_BEFORE?resolve(process.env.F30_F32_BEFORE):null;
if(before&&!before.startsWith(resolve(root,'artifacts')+sep))throw Error('Diagnostic before bytes must stay under Engine/artifacts');
const overrides=new Set(['engine/src/renderer/BaseRenderer.ts','engine/src/renderer/ToonRenderer.ts','extensions/src/animation/production/ProductionCoreStateVisualRuntime.ts']);
const aliases={};for(const workspace of ['engine','animation-spec','extensions']){const pkg=JSON.parse(readFileSync(resolve(root,workspace,'package.json')));for(const[key,entry]of Object.entries(pkg.exports)){const target=typeof entry==='string'?entry:entry.import;if(target?.startsWith('./dist/')&&target.endsWith('.js'))aliases[pkg.name+(key==='.'?'':key.slice(1))]=resolve(root,workspace,'src',target.slice(7).replace(/\.js$/,'.ts'));}}
const effective=new Map();
export default {
 input:resolve(import.meta.dirname,'f30-f32-native-api.ts'),output:{dir:output,format:'es',entryFileNames:'bundle.js',chunkFileNames:'chunks/[name]-[hash].js'},
 plugins:[{
  name:'fixture-effective-source',
  resolveId(id,importer){if(!id.startsWith('.')||!importer)return null;const path=resolve(dirname(importer),id);if(path.endsWith('.js')&&!existsSync(path)&&existsSync(path.slice(0,-3)+'.ts'))return path.slice(0,-3)+'.ts';return null;},
  load(id){const name=relative(root,id).replaceAll('\\','/');if(before&&overrides.has(name)){const bytes=readFileSync(resolve(before,name));effective.set(id,bytes);return bytes.toString('utf8');}return null;},
  writeBundle(){const sources=[...this.getModuleIds()].filter(id=>existsSync(id)).map(path=>{const bytes=effective.get(path)??readFileSync(path);return{path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),beforeOverride:effective.has(path)};});writeFileSync(resolve(output,'sources.json'),JSON.stringify({before,sources},null,2)+'\n');}
 },...haiyuePlugins({localPackages:aliases,resolveExtensions:['.mjs','.js','.ts','.json'],typescriptPlugin:{name:'fixture-typescript-transpile',transform(code,id){if(!id.endsWith('.ts'))return null;return{code:ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:id}).outputText,map:null};}}})],
 onwarn(warning,warn){if(warning.code==='CIRCULAR_DEPENDENCY')return;warn(warning);}
};
