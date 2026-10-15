import assert from 'node:assert/strict';
import test from 'node:test';
import { GuiToast, GuiRoot, GuiButton, GuiSystem, serializeGuiElement, deserializeGuiElement, hitTestGui } from '../dist/gui.js';
import { Entity, World } from '../dist/ecs.js';

test('toast uses entry, full hold and exit, ignores idle delta and restarts on replacement', () => {
  const toast = new GuiToast({durationMs:1000,animationMs:200});
  assert.equal(toast.visible,false);
  toast.show({text:'Saved'}); toast.advanceAnimation(60000);
  assert.equal(toast.progress,0);
  toast.advanceAnimation(100); assert.equal(toast.progress,.5);
  toast.advanceAnimation(100); assert.equal(toast.progress,1);
  toast.clearDirty(); toast.advanceAnimation(500); assert.equal(toast.dirty,false,'static hold does not rebuild or upload GUI batches');
  toast.advanceAnimation(500); assert.equal(toast.progress,1);
  toast.advanceAnimation(100); assert.equal(toast.progress,.5);
  toast.show({text:'New message'}); assert.equal(toast.text,'New message');
  assert.equal(toast.progress,0); toast.advanceAnimation(0); toast.advanceAnimation(1400);
  assert.equal(toast.animating,false); assert.equal(toast.visible,false);
});

test('zero transitions and invalid times are finite; hiding never destroys a borrowed icon', () => {
  let destroyed=false; const icon={destroy(){destroyed=true}};
  const toast=new GuiToast({icon,animationMs:0,durationMs:50});
  toast.show(); toast.advanceAnimation(0); assert.equal(toast.progress,1);
  toast.advanceAnimation(NaN); toast.advanceAnimation(-5); assert.equal(toast.visible,true);
  toast.advanceAnimation(50); assert.equal(toast.visible,false); assert.equal(destroyed,false);
  toast.show({durationMs:NaN,animationMs:-1}); toast.advanceAnimation(0); toast.advanceAnimation(1);
  assert.equal(toast.visible,false);
});

test('toast is click-through, serializes configuration and resolves borrowed icon by key', () => {
  const root=new GuiRoot(),world=new World(),icon={};
  const button=root.add(new GuiButton({width:200,height:60}));
  const toast=root.add(new GuiToast({text:'Done',icon,iconKey:'check',width:200,height:60,durationMs:3000,animationMs:0}));
  toast.show(); root.layout(320,480);
  assert.equal(hitTestGui(world,new Set([root]),40,30),button);
  const saved=serializeGuiElement(toast); const copy=deserializeGuiElement(saved,{resolveImageSource:key=>key==='check'?icon:null});
  assert.ok(copy instanceof GuiToast); assert.equal(copy.text,'Done'); assert.equal(copy.icon,icon);
  assert.equal(copy.durationMs,3000); assert.equal(copy.animationMs,0);
  assert.throws(()=>deserializeGuiElement({...saved,props:{durationMs:NaN}}));
});

test('demand rendering keeps toast alive, advances once per shared frame and stops on suspension', () => {
  const system=new GuiSystem({}),root=new GuiRoot(),world=new World();
  world.addEntity(new Entity().addComponent(root)); world.addSystem(system); system.roots.add(root);
  const toast=root.add(new GuiToast({animationMs:100,durationMs:200})); toast.show();
  const frame={frameId:1}; system.advanceMotion(world,10000,frame);
  frame.frameId++; system.advanceMotion(world,50,frame); system.advanceMotion(world,50,frame);
  assert.equal(toast.progress,.5); assert.equal(system.animating,true);
  system.stopAnimations(); assert.equal(toast.visible,false); assert.equal(system.animating,false);
  toast.show(); root.root.setVisible(false); frame.frameId++; system.advanceMotion(world,10,frame);
  assert.equal(toast.visible,false); system.destroy();
});

test('toast text, icon and background share popup layer and opacity without changing ordinary images', () => {
  const system=new GuiSystem({}),renderer=system.renderer,root=new GuiRoot();
  const toast=root.add(new GuiToast({text:'Saved',icon:{},width:250,height:48,animationMs:100}));
  toast.show(); toast.advanceAnimation(0); toast.advanceAnimation(50); root.layout(320,480);
  const cache=renderer.getRootCache(root); renderer.rebuildRoot(root,cache);
  assert.equal(cache.batch.commands.length,0);
  assert.equal(cache.popupBatch.commands[0].color[3],.5);
  assert.equal(cache.popupImageBatch.commands[0].color[3],.5);
  assert.equal(cache.popupTextBatch.commands[0].color[3],.5);
  assert.equal(cache.popupTextBatch.commands[0].height,48);
  toast.hide(); renderer.rebuildRoot(root,cache);
  assert.equal(cache.popupImageBatch.commands.length,0);
  assert.equal(cache.popupTextBatch.commands.length,0); system.destroy();
});
