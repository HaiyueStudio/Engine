import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const source=path=>importEngineSource('gui/'+path+'.ts');
const {GuiThemeResource}=await source('GuiThemeResource'),{GuiRoot}=await source('components/GuiRoot'),{GuiElement}=await source('components/GuiElement'),{GuiButton}=await source('components/GuiButton'),{GuiInput}=await source('components/GuiInput'),{GuiCheckbox}=await source('components/GuiCheckbox');
const {GuiBatch}=await source('rendering/GuiBatch'),{GuiShapeRenderer}=await source('rendering/GuiShapeRenderer'),{paintGuiBox}=await source('rendering/GuiBoxPaint'),{GuiTextBatch,ellipsizeGuiText}=await source('rendering/GuiTextBatch');
const {advanceGuiActivity,guiHasActivity}=await source('GuiActivity');

test('presets are independent and local fields win across state, control and named-part updates',()=>{
 const dark=GuiThemeResource.createTheme(),light=GuiThemeResource.createTheme('light','compact');assert.notEqual(dark.colors.thumb,light.colors.text);light.colors.primary='#123456';assert.notEqual(GuiThemeResource.createTheme('light').colors.primary,light.colors.primary);
 const resource=new GuiThemeResource({controls:{GuiButton:{normal:{radius:7,parts:{label:{color:'#111111'}}},checked:{backgroundColor:'#222222'},disabled:{color:'#333333'}}}}),root=new GuiRoot({theme:dark,themeResource:resource});
 const button=root.add(new GuiButton({style:{radius:13,parts:{label:{color:'#ff9900'}},states:{checked:{backgroundColor:'#445566'},disabled:{color:'#8899aa'}}}}));
 button.setVisualState({checked:true});assert.equal(button.getResolvedStyle().backgroundColor,'#445566');button.setDisabled(true);assert.equal(button.getResolvedStyle().color,'#8899aa');assert.equal(button.getResolvedStyle().radius,13);assert.equal(button.getPartStyle('label').color,'#ff9900');
 const child=button.add(new GuiElement({style:{color:'#fff'}})),off=button.bindPart('label',child);assert.equal(child.getResolvedStyle().color,'#fff');child.setStyle({color:undefined});assert.equal(child.getResolvedStyle().color,'#ff9900');off();assert.equal(child.getResolvedStyle().color,undefined);
 const version=resource.version;assert.throws(()=>resource.update({normal:{parts:{body:{fontWeight:-1}}}}));assert.equal(resource.version,version);root.destroy();resource.dispose();
});

test('density changes only automatic dimensions, and rounded clips share visual and hit geometry',()=>{
 const root=new GuiRoot({theme:GuiThemeResource.createTheme('light','touch')}),auto=root.add(new GuiButton()),fixed=root.add(new GuiButton({height:31}));root.layout(300,200);assert.equal(auto.rect.height,42);assert.equal(fixed.rect.height,31);root.clearDirty();root.theme.density='compact';root.layout(300,200);assert.equal(auto.rect.height,26);assert.equal(fixed.rect.height,31);
 const clip=root.add(new GuiElement({x:100,y:60,width:80,height:80,style:{clipRadius:30}})),child=clip.add(new GuiButton({width:80,height:80}));root.layout(300,200);assert.equal(clip.hitTest(101,61),null);assert.equal(clip.hitTest(140,100),child);root.destroy();
});

test('shadow removal and manual movement report both old and new painted extents',()=>{
 const root=new GuiRoot(),node=root.add(new GuiElement({x:20,y:30,width:60,height:40,style:{backgroundColor:'#fff',shadow:{color:'#0008',blur:12,x:5,y:8}}}));root.layout(300,200);root.clearDirty();const changes=[],off=root.onInvalidation(c=>changes.push(c));node.setStyle({shadow:undefined});assert.ok(changes.some(c=>c.previousBounds.width>=84));changes.length=0;node.x=100;node.markDirty(1);root.layout(300,200);assert.ok(changes.some(c=>c.previousBounds.x<=20&&c.nextBounds?.x+c.nextBounds?.width>=160));off();root.destroy();
});

test('delegated movement invalidates both old and new shadow overhangs',()=>{
 const root=new GuiRoot(),node=root.add(new GuiElement({width:60,height:40,style:{backgroundColor:'#fff',shadow:{color:'#0008',blur:12,x:5,y:8}}}));
 let x=20;
 root.installLayoutDelegate({measure:()=>({width:0,height:0}),arrange(_root,_viewport,commit){commit(node,{x,y:30,width:60,height:40});},dispose(){}});
 root.layout(300,200);root.clearDirty();
 const changes=[],off=root.onInvalidation(change=>changes.push(change));
 try{
  x=120;root.root.markDirty(1);changes.length=0;root.layout(300,200);
  const paint=changes.find(change=>change.reasons.includes('paint'));
  assert.ok(paint,'the committed move must invalidate paint');
  assert.ok(paint.previousBounds.x<20&&paint.previousBounds.x+paint.previousBounds.width>80,'old shadow pixels must be cleared');
  assert.ok(paint.nextBounds.x<120&&paint.nextBounds.x+paint.nextBounds.width>180,'new shadow pixels must be drawn');
 }finally{off();root.destroy();}
});

