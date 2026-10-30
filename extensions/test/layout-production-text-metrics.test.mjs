import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from './responsive-layout-fixture.mjs';

const {spec,runtime}=await loadResponsiveLayoutModules();
test('layout uses the prepared font provider for intrinsic measurement and final text placement',()=>{
 const source=responsiveLayoutFixture();source.instances=source.instances.slice(0,1);source.artboards=source.artboards.slice(0,1);
 const board=source.artboards[0],root=board.nodes.find(n=>!n.parent),text=board.nodes.find(n=>n.kind==='text');
 board.nodes=[root,text];text.parent=root.id;text.style={width:{unit:'hug'},height:{unit:'hug'}};
 const document=spec.parseResponsiveLayoutDocument(source),legacy=new runtime.LayoutEvaluator(document),calls=[];
 const supplied=Object.freeze({id:'label',width:137,height:45,contentWidth:137,contentHeight:45,glyphs:Object.freeze([]),lines:Object.freeze([]),controls:Object.freeze([])});
 let active=supplied,disposals=0;
 const provider={evaluate(id,request){calls.push({id,strings:request.strings});return active;},dispose(){disposals++;}};
 const evaluator=new runtime.LayoutEvaluator(document,undefined,provider);
 const request={viewport:[320,180],dpr:1,time:0,strings:{inputText:'Real-font-shaped text'}};
 const result=evaluator.evaluate(request),pose=result.nodes.find(n=>n.nodeId===text.id),old=legacy.evaluate(request).nodes.find(n=>n.nodeId===text.id);
 assert.ok(calls.length>=2);assert.ok(calls.every(c=>c.id==='label'&&c.strings.inputText==='Real-font-shaped text'));
 assert.equal(pose.text.contentWidth,137);assert.equal(pose.text.contentHeight,45);assert.equal(pose.rect.width,137);assert.equal(pose.rect.height,45);
 assert.notEqual(old.rect.width,pose.rect.width);
 active={...supplied,contentWidth:189,contentHeight:61};const changed=evaluator.evaluate({...request,strings:{inputText:'changed language'}}).nodes.find(n=>n.nodeId===text.id);
 assert.equal(changed.rect.width,189);assert.equal(changed.rect.height,61);
 evaluator.dispose();evaluator.dispose();assert.equal(disposals,0);assert.equal(provider.evaluate('label',request),active);legacy.dispose();
});

test('prepared text provider failures remain visible and do not silently fall back to synthetic metrics',()=>{
 const document=spec.parseResponsiveLayoutDocument(responsiveLayoutFixture());
 const evaluator=new runtime.LayoutEvaluator(document,undefined,{evaluate(){throw Error('font generation obsolete');}});
 assert.throws(()=>evaluator.evaluate({viewport:[320,180],dpr:1,time:0}),/font generation obsolete/);evaluator.dispose();
});
