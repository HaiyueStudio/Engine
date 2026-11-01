import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import * as box2d from 'box2d.ts/dist/box2d.umd.js';
import {importEngineSource} from '../../../engine/test/helpers/internal-source.mjs';

const root=resolve(import.meta.dirname,'../../..');
const out=resolve(root,process.argv[2]??'artifacts/engine-0.2.3/g01/source-probes.json');
const outputRelative=relative(resolve(root,'artifacts/engine-0.2.3/g01'),out);
assert.ok(outputRelative&&!outputRelative.startsWith('..')&&!isAbsolute(outputRelative),'Output must stay within G01 artifacts');
const checks=[],record=(id,actual,expected)=>checks.push({id,status:'observed',actual,expected});
const {InputActionMap}=await importEngineSource('input/InputActionMap.ts');
const map=InputActionMap.standardGameplay();
const axis=s=>s.find(v=>v.action==='MoveX')?.value??0;
const input={left:axis(map.sampleKeyboard(['ArrowLeft'])),right:axis(map.sampleKeyboard(['ArrowRight'])),
  padLeft:axis(map.sampleGamepad({connected:true,buttons:[],axes:[-1,0]})),padRight:axis(map.sampleGamepad({connected:true,buttons:[],axes:[1,0]}))};
assert.deepEqual(input,{left:1,right:1,padLeft:-1,padRight:1});
record('input-axis-direction-defect',input,{left:-1,right:1,padLeft:-1,padRight:1});

const {Physics2DSystem}=await importEngineSource('physics/Physics2DSystem.ts');
const {Physics3DSystem}=await importEngineSource('physics/Physics3DSystem.ts');
const ctorResults=[];
for(const options of [{fixedTimeStep:0},{maxSubSteps:0},{fixedTimeStep:NaN},{fixedTimeStep:Infinity}]){
  const row={options:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,Number.isFinite(v)?v:String(v)]))};
  for(const [name,Type] of [['twoD',Physics2DSystem],['threeD',Physics3DSystem]]){
    let destroyed=0,created=0;
    // Only constructor validation is under test; no stepping or GPU behavior is mocked.
    const backend={id:'constructor-probe',capabilities:{},createWorld:()=>{created++;return {capabilities:{},destroy(){destroyed++;}};}};
    try{new Type({...options,backend}).destroy();row[name]='accepted';}
    catch(error){row[name]=error.constructor.name;}
    row[name+'DestroyedWorlds']=destroyed;
    row[name+'CreatedWorlds']=created;
  }
  ctorResults.push(row);
}
assert.equal(ctorResults[0].twoD,'accepted');assert.equal(ctorResults[0].threeD,'RangeError');
record('physics-invalid-parameters',ctorResults,'reject non-finite/nonpositive step and nonpositive/noninteger maxSubSteps before creating a world');

const {SceneAssets}=await importEngineSource('scene/internal/SceneAssets.ts');
const assigned=[],released=[],events=[];let active=0,maxActive=0;
const sceneAssets=new SceneAssets({assetManager:{resolveType:()=> 'probe',async loadUrl(url){
  active++;maxActive=Math.max(maxActive,active);events.push('start:'+url);
  await new Promise(r=>setTimeout(r,3));active--;events.push('finish:'+url);
  if(url==='fail')throw Error('intentional second request failure');
  return {key:url,value:{url},release(){released.push(url);}};
}}},{state:'ready',assertUsable(){},createDestroyedError(){return Error('scene destroyed');}});
await assert.rejects(sceneAssets.loadMany([{url:'first',assign:value=>assigned.push(value.url)},{url:'fail'}],{}),/intentional/);
assert.deepEqual(assigned,['first']);assert.deepEqual(released,['first']);assert.equal(maxActive,1);
record('scene-batch-serial-and-partial-assign',{assigned,released,events,maxActive},'legacy order retained; new flow owns staged scene and rolls it back without changing the active scene');
sceneAssets.destroy();

const {GuiTree}=await importEngineSource('gui/components/GuiTree.ts');
const tree=new GuiTree({width:240,height:140,rowHeight:28,nodes:Array.from({length:1000},(_,i)=>({key:String(i),label:'row '+i}))});
tree.layout({x:0,y:0,width:240,height:140});
const rows=tree.visibleNodes;
assert.ok(rows.length<1000);assert.equal(rows[0].node.key,'0');assert.equal(tree.findNode('999').key,'999');
record('tree-logical-vs-first-viewport',{logical:1000,rows:rows.length,first:rows[0].node.key,last:rows.at(-1).node.key,offscreenLookup:!!tree.findNode('999')},'separate logical order from a scrollable visible window');

