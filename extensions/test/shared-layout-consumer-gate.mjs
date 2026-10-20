import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const tsc=resolve(root,'node_modules/typescript/bin/tsc');
execFileSync(process.execPath,[tsc,'-p','extensions/test/shared-layout-pure-tsconfig.json'],{cwd:root,stdio:'pipe'});
const destination=resolve(root,`../_diagnostics/g02-independent-layout-consumer-${Date.now()}`);mkdirSync(destination,{recursive:false});
cpSync(resolve(root,'artifacts/engine-0.2.2/g02/pure-layout'),resolve(destination,'layout'),{recursive:true,errorOnExist:true,force:false});
cpSync(resolve(root,'extensions/test/shared-layout-consumer.ts'),resolve(destination,'consumer.ts'),{errorOnExist:true,force:false});
writeFileSync(resolve(destination,'package.json'),JSON.stringify({type:'module',private:true,dependencies:{}}));
writeFileSync(resolve(destination,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ESNext',module:'NodeNext',moduleResolution:'NodeNext',strict:true,lib:['ESNext'],types:[],noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,skipLibCheck:true,outDir:'out'},include:['consumer.ts']}));
execFileSync(process.execPath,[tsc,'-p',resolve(destination,'tsconfig.json')],{cwd:destination,stdio:'pipe'});
cpSync(resolve(destination,'layout'),resolve(destination,'out/layout'),{recursive:true});
let result;
try{result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"const x=await import('./out/consumer.js');process.stdout.write(JSON.stringify(x.result))"],{cwd:destination,encoding:'utf8'}));}
catch(error){const failure=resolve(root,`artifacts/engine-0.2.2/g02/independent-consumer-failed-${Date.now()}.json`);writeFileSync(failure,JSON.stringify({schemaVersion:1,status:'failed',directory:destination,error:String(error),stdout:String(error.stdout??''),stderr:String(error.stderr??'')},null,2)+'\n');throw error;}
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const files={};for(const folder of ['','layout/'])for(const file of readdirSync(resolve(destination,'layout',folder),{withFileTypes:true}))if(file.isFile())files[`layout/${folder}${file.name}`]=sha(resolve(destination,'layout',folder,file.name));
const output=resolve(root,'artifacts/engine-0.2.2/g02/independent-consumer.json');
writeFileSync(output,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),...result,directory:destination,dependencies:{},compilerLibraries:['ESNext'],types:[],consumerSourceSha256:sha(resolve(destination,'consumer.ts')),builtFiles:files,qualification:'independent compiled module/type consumption; packaged tarball qualification remains G13'},null,2)+'\n');
console.log(JSON.stringify({output,...result}));
