import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {qualificationOutput} from './qualification-output.mjs';
import {stageQualifiedPackages,sha256} from './packed-browser.mjs';

const root=process.cwd(),games=resolve(root,'../Games'),arg=(key,fallback)=>{const at=process.argv.indexOf(key);return at<0?fallback:process.argv[at+1];};
const output=qualificationOutput(root,arg('--output','artifacts/engine-0.2.2/g12/product-proposal-'+Date.now())).directory;
mkdirSync(output,{recursive:true});
const staged=stageQualifiedPackages(root,resolve(root,arg('--packages','artifacts/engine-0.2.2/g12/packed-region-20261026/public-packages.json')),output);
const overlays=new Map(),originals={};
function propose(path,bytes){const target=resolve(output,'proposed',path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);overlays.set(resolve(games,path),bytes.toString());}
function modify(path,change){const original=readFileSync(resolve(games,path),'utf8');originals[path]=sha256(original);const changed=change(original);if(changed===original)throw Error('Proposal failed to modify '+path);propose(path,changed);const before=resolve(output,'before',path);mkdirSync(dirname(before),{recursive:true});writeFileSync(before,original);}

const originalScene=JSON.parse(readFileSync('examples/hya-production/scene.json','utf8'));
const layout=structuredClone(originalScene.parts.find(p=>p.id==='layout'));
layout.document.assets=layout.document.assets.filter(asset=>asset.id==='font');
layout.document.textBlocks=[{id:'label',runs:[{id:'run',style:'body',text:'LEVEL 1 COMPLETE',valuePort:'value'}],width:600,height:40,wrap:'none',overflow:'clip'}];
layout.document.textStyles[0].alignment='center';layout.document.textStyles[0].fills[0].source.color=[1,.8,.25,1];
const point=value=>({unit:'point',value}),percent=value=>({unit:'percent',value});
layout.document.artboards=[{id:'main',width:1000,height:650,root:'root',nodes:[{id:'root',kind:'container',style:{width:{unit:'fill'},height:{unit:'fill'}}},{id:'text',parent:'root',kind:'text',text:'label',style:{position:'absolute',inset:[percent(20),percent(30),point(0),point(0)],width:percent(60),height:point(40)}}]}];
layout.document.instances=[{id:'stage',artboard:'main',fit:'fill',alignment:[0,0]}];
const data=structuredClone(originalScene.parts.find(p=>p.id==='data'));data.dependencies=['layout'];data.document.models[0].properties=data.document.models[0].properties.filter(p=>p.id==='label');data.document.models[0].properties[0].defaultValue='LEVEL 1 COMPLETE';data.document.instances[0].values={label:'LEVEL 1 COMPLETE'};data.document.bindings=data.document.bindings.filter(b=>b.id==='value');
const source={format:'haiyue-composition',version:1,parts:[data,layout],targets:[originalScene.targets.find(t=>t.id==='text')]};
propose('games/gravity-maze/assets/hya-victory.json',JSON.stringify(source,null,2)+'\n');
for(const [sourceFile,targetFile]of [['scene-sans.otf','hya-victory.otf'],['FONT-LICENSE.txt','HYA-FONT-LICENSE.txt']]){const target=resolve(output,'proposed/games/gravity-maze/assets',targetFile);copyFileSync(resolve(root,'examples/hya-production',sourceFile),target);}
const fontManifest=JSON.parse(readFileSync('examples/hya-production/assets.json','utf8'));
propose('games/gravity-maze/assets/hya-victory-provenance.json',JSON.stringify({schemaVersion:1,license:'OFL-1.1',font:fontManifest.font,bytes:fontManifest.assets.font.bytes,sha256:fontManifest.assets.font.sha256,compositionSha256:sha256(JSON.stringify(source,null,2)+'\n'),scope:'Authored level-completion ribbon; no imported motion or replacement of gameplay controls.'},null,2)+'\n');
propose('games/gravity-maze/ui/HyaVictory.ts',`import type {HaiyueEngine, Scene} from '@haiyue/engine';
import type {HyaPlayer} from '@haiyue/extensions/hya-player';

/** Optional completion artwork. Existing Chinese GUI and game rules remain authoritative. */
export class HyaVictory {
 private lifetime:AbortController|undefined;
 private player:HyaPlayer|undefined;
 private sequence=0;
 private disposed=false;
 constructor(private readonly engine:HaiyueEngine,private readonly scene:Scene){
  scene.world.addRuntimeIntegration({onDetach:()=>this.dispose()});
 }
 async show(level:number):Promise<void>{
  this.hide();if(this.disposed)return;
  const lifetime=this.lifetime=new AbortController();
  try{
   const [module,response]=await Promise.all([import('@haiyue/extensions/hya-player'),fetch('./assets/hya-victory.json',{signal:lifetime.signal})]);
   if(!response.ok)throw Error('Completion artwork is unavailable');
   const source:unknown=await response.json();if(lifetime.signal.aborted)return;
   const player=await module.createHyaPlayer(source,{mode:'render',scene:this.scene,viewport:this.viewport(),dpr:this.dpr(),signal:lifetime.signal,host:{
    capabilities:new Set(['org.haiyue.data-binding@1','org.haiyue.layout-2d@1']),invalidate(){},
    resources:{async acquire(request){
     if(request.kind!=='font'||request.asset!=='font'||request.integrity!=='${fontManifest.assets.font.integrity}')throw Error('Undeclared completion resource');
     const response=await fetch('./assets/hya-victory.otf',{signal:request.signal});if(!response.ok)throw Error('Completion font is unavailable');
     const bytes=new Uint8Array(await response.arrayBuffer());return {value:bytes,generation:1,bytes:bytes.byteLength,release(){}};
    }}
   }});
   if(lifetime.signal.aborted){player.dispose();return;}
   this.player=player;this.sequence=0;if(!player.data)throw Error('Completion data model is absent');player.data.run(write=>write.set({part:'data',id:'root'},['label'],'LEVEL '+level+' COMPLETE'));
   player.pause();this.engine.on('after-update',this.update);this.update();
  }catch(error){if(!lifetime.signal.aborted){this.hide();console.error('HYA completion artwork failed',error);}}
 }
 hide():void{this.lifetime?.abort();this.lifetime=undefined;this.engine.off('after-update',this.update);this.player?.dispose();this.player=undefined;}
 dispose():void{if(this.disposed)return;this.disposed=true;this.hide();}
 private viewport():readonly[number,number]{return [this.engine.displayWidth,this.engine.displayHeight];}
 private dpr():number{const value=this.engine.devicePixelRatio;return typeof value==='function'?value():value;}
 private readonly update=():void=>{if(!this.player)return;try{this.player.advance({sequence:++this.sequence,deltaSeconds:0,viewport:this.viewport(),dpr:this.dpr()});}catch(error){this.hide();console.error('HYA completion frame failed',error);}};
}
`);
modify('games/gravity-maze/ui/MazeHud.ts',text=>text.replace("import { GameHud }", "import {HyaVictory} from './HyaVictory';\nimport { GameHud }").replace('    readonly level;','    private readonly hyaVictory:HyaVictory;\n    readonly level;').replace("        this.label('GRAVITY MAZE'","        this.hyaVictory=new HyaVictory(engine,scene);\n        this.label('GRAVITY MAZE'").replace('this.next.setVisible(visible); }','this.next.setVisible(visible); if(visible)void this.hyaVictory.show(Number(this.level.text));else this.hyaVictory.hide(); }'));
modify('games/manifest.json',text=>{
 const start=text.indexOf('"id": "gravity-maze"'),end=text.indexOf('\n    },',start);if(start<0||end<0)throw Error('Game entry boundary missing');
 const entry=text.slice(start,end).replace('"gui"','"gui", "hya-production"').replace('"assets": []','"assets": '+JSON.stringify(['hya-victory.json','hya-victory.otf','HYA-FONT-LICENSE.txt','hya-victory-provenance.json'].map(file=>'gravity-maze/assets/'+file)));
 const changed=text.slice(0,start)+entry+text.slice(end);JSON.parse(changed);return changed;
});
const paths={};for(const entry of staged.report.packages){const directory=resolve(output,'packages',entry.workspace),pkg=JSON.parse(readFileSync(resolve(directory,'package.json'),'utf8'));for(const[key,value]of Object.entries(pkg.exports??{})){const file=typeof value==='object'?value.types:undefined;if(file)paths[pkg.name+(key==='.'?'':key.slice(1))]=[resolve(directory,file)];}}
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,skipLibCheck:true,noEmit:true,baseUrl:games,paths,types:['@webgpu/types'],typeRoots:[resolve(games,'node_modules/@types'),resolve(root,'node_modules/@types'),resolve(root,'node_modules')]};
const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host);host.readFile=file=>overlays.get(resolve(file))??read(file);host.fileExists=file=>overlays.has(resolve(file))||exists(file);
const program=ts.createProgram([resolve(games,'games/gravity-maze/ui/MazeHud.ts'),resolve(games,'games/gravity-maze/ui/HyaVictory.ts')],options,host);
const diagnostics=ts.getPreEmitDiagnostics(program);writeFileSync(resolve(output,'typecheck.log'),ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>games,getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));
const diff=spawnSync('git',['diff','--no-index','--','before','proposed'],{cwd:output,encoding:'utf8',windowsHide:true});if(diff.status!==1)throw Error(diff.stderr||'Expected a concrete product diff');
writeFileSync(resolve(output,'product.patch'),diff.stdout);
writeFileSync(resolve(output,'proposal.json'),JSON.stringify({schemaVersion:1,status:diagnostics.length?'typecheck-failed':'typecheck-passed',originals,tarballs:staged.tarballs,scopeAdditions:['Games/games/gravity-maze/ui/MazeHud.ts','Games/games/gravity-maze/ui/HyaVictory.ts','Games/games/gravity-maze/assets/hya-victory*','Games/games/gravity-maze/assets/HYA-FONT-LICENSE.txt','Games/games/manifest.json'],originalFilesModified:false,productBuildAndNativeAcceptancePending:true},null,2)+'\n');
console.log(JSON.stringify({output,diagnostics:diagnostics.length}));if(diagnostics.length)process.exitCode=1;