function shape(kind){return kind==='box'?new box2d.b2PolygonShape().SetAsBox(.5,.5):new box2d.b2CircleShape(.5);}
function cast(target,mover,targetAt=[5,0],movingAt=[0,0],translation=[10,0],angle=0){
  const input=new box2d.b2ShapeCastInput();input.proxyA.SetShape(target,0);input.proxyB.SetShape(mover,0);
  input.transformA.SetIdentity();input.transformA.p.Set(...targetAt);input.transformA.q.SetAngle(angle);
  input.transformB.SetIdentity();input.transformB.p.Set(...movingAt);input.translationB.Set(...translation);
  const output=new box2d.b2ShapeCastOutput(),hit=box2d.b2ShapeCast(output,input);
  const d=new box2d.b2DistanceInput();d.proxyA.Copy(input.proxyA);d.proxyB.Copy(input.proxyB);d.transformA.Copy(input.transformA);d.transformB.Copy(input.transformB);
  const starting=new box2d.b2DistanceOutput();d.useRadii=true;box2d.b2Distance(starting,new box2d.b2SimplexCache(),d);
  d.transformB.p.SelfMulAdd(output.lambda,input.translationB);d.useRadii=false;
  const witness=new box2d.b2DistanceOutput();box2d.b2Distance(witness,new box2d.b2SimplexCache(),d);
  return {hit,fraction:output.lambda,normal:[output.normal.x,output.normal.y],rawPoint:[output.point.x,output.point.y],
    point:hit&&Math.hypot(output.normal.x,output.normal.y)>.99?[witness.pointA.x+input.proxyA.m_radius*output.normal.x,witness.pointA.y+input.proxyA.m_radius*output.normal.y]:null,
    initialDistance:starting.distance,iterations:output.iterations};
}
const sweep=[];
for(const targetKind of ['box','circle'])for(const moverKind of ['box','circle']){
  const target=targetKind==='box'?new box2d.b2PolygonShape().SetAsBox(.1,5):new box2d.b2CircleShape(1);
  const result=cast(target,shape(moverKind));
  const expectedFraction=(5-(targetKind==='box'?.1:1)-.5)/10;
  assert.equal(result.hit,true);assert.ok(Math.abs(result.fraction-expectedFraction)<.004);assert.ok(result.normal[0]<-.99);
  assert.ok(result.point[0]>3&&result.point[0]<5);assert.ok(result.iterations<=20);
  sweep.push({id:targetKind+'-target-'+moverKind+'-mover',...result,analyticFraction:expectedFraction});
}
const wall=new box2d.b2PolygonShape().SetAsBox(.1,5);
const untranslated=cast(wall,shape('box'));
const translated=cast(wall,shape('box'),[105,50],[100,50]);
assert.ok(Math.abs(translated.fraction-untranslated.fraction)<1e-10);
assert.ok(Math.abs(translated.point[0]-untranslated.point[0]-100)<1e-8);
assert.ok(Math.abs(translated.point[1]-untranslated.point[1]-50)<1e-8);
sweep.push({id:'translation-invariance',...translated});
const miss=cast(wall,shape('circle'),[5,0],[0,0],[0,10]);assert.equal(miss.hit,false);sweep.push({id:'miss',...miss});
const slope=cast(new box2d.b2PolygonShape().SetAsBox(5,.1),shape('circle'),[0,3],[0,0],[0,6],Math.PI/6);
assert.equal(slope.hit,true);assert.ok(Math.abs(slope.normal[0]-.5)<.02);assert.ok(Math.abs(slope.normal[1]+Math.sqrt(3)/2)<.02);
sweep.push({id:'rotated-slope-30deg',...slope});
// Translating target: the unchanged real cast receives relative displacement.
const movingPlatform=cast(wall,shape('box'),[5,0],[0,0],[8,0]);
assert.equal(movingPlatform.hit,true);assert.ok(Math.abs(movingPlatform.fraction-untranslated.fraction*10/8)<1e-8);
const t=movingPlatform.fraction,actualAtToi=new box2d.b2DistanceInput();
actualAtToi.proxyA.SetShape(wall,0);actualAtToi.proxyB.SetShape(shape('box'),0);
actualAtToi.transformA.SetIdentity();actualAtToi.transformA.p.Set(5+2*t,0);
actualAtToi.transformB.SetIdentity();actualAtToi.transformB.p.Set(10*t,0);actualAtToi.useRadii=false;
const movingWitness=new box2d.b2DistanceOutput();box2d.b2Distance(movingWitness,new box2d.b2SimplexCache(),actualAtToi);
const worldContactPoint=[movingWitness.pointA.x-wall.m_radius,movingWitness.pointA.y];
assert.ok(Math.abs(worldContactPoint[0]-(movingPlatform.point[0]+2*t))<1e-8);
sweep.push({id:'translating-target-relative-displacement',targetTranslation:[2,0],moverTranslation:[10,0],...movingPlatform,worldContactPoint});
const fast=cast(wall,shape('circle'),[5,0],[0,0],[1000,0]);assert.equal(fast.hit,true);assert.ok(fast.fraction<.01);
sweep.push({id:'high-speed-thin-wall',...fast,publicRenderUnits:{pixelsPerMeter:100,translation:100000,hitDistance:fast.fraction*100000}});
const overlap=cast(wall,shape('box'),[5,0],[5,0],[1,0]);assert.equal(overlap.initialDistance,0);
sweep.push({id:'initial-overlap-needs-distance-check',...overlap});
function contacts(a,b,positionA,positionB,angle=0){
  const xa=new box2d.b2Transform().SetIdentity(),xb=new box2d.b2Transform().SetIdentity();
  xa.p.Set(...positionA);xa.q.SetAngle(angle);xb.p.Set(...positionB);
  const m=new box2d.b2Manifold();let swapped=false;
  if(a instanceof box2d.b2PolygonShape&&b instanceof box2d.b2PolygonShape)box2d.b2CollidePolygons(m,a,xa,b,xb);
  else if(a instanceof box2d.b2CircleShape&&b instanceof box2d.b2CircleShape)box2d.b2CollideCircles(m,a,xa,b,xb);
  else if(a instanceof box2d.b2PolygonShape)box2d.b2CollidePolygonAndCircle(m,a,xa,b,xb);
  else {swapped=true;box2d.b2CollidePolygonAndCircle(m,b,xb,a,xa);}
  const world=new box2d.b2WorldManifold();world.Initialize(m,swapped?xb:xa,swapped?b.m_radius:a.m_radius,swapped?xa:xb,swapped?a.m_radius:b.m_radius);
  return {points:m.pointCount,normal:[world.normal.x*(swapped?-1:1),world.normal.y*(swapped?-1:1)],separations:world.separations.slice(0,m.pointCount)};
}
const manifolds=[];
for(const targetKind of ['box','circle'])for(const moverKind of ['box','circle']){
  const c=contacts(shape(targetKind),shape(moverKind),[0,0],[0,0]);
  assert.ok(c.points>0);assert.ok(Math.min(...c.separations)<-box2d.b2_linearSlop);assert.ok(Math.hypot(...c.normal)>.99);
  manifolds.push({id:targetKind+'-'+moverKind+'-initial-penetration',...c});
}
for(const kind of ['box','circle']){
  const floor=new box2d.b2PolygonShape().SetAsBox(5,.1),mover=shape(kind);
  const y=.1+.5+floor.m_radius+(kind==='box'?mover.m_radius:0)-1e-8;
  const c=contacts(floor,mover,[0,0],[0,y]);
  assert.ok(c.points>0);assert.ok(c.separations.every(s=>s>=-box2d.b2_linearSlop));assert.ok(c.normal[1]>.99);
  manifolds.push({id:kind+'-touching-floor',...c,tangentDot:c.normal[0],towardDot:-c.normal[1],awayDot:c.normal[1]});
}
const {createBox2DPhysics2DBackend}=await importEngineSource('physics/Box2DPhysics2DBackend.ts');
const driver=createBox2DPhysics2DBackend().createWorld({gravityX:0,gravityY:0});
const body=driver.createBody({type:'static',positionX:5,positionY:0,angle:0,fixedRotation:false,linearDamping:0,angularDamping:0,bullet:false,allowSleep:true});
driver.setBodyCollider(body,{shape:'box',width:.2,height:10,radius:.5,density:1,friction:.2,restitution:0,isSensor:false,categoryBits:1,maskBits:65535,groupIndex:0});
const candidates=[];driver.queryAabb({minimum:{x:-1,y:-1},maximum:{x:11,y:1}},h=>{candidates.push(h);return true;});
assert.deepEqual(candidates,[body]);
const platform=driver.createBody({type:'kinematic',positionX:0,positionY:10,angle:0,fixedRotation:true,linearDamping:0,angularDamping:0,bullet:false,allowSleep:false});
assert.equal(driver.setBodyLinearVelocity(platform,{x:0,y:2}),true);const platformVelocity={x:0,y:0};
assert.equal(driver.getBodyLinearVelocity(platform,platformVelocity),true);assert.deepEqual(platformVelocity,{x:0,y:2});driver.destroy();
record('box2d-real-shape-sweep',{package:'box2d.ts@1.0.2',slopMeters:box2d.b2_linearSlop,sweep,manifolds,broadphaseCandidates:candidates.length,
  kinematicVelocityMetersPerSecond:platformVelocity,publicDriverCastAvailable:typeof driver.castShape==='function',rawPointAssignmentDefect:sweep.filter(c=>c.hit).every(c=>c.rawPoint[0]===0&&c.rawPoint[1]===0)},
  'G04 optional driver cast: real shape sweep plus distance witnesses; explicit initial overlap; no ray/AABB approximation');

