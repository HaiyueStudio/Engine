import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateLightingScalingResult } from './webgpu-gate/lighting-scaling-contract.mjs';
import { G01_SAMPLING, G01_BASELINE_CASES, validateG01Baseline, poolG01Cohorts, canonicalInputPaths } from './benchmark/lighting-g01-policy.mjs';
import { parseG01ThermalStatus, validateG01HostSamples } from './benchmark/lighting-g01-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');
const hostCheck = process.argv.includes('--host-check');
if (process.argv.slice(2).some(a=>!['--smoke','--host-check'].includes(a))) throw new Error('Only --smoke and --host-check are supported; default captures the full G01 baseline');
const out = resolve(root, 'artifacts/engine-0.2.1/g01', smoke ? 'smoke' : 'baseline');
mkdirSync(out,{recursive:true});
const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
function hostSample() {
  const output=execFileSync('pmset',['-g','therm'],{encoding:'utf8'});
  const sample={command:'pmset -g therm',observedAt:new Date().toISOString(),output,...parseG01ThermalStatus(output)};
  writeFileSync(resolve(root,'artifacts/engine-0.2.1/g01/host-readiness.json'),JSON.stringify(sample,null,2)+'\n');
  return sample;
}
// Reject known throttling before overwriting any existing capture or input snapshot.
const initialHost=hostSample();
if(hostCheck) {
  console.log(JSON.stringify(initialHost,null,2));
  process.exit(initialHost.ready?0:1);
}
if(!initialHost.ready) throw new Error(`Host not ready: ${initialHost.reasons.join('; ')}. See host-readiness.json`);
const fingerprint = (snapshot = false) => {
  const files = git(['ls-files','-co','--exclude-standard','engine/src','engine/dist','shader-language','scripts','config']).split('\n').filter(Boolean).sort();
  files.push(...execFileSync('rg',['--files','--no-ignore','engine/dist'],{cwd:root,encoding:'utf8'}).trim().split('\n'));
  const h=createHash('sha256'), inventory=[];
  for(const f of canonicalInputPaths(files)) {
    const bytes=readFileSync(resolve(root,f));h.update(f);h.update(bytes);
    if(snapshot) inventory.push({path:f,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const hash=h.digest('hex');
  if(snapshot) {
    writeFileSync(resolve(out,'inputs.json'),JSON.stringify({schemaVersion:1,sourceHash:hash,files:inventory},null,2)+'\n');
    writeFileSync(resolve(out,'contract-at-capture.json'),readFileSync(resolve(root,'config/lighting-performance-021.json')));
  }
  return hash;
};
const sourceHash=fingerprint(true), revision=git(['rev-parse','HEAD']);
const results=[];
const settings=smoke?{warmup:2,samples:3,cohorts:1}:G01_SAMPLING;
for(let cohort=0;cohort<settings.cohorts;cohort++) {
  const devices = cohort%2 ? ['low-power','high-performance'] : ['high-performance','low-power'];
  for(const powerPreference of devices) {
    const cases=smoke ? [G01_BASELINE_CASES[0],G01_BASELINE_CASES[3]] : (cohort%2?[...G01_BASELINE_CASES].reverse():G01_BASELINE_CASES);
    for(const c of cases) {
      console.log(`G01 ${cohort+1}/${settings.cohorts} ${powerPreference} ${c.id}`);
      const beforeHost=hostSample();
      if(!beforeHost.ready) throw new Error('Host entered a limited state before capture; wait for recovery');
      const result=await runChromeWebGpuFixture({root,fixture:`scripts/webgpu-gate/${c.fixture==='instances'?'lighting-g01-instances':'lighting-scaling-fixture'}.html`,query:{...c,powerPreference,warmup:settings.warmup,samples:settings.samples,gpuSamples:settings.samples,resolution:'720p'},timeoutMs:240000,mounts:c.fixture==='lighting'?[{prefix:'/games',directory:resolve(root,'scripts/fixtures/lighting-content')}]:[]});
      const hostSamples=[beforeHost,hostSample()];
      const errors=validateG01Baseline(result,{samples:settings.samples});
      errors.push(...validateG01HostSamples(hostSamples));
      const expected = powerPreference==='high-performance' ? ['amd','rdna-1'] : ['intel','gen-9'];
      if(result.adapter?.vendor!==expected[0] || result.adapter?.architecture!==expected[1]) errors.push('Actual adapter does not match frozen host mapping');
      if(c.fixture==='lighting') errors.push(...validateLightingScalingResult(result));
      const file=`${powerPreference}-${c.id}-${cohort+1}.json`;
      writeFileSync(resolve(out,file),JSON.stringify({schemaVersion:1,tier:'diagnostic-baseline',revision,sourceHash,dirty:git(['status','--porcelain']).length>0,cohort,caseId:c.id,generatedAt:new Date().toISOString(),hostSamples,validationErrors:errors,result},null,2)+'\n');
      if(errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
      results.push({file,cohort,powerPreference,caseId:c.id,result});
      if(fingerprint()!==sourceHash) throw new Error('Source inputs changed during capture');
    }
  }
}
const pooled=[];
if(!smoke) for(const powerPreference of ['high-performance','low-power']) for(const c of G01_BASELINE_CASES) {
  const selected=results.filter(r=>r.powerPreference===powerPreference&&r.caseId===c.id);
  pooled.push({caseId:c.id,powerPreference,files:selected.map(r=>r.file),...poolG01Cohorts(selected.map(r=>r.result))});
}
const identities=new Set(results.map(r=>`${r.result.adapter.vendor}/${r.result.adapter.architecture}`));
if(identities.size!==2) throw new Error('Two distinct actual adapters required; preference labels alone are insufficient');
writeFileSync(resolve(out,'summary.json'),JSON.stringify({schemaVersion:1,status:'passed',tier:smoke?'smoke':'diagnostic-baseline',revision,sourceHash,settings,deviceClasses:['discrete-amd-rdna1','integrated-intel-gen9'],files:results.map(r=>r.file),pooled},null,2)+'\n');
console.log(`G01 ${results.length} captures passed; ${out}`);
