import {mkdirSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {resolve, relative, isAbsolute} from 'node:path';
import {runChromeWebGpuFixture} from '../webgpu-gate/chrome-runner.mjs';
import {stageQualifiedPackages, verifyServedBytes, sha256} from './packed-browser.mjs';
import {snapshotSourceInputs, changedSourceInputs} from './source-snapshot.mjs';

const root=process.cwd(),args=process.argv.slice(2),smoke=args.includes('--smoke');
if(smoke)args.splice(args.indexOf('--smoke'),1);
const arg=flag=>{const at=args.indexOf(flag);if(at<0)return;const v=args[at+1];if(!v||v.startsWith('--'))throw Error('Missing '+flag);args.splice(at,2);return v;};
const profile=arg('--profile'),packages=arg('--packages'),output=arg('--output');
if(args.length||!['browser-real-ime','physical-gamepad'].includes(profile)||!packages||!output)throw Error('Required: --profile browser-real-ime|physical-gamepad --packages <report> --output <new G13 child> [--smoke]');
const out=resolve(root,output),inside=relative(resolve(root,'artifacts/engine-0.2.2/g13'),out);
if(!inside||inside==='..'||inside.startsWith('..\\')||inside.startsWith('../')||isAbsolute(inside))throw Error('Physical evidence must be a fresh G13 child.');
mkdirSync(out);const staged=stageQualifiedPackages(root,resolve(root,packages),out);
const assetRoot=resolve(root,'../Native/examples/hya-production/src/assets'),assets=resolve(out,'assets');mkdirSync(assets);
for(const file of ['manifest.json','scene.json','scene-sans.otf','FONT-LICENSE.txt','image.png','alternate.png','tone.wav'])copyFileSync(resolve(assetRoot,file),resolve(assets,file));
const html=resolve(out,'fixture.html');writeFileSync(html,'<!doctype html><meta charset="utf-8"><title>G13 HYA physical input</title><style>body{font:16px system-ui;background:#f0f0f0}canvas{width:480px;height:360px;border:1px solid #789}#progress{white-space:pre-wrap;max-width:700px;height:48px;overflow:auto}#result{font-size:10px}</style><h2>G13 HYA '+profile+'</h2><p id="progress">Preparing…</p><canvas width="480" height="360"></canvas><p><button id="checkpoint">Save checkpoint</button> <button id="finish">Save evidence</button></p><pre id="result"></pre><script type="importmap">'+JSON.stringify({imports:staged.imports})+'</script><script type="module" src="/scripts/fixtures/hya-production/physical-browser.mjs"></script>');
const mounts=[staged.mount,{prefix:'/g13-assets',directory:assets}];
const sourceInputs=snapshotSourceInputs(root,['scripts/hya-corpus/qualify-physical.mjs','scripts/fixtures/hya-production/physical-browser.mjs','scripts/hya-corpus/physical-gamepad-readiness.mjs']);
let result;
try{result=await runChromeWebGpuFixture({root,fixture:relative(root,html).replaceAll('\\','/'),query:{profile,...(smoke?{smoke:'1'}:{})},mounts,
  timeoutMs:smoke?90000:900000,presentation:smoke?null:{mode:'visible',width:1000,height:850},
  acceptedStatuses:['passed','failed','setup-only','awaiting-operator-confirmation'],chunkedResult:true,
  interact:async cdp=>{
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      const r=await cdp.call('Runtime.evaluate',{expression:'({ready:window.g13Physical?.ready,status:document.querySelector("#result").dataset.status,error:document.querySelector("#result").textContent})',returnByValue:true});
      const value=r.result?.result?.value;
      if(value?.status==='failed')throw Error(value.error);
      if(value?.ready){
        const screen=await cdp.call('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(out,'ready.png'),Buffer.from(screen.result.data,'base64'));
        console.log(JSON.stringify({physicalWindowReady:true,profile,smoke,output}));
        if(smoke)await cdp.call('Runtime.evaluate',{expression:'window.g13Physical.finishSmoke()'});
        return;
      }
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error('Physical scene never became ready.');
  }});
}catch(error){result={status:'failed',error:String(error.stack??error),browserFailure:error.browserFailure};}
const servedBytes=verifyServedBytes(root,mounts,result),changed=changedSourceInputs(root,sourceInputs);
if(servedBytes.status!=='passed'||changed.length)result.status='failed';
const report={schemaVersion:1,generatedAt:new Date().toISOString(),profile,smoke,sourceInputs,changed,servedBytes,
  packageReport:{path:packages,sha256:sha256(readFileSync(resolve(root,packages)))},tarballs:staged.tarballs,
  ...result,operatorConfirmation:'pending',physicalInputAccepted:false};
writeFileSync(resolve(out,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,profile,smoke,output,error:report.error,physicalInputAccepted:false}));
if(report.status==='failed')process.exitCode=1;