const tileSource=readFileSync(resolve(root,'extensions/src/tilemap/Tilemap2DRenderer.ts'),'utf8');
assert.match(tileSource,/cached\.version === tilemap\.version/);assert.match(tileSource,/this\.buildVertices\(tilemap, entityGpu\)/);
assert.match(tileSource,/for \(const cell of tilemap\.cells\)/);
record('tilemap-invalidation',{staticVersionCache:true,changedVersion:'whole-map vertex rebuild and upload'},'keep static cache; add dirty-chunk updates');
const tabTypes=readFileSync(resolve(root,'extensions/src/gui-layout/panel-types.ts'),'utf8');
const content=readFileSync(resolve(root,'engine/src/gui/GuiContent.ts'),'utf8');
assert.doesNotMatch(tabTypes,/iconPosition/);assert.match(content,/x: rect\.x, y: rect\.y/);
record('tabs-and-icon-layout',{tabPageIconOption:false,sharedIconPosition:'left'},'add per-page icon options and shared left/right geometry');
const audioSource=readFileSync(resolve(root,'engine/src/audio/OwnerSafeAudioMixer.ts'),'utf8');
assert.match(audioSource,/#makeRoom\(owner: string/);assert.match(audioSource,/\.sort\(\(left, right\) => left\.priority/);
record('audio-victim-selection',{strategy:'repeated voice collection expansion, filtering and sorting',precisionBoundary:'game mixer vs HYA sample-accurate host'},'single-pass victim selection with identical priority/sequence order; retain precision boundaries');
const publication=readFileSync(resolve(root,'scripts/publication.mjs'),'utf8');assert.match(publication,/stdio:\['inherit','pipe','pipe'\]/);
record('publication-tty-precondition',{stdout:'pipe',stderr:'pipe'},'interactive path inherits real terminal; frozen plan/journal/recovery retained');

const inputFiles=['engine/src/input/InputActionMap.ts','engine/src/physics/Physics2DSystem.ts','engine/src/physics/Physics3DSystem.ts',
  'engine/src/scene/internal/SceneAssets.ts','engine/src/gui/components/GuiTree.ts','engine/src/gui/GuiContent.ts',
  'extensions/src/gui-layout/panel-types.ts','extensions/src/tilemap/Tilemap2DRenderer.ts','engine/src/audio/OwnerSafeAudioMixer.ts',
  'scripts/publication.mjs','scripts/fixtures/engine-023/source-probes.mjs','node_modules/box2d.ts/dist/box2d.umd.js','node_modules/box2d.ts/Box2D/Collision/b2Distance.ts','package-lock.json'];
const report={schemaVersion:1,status:'completed-expected-baseline-observations',goal:'g01-contracts-baseline',generatedAt:new Date().toISOString(),
  qualification:false,sourceRevision:execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  checks,inputs:inputFiles.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')}))};
mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,checks:checks.length,sweepCases:sweep.length,output:relative(root,out),rawShapeCastPointRequiresReconstruction:true}));
