import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,posix} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {npmArgs,npmCommand,resolveNpmCli,tarCommand} from './npm-process.mjs';
import {assertPublicationTerminal,runTerminalNpm} from './publication-terminal.mjs';
import {createDeterministicTar} from './release-archive.mjs';
import {stageQualifiedPackages} from './hya-corpus/packed-browser.mjs';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),tty={stdin:{isTTY:true},stdout:{isTTY:true},stderr:{isTTY:true}};
test('npm locator handles relocated Node, Debian share layout and PATH symlink without hardcoded Windows path',()=>{
 const env={},found=new Set(['/opt/node/lib/node_modules/npm/bin/npm-cli.js']);
 const opts={execPath:'/opt/node/bin/node',paths:posix,pathDelimiter:':',exists:p=>found.has(p),realpath:p=>p};
 assert.equal(resolveNpmCli(env,opts),'/opt/node/lib/node_modules/npm/bin/npm-cli.js');
 found.clear();found.add('/usr/share/nodejs/npm/bin/npm-cli.js');assert.equal(resolveNpmCli(env,{...opts,execPath:'/usr/bin/node'}),'/usr/share/nodejs/npm/bin/npm-cli.js');
 found.clear();found.add('/custom/bin/npm');found.add('/srv/npm/bin/npm-cli.js');assert.equal(resolveNpmCli({PATH:'/custom/bin'}, {...opts,realpath:()=>'/srv/npm/bin/npm-cli.js'}),'/srv/npm/bin/npm-cli.js');
 assert.throws(()=>resolveNpmCli({}, {...opts,exists:()=>false}),/Unable to locate/);
 assert.equal(npmCommand(),process.execPath);assert.ok(npmArgs(['--version'])[0].endsWith('npm-cli.js'));
});
test('any piped console stream rejects before creating a process',()=>{
 for(const stream of ['stdin','stdout','stderr'])assert.throws(()=>assertPublicationTerminal({...tty,[stream]:{isTTY:false}}),/G02_TERMINAL_REQUIRED/);
});
test('interactive process inherits real terminal; only sanitized npm diagnostics persist',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-terminal-'));
 try{
  let options;const result=await runTerminalNpm(['publish','frozen.tgz'],{cwd:root,logPath:resolve(dir,'result.log'),streams:tty,
    spawnImpl:(_c,_a,o)=>{options=o;const child=new EventEmitter();queueMicrotask(()=>{writeFileSync(resolve(o.env.npm_config_logs_dir,'error.log'),'\x1b[31merror code EOTP\x00\npassword=private npm_secret\nauthorization: Bearer hidden-value\nhttps://www.npmjs.com/auth/cli/fresh-link\n');child.emit('close',1,null);});return child;}});
  assert.equal(options.stdio,'inherit');assert.equal(result.reason,'authentication');
  const saved=readFileSync(resolve(dir,'result.log'),'utf8');for(const secret of ['private','npm_secret','hidden-value','fresh-link','\x1b','\x00'])assert.ok(!saved.includes(secret));
  assert.equal(existsSync(options.env.npm_config_logs_dir),false,'owned transient npm log scratch removed');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unknown nonzero exit stays indeterminate and never becomes an auth retry',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-terminal-'));try{const r=await runTerminalNpm(['--version'],{cwd:root,logPath:resolve(dir,'out.log'),streams:tty,spawnImpl:()=>{const c=new EventEmitter();queueMicrotask(()=>c.emit('close',1,null));return c;}});assert.equal(r.status,'indeterminate');assert.equal(r.reason,undefined);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual system tar extracts deterministic bytes with no tar.exe platform assumption',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-tar-'));try{const source=resolve(dir,'source.txt');writeFileSync(source,'exact\x00binary');const archive=resolve(dir,'test.tar');createDeterministicTar(archive,[{source,prefix:'source.txt'}]);const extracted=resolve(dir,'extracted');mkdirSync(extracted);const result=spawnSync(tarCommand(),['-xf',archive,'-C',extracted],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(resolve(extracted,'source.txt')),Buffer.from('exact\x00binary'));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('the actual packed-browser stager extracts all four hashed package fixtures on this platform',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02 packed browser '));
 try{
  const packages=[];
  for(const workspace of ['engine','animation-spec','extensions','shader-language']){
   const source=resolve(dir,workspace);mkdirSync(resolve(source,'dist'),{recursive:true});
   writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@haiyue/'+workspace,version:'0.2.2',exports:{'.':'./dist/index.js'}}));
   writeFileSync(resolve(source,'dist/index.js'),'export const fixture=true;');
   const artifact=resolve(dir,workspace+'.tar');createDeterministicTar(artifact,[{source,prefix:'package'}]);
   packages.push({workspace,name:'@haiyue/'+workspace,version:'0.2.2',artifact,sha256:createHash('sha256').update(readFileSync(artifact)).digest('hex')});
  }
  const report=resolve(dir,'packages.json');writeFileSync(report,JSON.stringify({gate:{status:'passed'},packages}));
  const result=stageQualifiedPackages(dir,report,resolve(dir,'staged'));assert.equal(result.tarballs.length,4);assert.equal(result.imports['@haiyue/engine'],'/g12-packed/engine/dist/index.js');
  assert.equal(readFileSync(resolve(result.mount.directory,'engine/dist/index.js'),'utf8'),'export const fixture=true;');
  writeFileSync(packages[0].artifact,'tampered');assert.throws(()=>stageQualifiedPackages(dir,report,resolve(dir,'rejected')),/tarball changed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual npm --version sees three real TTYs in an independent native console',{skip:!['win32','linux'].includes(process.platform)},()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'g02-physical-tty-')),output=resolve(dir,'probe.json');
 try{
  let result;
  if(process.platform==='win32'){
   const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
   const source="$ErrorActionPreference='Stop'; $a=@(('\"'+$env:G02_PROBE+'\"'),'--output',('\"'+$env:G02_OUTPUT+'\"')); $p=Start-Process -FilePath $env:G02_NODE -ArgumentList $a -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode";
   result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',source],{env:{...process.env,G02_NODE:process.execPath,G02_PROBE:resolve(root,'scripts/publication-tty-probe.mjs'),G02_OUTPUT:output},encoding:'utf8',windowsHide:true,timeout:30000});
  }else{
   const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
   result=spawnSync('script',['-q','-e','-c',[process.execPath,resolve(root,'scripts/publication-tty-probe.mjs'),'--output',output].map(quote).join(' '),'/dev/null'],{encoding:'utf8',timeout:30000});
  }
  assert.equal(result.status,0,result.stderr??result.error?.message);const report=JSON.parse(readFileSync(output));assert.equal(report.status,'passed',report.error);assert.deepEqual(report.tty,{stdin:true,stdout:true,stderr:true});assert.equal(report.published,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
