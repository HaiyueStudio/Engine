import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiInput}=await importEngineSource('gui/components/GuiInput.ts');
const {guiInputPresentation}=await importEngineSource('gui/input/GuiInputPresentation.ts');
const textBatch=await importEngineSource('gui/rendering/GuiTextBatch.ts');
const rendererModule=await importEngineSource('gui/rendering/GuiRenderer.ts');
const {bitmapKerningKey}=await importEngineSource('font/BitmapFontData.ts');
const {guiGraphemeBoundaries}=await importEngineSource('gui/input/GuiGraphemes.ts');
function font() {
  const glyph=(id,advance)=>({id,x:0,y:0,width:8,height:10,xoffset:0,yoffset:0,xadvance:advance,page:0});
  return {id:1,size:10,lineHeight:12,scaleW:64,scaleH:64,chars:new Map([[65,glyph(65,8)],[66,glyph(66,13)],[63,glyph(63,6)],[32,glyph(32,4)],[0x1f600,glyph(0x1f600,10)],[0x301,glyph(0x301,0)]]),kernings:new Map([[bitmapKerningKey(65,66),-2]])};
}
const createMeasure=(f,size)=>textBatch.createGuiTextMeasurer?.(f,size)??(text=>textBatch.measureGuiTextWidth(text,typeof f==='function'?f():f,size));
function input(value,multiline=false){const valueInput=new GuiInput({value,multiline,width:2000,height:150});valueInput.layout({x:0,y:0,width:2000,height:150});valueInput.setCaret(0);return valueInput;}
function oracle(value,x,measure,normalize=false){const boundaries=guiGraphemeBoundaries(value),prefix=end=>measure(normalize?value.slice(0,end).replace(/\r\n|\r|\n/gu,' '):value.slice(0,end));for(let i=1;i<boundaries.length;i++)if(x<(prefix(boundaries[i-1])+prefix(boundaries[i]))/2)return boundaries[i-1];return value.length;}

for(const length of [128,512])test(`stock font pointer hit walks ${length} characters linearly`,()=>{
  const f=font(),original=f.chars.get;let lookups=0;f.chars.get=function(...args){lookups++;return original.apply(this,args);};
  const i=input('A'.repeat(length)),renderer=new rendererModule.GuiRenderer();renderer.defaultFont=f;
  const measure=rendererModule.guiRendererTextMeasure?.(renderer,10)??(text=>renderer.measureTextWidth(text,10));
  const p=guiInputPresentation(i,measure,10);lookups=0;
  assert.equal(p.indexAt(p.origin.x+length*8,p.origin.y),length);
  assert.ok(lookups<=length*3,JSON.stringify({length,lookups}));renderer.destroy();
});

test('Unicode clusters, CRLF normalization, multiline rows and selection share the original metrics',()=>{
  const f=font(),measure=text=>textBatch.measureGuiTextWidth(text,f,10);
  for(const [value,multiline]of [['A😀B',false],['A\u0301B',false],['A👩‍👩‍👧B',false],['A\r\nB',false],['A\r\nBB\n😀B',true]]){
    const i=input(value,multiline),p=guiInputPresentation(i,createMeasure(f,10),10,12),rows=multiline?value.split(/\r\n|\r|\n/gu):[value];
    let start=0;
    for(let row=0;row<rows.length;row++){
      for(let x=-1;x<=100;x+=2)assert.equal(p.indexAt(p.origin.x+x,p.origin.y+row*12+1),start+oracle(rows[row],x,measure,!multiline),JSON.stringify({value,row,x}));
      if(row+1<rows.length){const match=/\r\n|\r|\n/gu;match.lastIndex=start;const m=match.exec(value);start=m.index+m[0].length;}
    }
    for(const end of guiGraphemeBoundaries(rows[0]).slice(1)){const rect=p.ranges(0,end)[0];assert.equal(rect.width,Math.max(1,measure(rows[0].slice(0,end).replace(/\r\n|\r|\n/gu,' '))));}
  }
});

test('retained presentations observe mutable glyphs, kerning and replacement font identities',()=>{
  let current=font();const i=input('AAAA'),p=guiInputPresentation(i,createMeasure(()=>current,10),10);
  const verify=()=>{for(let x=0;x<85;x+=3)assert.equal(p.indexAt(p.origin.x+x,p.origin.y),oracle('AAAA',x,text=>textBatch.measureGuiTextWidth(text,current,10)));};
  verify();current.chars.get(65).xadvance=20;verify();current.kernings.set(bitmapKerningKey(65,65),-12);verify();
  current.chars.set(65,{...current.chars.get(65),xadvance:4});verify();current=font();current.chars.get(65).xadvance=15;verify();
});

test('non-monotone advances and custom measurement preserve first-threshold hit semantics',()=>{
  const f=font();f.chars.get(65).xadvance=5;f.kernings.set(bitmapKerningKey(65,65),-10);
  const i=input('AAAA'),p=guiInputPresentation(i,createMeasure(f,10),10);
  for(let x=-2;x<30;x++)assert.equal(p.indexAt(p.origin.x+x,p.origin.y),oracle(i.value,x,text=>textBatch.measureGuiTextWidth(text,f,10)));
  const renderer=new rendererModule.GuiRenderer();renderer.defaultFont=f;renderer.measureTextWidth=text=>text.length**2;
  const measure=rendererModule.guiRendererTextMeasure?.(renderer,10)??(text=>renderer.measureTextWidth(text,10));
  const custom=guiInputPresentation(i,measure,10);for(let x=0;x<20;x++)assert.equal(custom.indexAt(custom.origin.x+x,custom.origin.y),oracle(i.value,x,measure));renderer.destroy();
});
