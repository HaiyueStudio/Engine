import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiSystem}=await importEngineSource('gui/systems/GuiSystem.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const {guiButtonHoverProgress:progress,guiButtonHoverAnimating:animating,advanceGuiButtonHover:advance,finishGuiButtonHover:finish}=await importEngineSource('gui/input/GuiButtonHover.ts');

test('hover colors default to instant; enabled transitions enter, reverse continuously and finish without timers',()=>{
 const plain=new GuiButton();plain.hovered=true;assert.equal(progress(plain),1);assert.equal(animating(plain),false);
 const b=new GuiButton({hoverTransition:true,hoverTransitionMs:200});b.hovered=true;advance(b,10000);assert.equal(progress(b),0,'idle elapsed time must not skip a new transition');advance(b,100);const midpoint=progress(b);assert.ok(midpoint>0&&midpoint<1);b.hovered=false;assert.equal(progress(b),midpoint);advance(b,100);assert.ok(progress(b)<midpoint);advance(b,100);assert.equal(progress(b),0);assert.equal(animating(b),false);
 b.hovered=true;progress(b);advance(b,50);b.hoverTransition=false;assert.equal(progress(b),1);assert.equal(animating(b),false);
 for(const ms of [0,-1,NaN,Infinity]){b.hoverTransitionMs=ms;b.hoverTransition=true;b.hovered=false;assert.equal(progress(b),0);assert.equal(animating(b),false);b.hovered=true;progress(b);}
});

test('transition renders intermediate local and theme-resource colors in both directions',()=>{
 const root=new GuiRoot({themeResource:new GuiThemeResource({controls:{GuiButton:{normal:{backgroundColor:'#000000',color:'#ffffff',borderColor:'#000000'},hover:{backgroundColor:'#ffffff',color:'#000000',borderColor:'#ffffff'}}}})});
 const b=root.add(new GuiButton({width:100,height:40,hoverTransition:true,hoverTransitionMs:200,text:'test'})),system=new GuiSystem({});root.layout(200,100);const renderer=system.renderer;
 const paint=()=>{renderer.resolvedStyles.clear();renderer.batch.clear();renderer.textBatch.clear();renderer.addButton(b,root.theme);return {fill:renderer.batch.commands[1].color[0],border:renderer.batch.commands[0].color[0],text:renderer.textBatch.commands[0].color[0]};};
 assert.equal(paint().fill,0);b.hovered=true;progress(b);assert.equal(paint().fill,0,'first hover frame keeps the normal color');advance(b,100);let c=paint();assert.ok(c.fill>0&&c.fill<1);assert.equal(c.fill,c.border);assert.ok(Math.abs(c.text+c.fill-1)<1e-6);
 const before=c.fill;b.hovered=false;assert.equal(paint().fill,before);advance(b,200);assert.equal(paint().fill,0);
 b.hovered=true;progress(b);advance(b,200);assert.equal(paint().fill,1);b.hovered=false;assert.equal(paint().fill,1,'first leave frame keeps the hover color');finish(b);
 b.setStyle({backgroundColor:'#ff0000',hoverBackgroundColor:'#0000ff'});b.hovered=true;progress(b);advance(b,100);c=paint();assert.ok(c.fill>0&&c.fill<1);system.destroy();root.destroy();
});

test('stopped/disabled motion settles',()=>{
 const root=new GuiRoot(),b=root.add(new GuiButton({id:'animated',hoverTransition:true,hoverTransitionMs:350}));b.hovered=true;progress(b);advance(b,100);
 const system=new GuiSystem({});system.roots.add(root);assert.equal(system.animating,true);system.stopAnimations();assert.equal(system.animating,false);b.disabled=true;finish(b);assert.equal(progress(b),0);system.destroy();root.destroy();
});

test('delayed tooltip invalidates retained paint when the deadline passes and stops demand frames',async()=>{
 const {GuiTooltip}=await importEngineSource('gui/components/GuiTooltip.ts');
 const {guiTooltipPending,advanceGuiTooltip}=await importEngineSource('gui/input/GuiTooltipTiming.ts');
 const root=new GuiRoot(),button=root.add(new GuiButton()),tip=root.add(new GuiTooltip({target:button,content:'Help',delay:200}));let time=100;
 const original=performance.now;performance.now=()=>time;
 try{
  const system=new GuiSystem({});system.roots.add(root);root.layout(200,200);advanceGuiTooltip(tip,true);root.clearDirty();button.hovered=true;assert.equal(guiTooltipPending(tip),true);assert.equal(system.animating,true);advanceGuiTooltip(tip,true);root.clearDirty();
  const changes=[];root.onInvalidation(c=>changes.push(c));time=301;assert.equal(system.animating,true,'deadline still needs one final paint');advanceGuiTooltip(tip,true);assert.equal(tip.active,true);assert.ok(changes.some(c=>c.reasons.includes('paint')));assert.equal(system.animating,false);
  changes.length=0;advanceGuiTooltip(tip,true);assert.equal(changes.length,0);button.hovered=false;advanceGuiTooltip(tip,true);assert.ok(changes.some(c=>c.reasons.includes('paint')));assert.equal(tip.active,false);system.destroy();root.destroy();
 }finally{performance.now=original;}
});
