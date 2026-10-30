import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const {GuiPixelResources}=await importEngineSource('gui/GuiPixelResources.ts');
class ImageEvents extends EventTarget {
 width=16;height=16;naturalWidth=0;naturalHeight=0;complete=false;listeners=0;
 addEventListener(...args){this.listeners++;super.addEventListener(...args);}
 removeEventListener(...args){this.listeners--;super.removeEventListener(...args);}
 ready(){this.naturalWidth=32;this.naturalHeight=24;this.complete=true;this.dispatchEvent(new Event('load'));}
}

test('shared themed image readiness invalidates metrics and paint once per control with one source subscription',()=>{
 const image=new ImageEvents(),resource=new GuiThemeResource({normal:{icon:image}}),root=new GuiRoot({themeResource:resource});
 const a=root.add(new GuiButton()),b=root.add(new GuiButton());const changed=[];
 const owner=new GuiPixelResources((element,source)=>{changed.push([element,source]);element.markDirty(3);});owner.sync([root]);root.clearDirty();
 assert.equal(image.listeners,2);image.ready();assert.equal(changed.length,3);assert.ok(changed.some(([element])=>element===a));assert.ok(changed.some(([element])=>element===b));
 root.destroy();assert.equal(image.listeners,0);const before=changed.length;image.ready();assert.equal(changed.length,before);owner.release();
});

test('replacing or detaching a themed skin stops old image callbacks before the next render',()=>{
 const old=new ImageEvents(),next=new ImageEvents(),resource=new GuiThemeResource({controls:{GuiButton:{normal:{nineSlice:{source:old,sourceWidth:16,sourceHeight:16,cuts:[3,3,3,3]}}}}});
 const root=new GuiRoot({themeResource:resource}),button=root.add(new GuiButton());const changes=[];
 const owner=new GuiPixelResources((element,source)=>changes.push([element,source]));owner.sync([root]);root.clearDirty();
 assert.equal(old.listeners,2);resource.update({controls:{GuiButton:{normal:{nineSlice:{source:next,sourceWidth:16,sourceHeight:16,cuts:[3,3,3,3]}}}}});
 assert.equal(old.listeners,0);assert.equal(next.listeners,2);old.ready();assert.equal(changes.length,0);
 next.ready();assert.equal(changes.length,1);assert.equal(changes[0][0],button);
 root.remove(button);assert.equal(next.listeners,0);root.destroy();owner.release();
});
