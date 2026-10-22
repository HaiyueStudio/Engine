import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiSystem,GuiInput} from '../dist/gui.js';
import {GuiTextBatch} from '../dist/experimental.js';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture(){
 const measured=[],drawn=[],device=createAuditGpuDevice();
 const engine={device,format:'bgra8unorm',displayWidth:300,displayHeight:100,getDepthFormat:()=> 'depth24plus'};
 const system=new GuiSystem(engine,{font:{chars:'?Aé👩🏽‍💻😀',fontSize:20,atlasSize:128,canvasFactory(width,height){
  const pixels=new Uint8ClampedArray(width*height*4);
  const context={measureText(text){measured.push(text);return {width:20,actualBoundingBoxAscent:15,actualBoundingBoxDescent:4};},clearRect(){},fillText(text,x,y){drawn.push(text);const i=((y-5)*width+x)*4;pixels.set(text==='😀'||text==='👩🏽‍💻'?[240,120,30,255]:[255,255,255,255],i);},getImageData(){return {data:pixels};}};
  return {width,height,getContext:()=>context};
 }}});
 system.renderer.prepare(engine);
 return {system,measured,drawn,font:system.renderer.defaultFont,close:()=>system.destroy()};
}

test('GUI atlas rasterizes combining and ZWJ clusters once, with matching draw and caret widths',()=>{
 const f=fixture();
 try{
  assert.deepEqual(f.drawn,['?','A','é','👩🏽‍💻','😀']);
  assert.deepEqual(f.measured,f.drawn);
  const text='é👩🏽‍💻😀😀',batch=new GuiTextBatch();
  batch.addText({text,x:0,y:0,width:300,height:60,fontSize:20,color:[.2,.4,.6,.5]});batch.rebuild(f.font);
  assert.equal(batch.vertexCount,4*6,'one quad per extended grapheme');
  const measure=s=>f.system.renderer.measureTextWidth(s,20);
  assert.equal(measure(text),4*21);
  const input=new GuiInput({value:text});
  for(const [x,index] of [[0,0],[21,2],[42,9],[63,11],[84,13]])assert.equal(input.getCaretIndexAt(x,measure,0),index);
  input.setCaret(11);input.deleteBackward();assert.equal(input.value,'é👩🏽‍💻😀','only the first independent emoji is removed');
  input.undo();assert.equal(input.value,text);
 }finally{f.close();}
});

test('colored glyphs retain atlas RGB while ordinary glyphs retain theme tint and shared opacity',()=>{
 const f=fixture();try{
  const batch=new GuiTextBatch();batch.addText({text:'é👩🏽‍💻',x:0,y:0,width:200,height:60,fontSize:20,color:[.2,.4,.6,.5]});batch.rebuild(f.font);
  const stride=12,first=[...batch.vertexData.slice(4,8)],second=[...batch.vertexData.slice(6*stride+4,6*stride+8)];
  first.forEach((v,i)=>assert.ok(Math.abs(v-[.2,.4,.6,.5][i])<1e-6));
  assert.deepEqual(second,[-1,-1,-1,.5]);
 }finally{f.close();}
});

 test('GUI clustered atlas treats CRLF as one line break, not a fallback glyph',()=>{
 const f=fixture();try{
  const batch=new GuiTextBatch();batch.addText({text:'A\r\n😀',x:0,y:0,width:200,height:100,fontSize:20,color:[1,1,1,1],multiline:true});batch.rebuild(f.font);
  assert.equal(batch.vertexCount,12);assert.equal(f.system.renderer.measureTextWidth('A\r\n😀',20),21);
  assert.ok(batch.vertexData[6*12+1]>batch.vertexData[1]);
 }finally{f.close();}
});
