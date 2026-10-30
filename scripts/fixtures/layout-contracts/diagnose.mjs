import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {cpus,platform,release} from 'node:os';
import {performance} from 'node:perf_hooks';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from '../../../extensions/test/responsive-layout-fixture.mjs';
import {cases,documentFor} from './cases.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState,ensureRealRendererGpuConstants} from '../../benchmark/real-renderer-audit-device.mjs';

const root=resolve(import.meta.dirname,'../../..');
const output=resolve(root,process.argv[2]??'artifacts/engine-0.2.2/g01/baseline.json');
if(!output.startsWith(resolve(root,'artifacts/engine-0.2.2')+'/')&&!output.startsWith(resolve(root,'artifacts/engine-0.2.2')+'\\'))throw Error('Output must remain in artifacts/engine-0.2.2');
const revision=process.argv[3];if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Pass verified current revision as second argument');
const hash=path=>createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
const files=[];
for(const dir of ['engine/src/gui','extensions/src/animation/layout/parameterized','animation-spec/src/layout2d','scripts/fixtures/layout-contracts'])walk(dir);
function walk(dir){for(const name of readdirSync(resolve(root,dir))){const p=dir+'/'+name;if(statSync(resolve(root,p)).isDirectory())walk(p);else files.push(p);}}
const fingerprints=Object.fromEntries(files.sort().map(p=>[p,hash(p)]));
const {spec,runtime}=await loadResponsiveLayoutModules();
const base=responsiveLayoutFixture();
const observations=[];
for(const c of cases){
  const parsed=structuredClone(spec.parseResponsiveLayoutDocument(documentFor(base,c)));
  const evaluator=new runtime.LayoutEvaluator(parsed);
  try{const evaluation=evaluator.evaluate({viewport:[c.width,c.height],dpr:1,time:0});const actual=c.children.map(n=>evaluation.nodes.find(p=>p.nodeId===n.id).rect);observations.push({id:c.id,classification:c.classification,actual,expected:c.expected,differs:JSON.stringify(actual)!==JSON.stringify(c.expected)});}finally{evaluator.dispose();}
}
const {GuiInput,GuiRoot,GuiElement,GuiLabel}=await import('../../../engine/dist/gui.js');
const {GuiRenderer}=await import('../../../engine/dist/experimental.js');
const input=new GuiInput({value:'A\u{1f600}B'});input.setCaret(3);input.deleteBackward();
const unicode={input:'A馃榾B',caretUtf16:3,actual:input.value,expected:'AB',codeUnits:Array.from({length:input.value.length},(_,i)=>input.value.charCodeAt(i)),differs:input.value!=='AB'};
const quantile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
function sample(fn){for(let i=0;i<12;i++)fn(i);const samples=[];for(let i=0;i<30;i++){const t=performance.now();fn(i);samples.push(performance.now()-t);}return {samples,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),maxMs:Math.max(...samples)};}
const cpu=[];
for(let round=0;round<3;round++)for(const count of (round===1?[10000,1000,128]:[128,1000,10000])){
  const children=Array.from({length:count-1},(_,i)=>({id:`n${i}`,parent:'root',kind:i%4===0?'text':'leaf',...(i%4===0?{text:'label'}:{}),style:{width:{unit:'point',value:40},height:{unit:'point',value:24}}}));
  const c={width:1280,height:720,root:{display:'flex',direction:'row',wrap:true,gap:[{unit:'point',value:4},{unit:'point',value:4}]},children};
  const parsed=structuredClone(spec.parseResponsiveLayoutDocument(documentFor(base,c)));
  const evaluator=new runtime.LayoutEvaluator(parsed);
  try{
    for(const changePercent of [0,1,10]){
      const changed=Math.floor(children.length*changePercent/100);
      const timing=sample(i=>{for(let n=0;n<changed;n++)parsed.artboards[0].nodes[n+1].style.width.value=40+(i%2);evaluator.evaluate({viewport:[1280,720],dpr:1,time:i/60});});
      cpu.push({round,count,changePercent,changedNodes:changed,kind:'legacy-hya-full-evaluate',...timing,mutationNote:'diagnostic mutable copy of validated document; not a public authoring update API or incremental-layout evidence'});
    }
  }finally{evaluator.dispose();}
}
ensureRealRendererGpuConstants();
const structural=[];
for(const count of [128,1000,10000]){
  const gui=new GuiRoot({id:'baseline-root',width:320,height:720});
  let layoutCalls=0;
  for(let i=0;i<count-1;i++){
    const options={id:`n${i}`,x:(i%8)*40,y:Math.floor(i/8)*24,width:40,height:24};
    const e=i%4===0?new GuiLabel({...options,text:'AB',fontSize:12}):new GuiElement({...options,style:{backgroundColor:'#334455'}});
    const layout=e.layout.bind(e);e.layout=(...args)=>{layoutCalls++;return layout(...args);};gui.add(e);
  }
  const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device);
  const engine={device,format:'rgba8unorm',displayWidth:1280,displayHeight:720,reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
  const renderer=new GuiRenderer({chars:'AB?',fontSize:12,atlasSize:64,canvasFactory:(width,height)=>({width,height,getContext:()=>({measureText:()=>({width:8,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}})})});
  const frame=()=>{gui.layout(320,720);const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[gui],engine);pass.end();device.queue.submit([encoder.finish()]);gui.clearDirty();};
  frame();const initial=audit.snapshot();layoutCalls=0;
  const timing=sample(frame),after=audit.snapshot();
  const callsBefore=layoutCalls;const visual=sample(i=>{gui.root.children[0].setStyle({color:i%2?'#ffffff':'#eeeeee'});frame();});
  const visualLayoutCalls=layoutCalls-callsBefore;
  renderer.destroy();const residue=audit.snapshot();
  structural.push({count,viewport:[1280,720],guiRegion:[320,720],textRatio:.25,clipped:true,unchanged:timing,visualMutation:visual,unchangedLayoutCalls:callsBefore,visualLayoutCalls,auditInitial:initial,auditAfterUnchanged:after,auditAfterDestroy:residue,measurement:'CPU wall time plus audit device structural counts; no physical GPU timing'});
}
const report={schemaVersion:1,kind:'g01-baseline-diagnostic',status:'captured',revision,generatedAt:new Date().toISOString(),host:{platform:platform(),os:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,node:process.version},scope:'source HYA correctness/CPU plus built GUI audit-device baseline; no release qualification or baseline promotion',configSha256:hash('config/layout-022-contract.json'),contractSnapshot:JSON.parse(readFileSync(resolve(root,'config/layout-022-contract.json'),'utf8')),fingerprints,built:{'engine/dist/gui.js':hash('engine/dist/gui.js'),'engine/dist/experimental.js':hash('engine/dist/experimental.js')},observations,unicode,cpu,structural};
mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:relative(root,output),cases:observations.map(x=>({id:x.id,differs:x.differs})),unicode:unicode.differs,cpuCohorts:cpu.length,structuralCohorts:structural.length}));
