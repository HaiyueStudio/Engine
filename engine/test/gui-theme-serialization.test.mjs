import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){return next(specifier==='./components'&&context.parentURL?.endsWith('/GuiSerialization.ts')?'./components/index':specifier,context);}});
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiNineSlice}=await importEngineSource('gui/components/GuiNineSlice.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const {serializeGuiRoot,deserializeGuiRoot,serializeGuiElement}=await importEngineSource('gui/GuiSerialization.ts');
test('v1 snapshots keep borrowed theme resources outside the wire format and preserve original local styles',()=>{
 const resource=new GuiThemeResource({normal:{fontFamily:'G07UniqueFamily',fontSize:22,icon:{width:2,height:2}}}),root=new GuiRoot({themeResource:resource}),button=root.add(new GuiButton({text:'saved',style:{color:'red',padding:8}}));
 const data=serializeGuiRoot(root),text=JSON.stringify(data);assert.equal(data.version,1);assert.ok(!text.includes('G07UniqueFamily'));assert.ok(!text.includes('themeResource'));const copy=deserializeGuiRoot(JSON.parse(text));assert.deepEqual(copy.findById(button.id).style,{color:'red',padding:8});copy.destroy();root.destroy();
});
test('runtime-only local skin styles and nine-slice primitives fail explicitly instead of serializing GPU objects or losing borders',()=>{
 assert.throws(()=>serializeGuiElement(new GuiButton({style:{icon:{width:2,height:2}}})),/style|property/i);
 assert.throws(()=>serializeGuiElement(new GuiNineSlice({source:{width:30,height:30},sourceWidth:30,sourceHeight:30,cuts:[4,4,4,4]})),/runtime bindings/i);
});
