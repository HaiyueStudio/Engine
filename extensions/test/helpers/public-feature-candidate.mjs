import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {npmCommand,npmArgs,tarCommand} from '../../../scripts/npm-process.mjs';
export const root=fileURLToPath(new URL('../../../',import.meta.url));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Actual npm installation shared by focused feature gates; never a source alias. */
export function preparePublicFeatureCandidate({output,application,types,smoke,reportPath,inputs=[]}){
 const out=resolve(root,output),consumer=resolve(out,'consumer');
 const inside=relative(resolve(root,'artifacts'),out);
 if(!inside||isAbsolute(inside)||inside.startsWith('..')||existsSync(resolve(out,'candidate.json')))throw Error('Select a new output under artifacts.');
 mkdirSync(consumer,{recursive:true});
 const sourceInputs=Object.fromEntries([...new Set([application,...inputs])].map(path=>[path,sha(readFileSync(resolve(root,path)))]));
 const qualified=reportPath?JSON.parse(readFileSync(resolve(root,reportPath))):null;
 if(qualified&&qualified.gate?.status!=='passed')throw Error('Public package gate must pass first.');
 const packages=[];
 for(const workspace of ['engine','extensions','animation-spec']){
  const pkg=JSON.parse(readFileSync(resolve(root,workspace,'package.json')));let file,integrity;
  if(qualified){const p=qualified.packages.find(p=>p.name===pkg.name);if(!p||p.version!==pkg.version||p.sha256!==p.deterministicRepackSha256)throw Error('Invalid deterministic package: '+pkg.name);file=resolve(root,p.artifact);if(sha(readFileSync(file))!==p.sha256)throw Error('Qualified bytes changed.');}
  else{const p=JSON.parse(execFileSync(npmCommand(),npmArgs(['pack','./'+workspace,'--offline','--ignore-scripts','--json','--pack-destination',out]),{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024}))[0];file=resolve(out,p.filename);integrity=p.integrity;}
  const bytes=readFileSync(file);packages.push({workspace,name:pkg.name,version:pkg.version,file,sha256:sha(bytes),integrity:integrity??'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length});
 }
 const dependencies=Object.fromEntries(packages.map(p=>[p.name,'file:'+p.file.replaceAll('\\','/')])),overrides={};
 for(const workspace of ['engine','extensions','animation-spec'])for(const name of Object.keys(JSON.parse(readFileSync(resolve(root,workspace,'package.json'))).dependencies??{}))if(!name.startsWith('@haiyue/'))overrides[name]=JSON.parse(readFileSync(resolve(root,'node_modules',name,'package.json'))).version;
 writeFileSync(resolve(consumer,'package.json'),JSON.stringify({name:'public-feature-consumer',version:'0.0.0',private:true,type:'module',dependencies,overrides},null,2)+'\n');
 const install=execFileSync(npmCommand(),npmArgs(['install','--offline','--ignore-scripts','--no-audit','--no-fund']),{cwd:consumer,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});writeFileSync(resolve(out,'npm-install.log'),install);
 const installedFiles=[];
 for(const p of packages){
  const installed=resolve(consumer,'node_modules',p.name),path=relative(consumer,realpathSync(installed));
  if(isAbsolute(path)||path.startsWith('..'))throw Error('Package escaped isolated consumer.');
  const actual=JSON.parse(readFileSync(resolve(installed,'package.json')));if(actual.name!==p.name||actual.version!==p.version||sha(readFileSync(p.file))!==p.sha256)throw Error('Installed identity/bytes changed.');
  const expected=resolve(out,'expected',p.workspace);mkdirSync(expected,{recursive:true});execFileSync(tarCommand(),['-xf',p.file,'--strip-components=1','-C',expected],{windowsHide:true});
  const files=[];const walk=(directory,prefix='')=>{for(const e of readdirSync(directory,{withFileTypes:true})){const name=prefix+e.name;if(e.isDirectory())walk(resolve(directory,e.name),name+'/');else if(e.isFile())files.push(name);else throw Error('Unexpected package link: '+name);}};walk(expected);
  for(const file of files)if(sha(readFileSync(resolve(expected,file)))!==sha(readFileSync(resolve(installed,file))))throw Error('Installed bytes differ from tarball: '+p.name+'/'+file);
  installedFiles.push({name:p.name,files:files.length,allFileHashesMatched:true});
 }
 const source=readFileSync(resolve(root,application));writeFileSync(resolve(consumer,'application.ts'),source);
 writeFileSync(resolve(consumer,'api-contract.d.ts'),readFileSync(resolve(root,'review/engine-0.2.3/api-contract.d.ts')));writeFileSync(resolve(consumer,'typecheck.ts'),types);
 writeFileSync(resolve(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'bundler',strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,skipLibCheck:false,types:['@webgpu/types'],typeRoots:[resolve(root,'node_modules')],outDir:'browser'},include:['application.ts','typecheck.ts']},null,2));
 writeFileSync(resolve(out,'installed-typecheck.log'),execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:consumer,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}));
 writeFileSync(resolve(consumer,'smoke.mjs'),smoke);writeFileSync(resolve(out,'installed-esm.log'),execFileSync(process.execPath,['smoke.mjs'],{cwd:consumer,encoding:'utf8',windowsHide:true}));
 const imports={},mounts=[{prefix:'/feature-consumer',directory:consumer},{prefix:'/feature-deps',directory:resolve(consumer,'node_modules')}];
 for(const p of packages){const directory=resolve(consumer,'node_modules',p.name),pkg=JSON.parse(readFileSync(resolve(directory,'package.json'))),prefix='/feature-packages/'+p.workspace;mounts.push({prefix,directory});for(const [key,value]of Object.entries(pkg.exports??{})){const file=typeof value==='string'?value:value.import;if(file?.endsWith('.js'))imports[p.name+(key==='.'?'':key.slice(1))]=prefix+'/'+file.replace(/^\.\//,'');}}
 Object.assign(imports,{'wgpu-matrix':'/feature-deps/wgpu-matrix/dist/3.x/wgpu-matrix.module.js','earcut':'/feature-deps/earcut/src/earcut.js','opentype.js':'/feature-deps/opentype.js/dist/opentype.module.js',tslib:'/feature-deps/tslib/tslib.es6.mjs'});
 for(const [path,hash]of Object.entries(sourceInputs))if(sha(readFileSync(resolve(root,path)))!==hash)throw Error('Source changed during candidate construction: '+path);
 const record={schemaVersion:1,status:'passed',role:qualified?'exact deterministic gate tarballs; feature only':'pre-admission diagnostic; raw local tarballs',releaseQualified:false,node:process.version,platform:process.platform,packages,installedFiles,sourceInputs,consumer,application,sourceApplicationSha256:sha(source),compiledApplicationSha256:sha(readFileSync(resolve(consumer,'browser/application.js'))),strictInstalledTypecheck:true,skipLibCheck:false,installedEsm:true,imports,mounts,dependencyVersions:overrides,...(reportPath?{publicPackageReport:{path:reportPath,sha256:sha(readFileSync(resolve(root,reportPath)))}}:{})};
 writeFileSync(resolve(out,'candidate.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});return record;
}
