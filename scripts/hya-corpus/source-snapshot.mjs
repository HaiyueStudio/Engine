import {readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Content identities include new source files; a commit plus dirty=true is insufficient. */
export function snapshotSourceInputs(root,paths){
 const files=new Set();
 const visit=file=>{if(statSync(file).isDirectory()){for(const name of readdirSync(file).sort())visit(resolve(file,name));}else files.add(file);};
 for(const path of paths)visit(resolve(root,path));
 const inputs=Object.fromEntries([...files].sort().map(file=>[relative(root,file).replaceAll('\\','/'),sha(readFileSync(file))]));
 return {inputs,sha256:sha(JSON.stringify(inputs))};
}
export function changedSourceInputs(root,snapshot){
 return Object.entries(snapshot.inputs).filter(([file,hash])=>{try{return sha(readFileSync(resolve(root,file)))!==hash;}catch{return true;}}).map(([file])=>file);
}
