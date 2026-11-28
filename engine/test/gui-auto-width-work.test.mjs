import assert from 'node:assert/strict';
import test from 'node:test';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiLabel}=await importEngineSource('gui/components/GuiLabel.ts');
const {GuiHelpDialog}=await importEngineSource('gui/components/GuiHelpDialog.ts');
const {GuiSystem}=await importEngineSource('gui/systems/GuiSystem.ts');
const {registerGuiFontProvider,bindGuiMeasureOwner}=await importEngineSource('gui/GuiMeasure.ts');
const {retainGuiLayout,releaseGuiLayout}=await importEngineSource('gui/GuiLayoutState.ts');
const {guiLabelMeasuredTextWidth,guiHelpDialogTextMetrics}=await importEngineSource('gui/GuiIntrinsicText.ts');

function fixture(){
  const root=new GuiRoot(),system=new GuiSystem({}),owner={},state={version:1,fontQueries:0,widthQueries:0};
  registerGuiFontProvider(owner,()=>{state.fontQueries++;return {id:state.version};},()=>{});bindGuiMeasureOwner(root,owner);
  system.renderer.measureTextWidth=(text,size)=>{state.widthQueries++;return text.length*size;};
  return {root,system,state,scan(){system.measureAutoWidthLabels(root.root,14,root);},close(){system.destroy();root.destroy();}};
}

test('fixed and layout-managed labels never query unused font versions or skins in the auto-width preflight',()=>{
  const f=fixture(),labels=[];let skins=0;
  try {
    for(let i=0;i<256;i++)labels.push(f.root.add(new GuiLabel({text:'fixed',width:100,height:20,autoWidth:false})));
    const managed=f.root.add(new GuiLabel({text:'managed',autoWidth:true}));retainGuiLayout(managed,{x:0,y:0,width:100,height:20});labels.push(managed);
    for(const label of labels){const resolved=label.getResolvedStyle;label.getResolvedStyle=function(){skins++;return resolved.call(this);};}
    f.state.fontQueries=f.state.widthQueries=0;
    for(let frame=0;frame<3;frame++)f.scan();
    assert.equal(f.state.fontQueries,0);assert.equal(f.state.widthQueries,0);assert.equal(skins,0);
    releaseGuiLayout(managed);
  } finally {for(const label of labels)releaseGuiLayout(label);f.close();}
});

test('unmanaged auto-width labels keep the existing text, size and font-version cache',()=>{
  const f=fixture(),label=f.root.add(new GuiLabel({text:'AB',autoWidth:true}));
  try {
    f.state.widthQueries=0;f.scan();assert.equal(guiLabelMeasuredTextWidth(label),28);assert.equal(f.state.widthQueries,1);
    f.scan();assert.equal(f.state.widthQueries,1);
    label.setText('ABC');f.scan();assert.equal(guiLabelMeasuredTextWidth(label),42);assert.equal(f.state.widthQueries,2);
    label.setFontSize(20);f.scan();assert.equal(guiLabelMeasuredTextWidth(label),60);assert.equal(f.state.widthQueries,3);
    f.state.version++;f.scan();assert.equal(f.state.widthQueries,4);f.scan();assert.equal(f.state.widthQueries,4);
  } finally {f.close();}
});

test('HelpDialog retains current font-version metrics while its fixed internal labels skip unused queries',()=>{
  const f=fixture(),help=f.root.add(new GuiHelpDialog({message:'help text'}));
  try {
    f.state.fontQueries=0;f.scan();const first=guiHelpDialogTextMetrics(help);
    assert.equal(f.state.fontQueries,1);assert.equal(first.version,1);assert.equal(first.measure('AB',12),24);
    f.state.version=2;f.state.fontQueries=0;f.scan();const second=guiHelpDialogTextMetrics(help);
    assert.equal(f.state.fontQueries,1);assert.equal(second.version,2);assert.equal(second.measure('ABC',10),30);
  } finally {f.close();}
});
