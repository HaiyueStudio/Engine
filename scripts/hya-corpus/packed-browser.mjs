import {tarCommand} from '../npm-process.mjs';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Browser qualification mounts exact already-qualified packages, never workspace dist aliases. */
export function stageQualifiedPackages(root,reportPath,output,{baselineExtensions}={}) {
  const report=JSON.parse(readFileSync(reportPath,'utf8')),expected=['engine','animation-spec','extensions','shader-language'];
  if(report.gate?.status!=='passed'||report.packages?.length!==4||new Set(report.packages.map(p=>p.workspace)).size!==4
    ||report.packages.some(p=>!expected.includes(p.workspace)))throw Error('An independently passing four-package report is required.');
  const packages=resolve(output,'packages'),imports={},tarballs=[];
  for(const entry of report.packages){
    const source=entry.workspace==='extensions'&&baselineExtensions?resolve(baselineExtensions):resolve(root,entry.artifact),bytes=readFileSync(source),hash=sha256(bytes);
    if(!(entry.workspace==='extensions'&&baselineExtensions)&&hash!==entry.sha256)throw Error('Qualified tarball changed: '+entry.name);
    const directory=resolve(packages,entry.workspace);mkdirSync(directory,{recursive:true});execFileSync(tarCommand(),['-xf',source,'--strip-components=1','-C',directory],{windowsHide:true});
    const pkg=JSON.parse(readFileSync(resolve(directory,'package.json'),'utf8'));
    if(pkg.name!==entry.name||pkg.version!==entry.version)throw Error('Extracted package identity changed.');
    for(const [key,value]of Object.entries(pkg.exports??{})){const file=typeof value==='string'?value:value.import;if(file?.endsWith('.js'))imports[pkg.name+(key==='.'?'':key.slice(1))]='/g12-packed/'+entry.workspace+'/'+file.replace(/^\.\//,'');}
    tarballs.push({name:pkg.name,version:pkg.version,sha256:hash,source});
  }
  Object.assign(imports,{'wgpu-matrix':'/node_modules/wgpu-matrix/dist/3.x/wgpu-matrix.module.js','opentype.js':'/node_modules/opentype.js/dist/opentype.module.js',earcut:'/node_modules/earcut/src/earcut.js',tslib:'/node_modules/tslib/tslib.es6.mjs','polygon-clipping/dist/polygon-clipping.esm.js':'/node_modules/polygon-clipping/dist/polygon-clipping.esm.js',splaytree:'/node_modules/splaytree/dist/splaytree.js','robust-predicates':'/node_modules/robust-predicates/index.js'});
  return {report,imports,tarballs,mount:{prefix:'/g12-packed',directory:packages}};
}
export function verifyServedBytes(root,mounts,result,{requiredPackages=['engine','extensions','animation-spec']}={}) {
  const files=result.httpProvenance?.files??[];
  const mismatches=files.filter(entry=>{
    if(typeof entry.sourcePath!=='string')return true;
    const mount=mounts.find(value=>entry.sourcePath.startsWith(value.prefix.slice(1)+'/'));
    const base=resolve(mount?.directory??root),file=mount?resolve(base,entry.sourcePath.slice(mount.prefix.length)):resolve(base,entry.sourcePath);
    const inside=relative(base,file);
    if(!inside||isAbsolute(inside)||inside==='..'||inside.startsWith('../')||inside.startsWith('..\\'))return true;
    try{const bytes=readFileSync(file);return bytes.byteLength!==entry.byteLength||sha256(bytes)!==entry.sha256;}catch{return true;}
  });
  const missingPackages=requiredPackages.filter(workspace=>!files.some(entry=>entry.sourcePath?.startsWith('g12-packed/'+workspace+'/dist/')));
  return {status:files.length&&!mismatches.length&&!missingPackages.length?'passed':'failed',files:files.length,mismatches,missingPackages};
}
