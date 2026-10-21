const common={width:128,height:80,dpr:1,msaa:[1,4],pixelTolerance:2,deviceClass:'native-desktop'};
const projection={width:129,height:81,dpr:[1,1.25,2],cacheModes:['retained-regions','forced-direct-regions','ordinary-full-raster-CPU-crop-reference']};
const definitions={
 regional:{fixture:'pipeline',count:12,mounted:false,workload:{cacheModes:['retained-regions','direct-full-output-redraw']}},
 clipping:{fixture:'clipping',count:48,workload:{dpr:[1,2]}},
 surface:{fixture:'clipping',count:160,query:{surface:1},workload:{width:129,height:81,dpr:[1,1.25,2],cacheModes:['retained-regions','forced-direct-regions','ordinary-full-output-GUI']}},
 fallback:{fixture:'fallback',count:36,memory:true,workload:{resolutions:[[128,80],[1280,720],[1600,900]]}},
 'working-set':{fixture:'fallback',count:6,memory:true,query:{workingSet:1},workload:{width:1920,height:1080,resolutions:[[1920,1080]],msaa:[4],cacheModes:['production-direct-working-fallback','ordinary-full-output-GUI']}},
 scene:{fixture:'scene',count:36,memory:true,workload:{width:384,height:216,resolutions:[[384,216],[1920,1080],[1920,900]]}},
 example:{fixture:'example',count:6,mounted:false,preview:true,workload:{width:960,height:540,msaa:[4],cacheModes:['registered-regional-example']}},
 submission:{fixture:'submission',count:12,workload:{width:16,height:16,cacheModes:['immutable-output-parameters']}},
 history:{fixture:'history',count:120,mounted:false,memory:true,workload:{width:64,height:48,parentFormat:'rgba16float',clearModes:['on-update','once','never-after-initialization'],comparisonsPerCohort:20,cacheModes:['retained-regions','independent-CPU-premultiplied-layer-history']}},
 overlays:{fixture:'overlays',count:84,memory:true,workload:{width:384,height:240,dpr:[1,2],parentFormat:'rgba16float',comparisonsPerCohort:21,cacheModes:['retained-sidebar-scene-global-overlay','ordinary-full-output-GUI-layers'],controls:['GuiSelect','GuiModal','GuiToast'],inputQualification:'Programmatic control lifecycle; cross-system input/focus remains G05'}},
 oversized:{fixture:'oversized',count:168,mounted:false,memory:true,workload:{width:128,height:80,deviceTextureLimit:'default native limit; source dimensions exceed it',referenceDevice:'same native adapter class with maximum requested limit',formats:['rgba8unorm','rgba16float'],depthConventions:['standard','reverse'],boundsPopulation:3,pixelComparisonsPerCohort:6,dependencyRejectionsPerCohort:1,cacheModes:['bounded-direct-visible-camera-window','ordinary-full-virtual-raster-CPU-crop-for-one-axis','independent-off-center-frustum-for-two-axes'],postEffects:'No user passes; nonempty chains explicitly reject pending bounded dependency support'}},
 'camera-views':{fixture:'camera-views',count:672,mounted:false,workload:{width:160,height:80,viewSizes:[[160,80],[80,160]],formats:['rgba8unorm','rgba16float'],depthConventions:['standard','reverse'],effects:['none','fxaa','ssao','gtao','taa','motion','outline'],states:6,views:2,cacheModes:['same-camera-native-view-family','ordinary-single-view-renderers'],qualification:'CPU camera ownership correctness; arbitrary pending GPU/GUI resources are separate'}},
 'view-reuse':{fixture:'view-reuse',count:144,mounted:false,memory:true,workload:{viewSizes:[[256,128],[128,256]],formats:['rgba8unorm','rgba16float'],depthConventions:['standard','reverse'],states:9,views:2,longestCycles:300,cacheModes:['one-renderer-two-regional-pipelines','independent-renderer-per-view'],qualification:'Actual cached GUI and alternating3D; long arena stability and delayed A submission after B'}},
 'scene-projection':{fixture:'scene-projection',count:144,memory:true,workload:{...projection,fxaa:false}},
 'scene-projection-fxaa':{fixture:'scene-projection',count:144,memory:true,query:{fxaa:1},workload:{...projection,fxaa:true}},
};
export const REGION_EFFECTS=Object.freeze(['ssao','sao','gtao','taa','motion','outline','deferred','tiled']);
export const REGION_PARENT_FORMATS=Object.freeze(['rgba8unorm','bgra8unorm','rgba8unorm-srgb','bgra8unorm-srgb','rgba16float','rgba32float','rg11b10ufloat']);
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value;}
/** Pure routing/measurement population; the CLI owns builds, browsers and evidence I/O. */
export function regionFixtureSpec(args=[]){
 if(args.length>1)throw Error('Select exactly one regional fixture mode.');
 const arg=args[0],effect=arg?.startsWith('--effects=')?arg.slice('--effects='.length):undefined,alpha=arg?.startsWith('--parent-alpha='),format=arg?.startsWith('--parent-format=')?arg.slice('--parent-format='.length):alpha?arg.slice('--parent-alpha='.length):undefined;
 let id=arg?arg.slice(2):'regional',definition;
 if(effect!==undefined){
  if(!REGION_EFFECTS.includes(effect))throw Error(`Unknown regional effect: ${effect}`);
  const deferred=effect==='deferred'||effect==='tiled';id=`effects-${effect}`;
  definition={fixture:'scene-effects',count:deferred?144:288,memory:true,query:{effect},workload:{...projection,dpr:[1.25,2],msaa:deferred?[1]:[1,4],effect,comparisonsPerCohort:12,attemptsPerCohort:13,cancelledAttempt:11,reference:'ordinary raster-adjusted camera projection; CPU crops output'}};
 }else if(format!==undefined){
  if(!REGION_PARENT_FORMATS.includes(format))throw Error(`Unknown regional parent format: ${format}`);
  const samples=format==='rgba32float'?[1]:[1,4];id=`parent-${alpha?'alpha-':''}${format}`;
  definition={fixture:'parent-formats',count:samples.length*2*2*12,memory:true,query:{format,...(alpha?{alpha:.4}:{})},workload:{parentClearAlpha:alpha?.4:1,width:384,height:216,msaa:samples,parentFormat:format,depthConventions:['standard','reverse'],comparisonsPerCohort:12,cacheModes:['retained-regions','forced-direct-regions','ordinary-full-output-linear-GUI'],pixelReadback:'RGBA normalized UNORM storage or raw floating attachment values; 2/255 absolute tolerance'}};
 }else{
  if(arg&&!arg.startsWith('--'))throw Error(`Unknown regional fixture argument: ${arg}`);
  definition=definitions[id];
  if(!definition&&id==='view-reuse-before')definition={...definitions['view-reuse'],query:{legacy:1},workload:{...definitions['view-reuse'].workload,legacyReproduction:true,legacyBuild:'artifacts/engine-0.2.2/g04/reuse-before-engine.json'}};
  if(!definition&&id.startsWith('camera-views-')){const effect=id.slice('camera-views-'.length),legacy=effect==='before';if(legacy||definitions['camera-views'].workload.effects.includes(effect))definition={...definitions['camera-views'],count:96,query:{effect:legacy?'none':effect,...(legacy?{legacy:1}:{})},workload:{...definitions['camera-views'].workload,effects:[legacy?'none':effect],legacyReproduction:legacy}};}
  if(!definition&&['oversized-x','oversized-y','oversized-both'].includes(id)){const axis=['oversized-x','oversized-y','oversized-both'].indexOf(id);definition={...definitions.oversized,count:56,query:{axis},workload:{...definitions.oversized.workload,boundsPopulation:1,axis}};}
  if(!definition&&id==='oversized-frustum-x')definition={...definitions.oversized,count:56,query:{axis:0,reference:'offcenter'},workload:{...definitions.oversized.workload,boundsPopulation:1,axis:0,referenceProbe:'Independent near-frustum probe only; does not replace required full-raster X comparison'}};
  if(!definition&&['spatial-x','spatial-y','spatial-both','spatial-before-x'].includes(id)){
   const axis=id==='spatial-before-x'?0:['spatial-x','spatial-y','spatial-both'].indexOf(id),legacy=id==='spatial-before-x';
   definition={...definitions.oversized,count:56,query:{spatial:1,axis,...(legacy?{legacySpatial:1}:{})},workload:{...definitions.oversized.workload,boundsPopulation:1,axis,entities:603,spatialThresholds:[512,1000000],referenceDevice:'same native device; index-enabled vs index-bypassed regional renderer',cacheModes:['planned-window-spatial-index','same-renderer-without-spatial-index'],qualification:'Single-variable spatial extraction, not oversized full-raster qualification',legacyReproduction:legacy}};
  }
  if(!definition)throw Error(`Unknown regional fixture mode: ${arg}`);
 }
 return freeze({id,fixture:definition.fixture,count:definition.count,mounted:definition.mounted!==false,memory:!!definition.memory,preview:!!definition.preview,query:definition.query??{},workload:{...common,cacheModes:['retained-regions','ordinary-full-output-GUI'],...definition.workload}});
}