test('a styled box is one quad; sparse parameter changes upload only changed spans and release all resources',async()=>{
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),renderer=new GuiShapeRenderer();renderer.prepare({device,format:'rgba8unorm',displayWidth:400,displayHeight:300,getDepthFormat:()=> 'depth24plus'});
 const batch=new GuiBatch(),draw=()=>{batch.rebuild();const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,batch);pass.end();device.queue.submit([encoder.finish()]);};
 for(let i=0;i<40;i++)paintGuiBox(batch,{x:i*8,y:10,width:20,height:20},{borderWidth:1,cornerRadii:[2,4,6,8]},[.2,.3,.4,1],[1,1,1,1]);draw();assert.equal(batch.vertexCount,40*6);const before=audit.snapshot();draw();const same=audit.snapshot();assert.deepEqual(same.uploads,before.uploads);
 const oldVersion=batch.parameters.version;batch.commands[17].appearance={...batch.commands[17].appearance,borderColor:[.5,1,1,1]};draw();assert.ok(batch.parameters.version>oldVersion);renderer.releaseBatch(batch);renderer.destroy();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(audit.snapshot().resources.buffer.live,0);
});

test('visible activity pauses when hidden, clipped or reduced-motion, and old cancellation cannot remove a new lease',()=>{
 const root=new GuiRoot({theme:GuiThemeResource.createTheme()}),parent=root.add(new GuiElement({width:100,height:100,style:{clipRadius:8}})),child=parent.add(new GuiElement({width:20,height:20}));root.layout(300,200);let elapsed=0;const old=child.setActivity(dt=>{elapsed+=dt;});advanceGuiActivity(child,16);assert.equal(elapsed,16);parent.setVisible(false);advanceGuiActivity(child,16);assert.equal(elapsed,16);assert.equal(guiHasActivity(child),false);parent.setVisible(true);child.rect.x=250;advanceGuiActivity(child,16);assert.equal(elapsed,16);child.rect.x=0;root.theme.motionScale=0;assert.equal(guiHasActivity(child),false);root.theme.motionScale=1;child.setActivity(dt=>{elapsed+=dt;return false;});old();advanceGuiActivity(child,10);assert.equal(elapsed,26);assert.equal(guiHasActivity(child),false);root.destroy();
});

test('popup positioning flips and shifts within a viewport without changing the anchor',()=>{
 const root=new GuiRoot(),anchor=root.add(new GuiButton({x:180,y:160,width:60,height:32}));root.layout(250,200);const rect={...anchor.rect},popup=anchor.getPopupRect({width:150,height:90},{placement:'bottom',align:'start',gap:4});assert.ok(popup.y<anchor.rect.y);assert.ok(popup.x+popup.width<=246);assert.deepEqual(anchor.rect,rect);root.destroy();
});

test('IME, prefix/suffix and clearing share presentation geometry; invalid skins do not replace the editor',async()=>{
 const {guiInputPresentation}=await source('input/GuiInputPresentation'),{guiInputClearRect}=await source('input/GuiInputAdornments');
 const root=new GuiRoot(),input=root.add(new GuiInput({value:'你好',prefix:'@',suffix:'px',clearable:true,invalid:true}));root.layout(400,200);const p=guiInputPresentation(input,t=>t.length*8,14,20);assert.ok(p.clip.x>input.rect.x+8);assert.ok(p.clip.width<input.rect.width-30);assert.equal(input.getResolvedStyle().borderColor,root.theme.colors.danger);
 input.beginComposition();input.updateComposition('nihao');const r=guiInputClearRect(input),event={x:r.x+r.width/2,y:r.y+r.height/2,type:'pointerdown',button:0,buttons:1,pointerId:1,stopped:false,nativeEvent:{},preventDefault(){},stopPropagation(){}};input.handlePointerDown(event);input.handlePointerUp({...event,type:'pointerup',buttons:0});assert.equal(input.value,'');assert.equal(input.isComposing,false);root.destroy();
});

test('ellipsis preserves graphemes and custom logical line height is independent of atlas scale',()=>{
 const chars=new Map([...('AB.你')].map((c,i)=>[c.codePointAt(0),{id:c.codePointAt(0),x:i*8,y:0,width:8,height:10,xoffset:0,yoffset:0,xadvance:8,page:0}]));
 const font={id:123,size:20,lineHeight:24,scaleW:64,scaleH:64,chars,kernings:new Map(),pages:[]};assert.equal(ellipsizeGuiText('ABABAB',font,20,40),'AB...');const batch=new GuiTextBatch();batch.addText({text:'A\nB',x:0,y:0,width:50,height:100,fontSize:10,lineHeightPixels:30,multiline:true,color:[1,1,1,1]});batch.rebuild(font);assert.equal(batch.vertexData[6*12+1]-batch.vertexData[1],30);
});

test('repeated translucent shadow and gradient painting never mutates shared parsed colors',async()=>{
 const {parseGuiColor}=await source('GuiColor'),style={shadow:{color:'rgba(0,0,0,0.5)',blur:8},gradient:{from:'#123456',to:'#abcdef'}};
 const before=[...parseGuiColor(style.shadow.color,'transparent')],paint=()=>{const batch=new GuiBatch();paintGuiBox(batch,{x:0,y:0,width:60,height:30},style,[1,1,1,.5],[0,0,0,.5],undefined,6,.5);return batch.commands;};
 const a=paint(),b=paint();assert.deepEqual(a,b);assert.deepEqual(parseGuiColor(style.shadow.color,'transparent'),before);assert.equal(a[0].color[3],.25);assert.equal(a[1].color[3],.5);
});

test('focus rings follow each independently configured corner',async()=>{
 const {GuiRenderer}=await source('rendering/GuiRenderer'),root=new GuiRoot(),button=root.add(new GuiButton({width:100,height:40,style:{cornerRadii:[14,3,14,3]}})),renderer=new GuiRenderer();button.handleFocus();root.layout(300,200);
 try{const cache=renderer.getRootCache(root);renderer.rebuildRoot(root,cache);assert.deepEqual(cache.batch.commands[0].appearance.radii,[18,7,18,7]);}finally{renderer.destroy();root.destroy();}
});
