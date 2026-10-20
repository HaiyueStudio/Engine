import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.length!==2)throw Error('G04 acceptance accepts no flags; both native adapter classes are required.');
for(const integrated of [false,true])for(const suite of ['compatibility','g04-suite','g04-output','g04-instances','g04-device','g04-lifecycle','g04-regressions']){
 const script=`scripts/webgpu-gate/run-deferred-${suite}.mjs`;
 console.log(`[G04 acceptance] ${integrated?'integrated':'discrete'} ${suite}`);
 const result=spawnSync(process.execPath,[script,...(integrated?['--integrated']:[])],{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(`${script} failed with ${result.status}; existing evidence retained.`);
}
console.log('[G04 acceptance] Both native adapter matrices passed. This is correctness evidence, not performance or release qualification.');
