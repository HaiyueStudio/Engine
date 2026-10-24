import {ProductionTextOwner} from '/paint-build/animation/text/production/ProductionTextOwner.js';
import {createProductionBrowserFontPort} from '/paint-build/animation/text/production/ProductionBrowserFontPort.js';
import {LayoutAssetOwner} from '/paint-build/animation/layout/parameterized/AssetOwner.js';
const result=document.querySelector('#result'),dpr=Number(new URLSearchParams(location.search).get('dpr')??1),cases=[],captures=[];
const check=(ok,message)=>{if(!ok)throw Error(message)},initialFonts=document.fonts.size,bitmaps=new Set();
const css=c=>`rgba(${c[0]*255},${c[1]*255},${c[2]*255},${c[3]})`;
let assets,owner,face;
function image(){const canvas=document.createElement('canvas');canvas.width=320*dpr;canvas.height=240*dpr;const context=canvas.getContext('2d',{willReadFrequently:true});context.scale(dpr,dpr);context.fillStyle='#f0f0f0';context.fillRect(0,0,320,240);return{canvas,context};}
// Independent whole-page font oracle. It uses the authored outline bounds (closed-form cubic extremum), instead of
// reusing prepared glyph rectangles, bitmap origins, paint commands or cache keys.
function nativePaint(c,source,metrics){
 if(source.kind==='solid')return css(source.color);
 if(source.kind==='linear-gradient'){
  if(source.start[0]===source.end[0]&&source.start[1]===source.end[1])return css(source.stops[0].color);
  const position=point=>[-metrics.actualBoundingBoxLeft+point[0]*(metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight),-metrics.actualBoundingBoxAscent+point[1]*(metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent)];
  const a=position(source.start),b=position(source.end),gradient=c.createLinearGradient(...a,...b);
  source.stops.forEach(s=>gradient.addColorStop(s.offset,css(s.color)));return gradient;
 }
 c.save();c.translate(-metrics.actualBoundingBoxLeft,-metrics.actualBoundingBoxAscent);c.scale(metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight,metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent);
 const g=c.createRadialGradient(...source.center,0,...source.center,source.radius);source.stops.forEach(s=>g.addColorStop(s.offset,css(s.color)));c.restore();return g;
}
// The radial oracle paints a full-page gradient first, then masks it with an
// independent FontFace glyph. It never uses a candidate bitmap or its metrics.
function radialReference(destination,source,metrics,character,opacity,stroke){
 const canvas=document.createElement('canvas');canvas.width=320*dpr;canvas.height=240*dpr;const c=canvas.getContext('2d',{willReadFrequently:true}),base=destination.getTransform();
 c.setTransform(base);c.translate(-metrics.actualBoundingBoxLeft,-metrics.actualBoundingBoxAscent);c.scale(metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight,metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent);
 const gradient=c.createRadialGradient(...source.center,0,...source.center,source.radius);for(const stop of source.stops)gradient.addColorStop(stop.offset,css(stop.color));c.fillStyle=gradient;const t=c.getTransform();c.fillRect(-t.e/t.a,-t.f/t.d,canvas.width/t.a,canvas.height/t.d);
 c.setTransform(base);c.globalCompositeOperation='destination-in';c.font=destination.font;c.textBaseline='alphabetic';c.textAlign='left';c.direction='ltr';c.fillStyle=c.strokeStyle='#fff';
 if(stroke){c.lineWidth=stroke.width;c.lineJoin=stroke.join??'miter';c.strokeText(character,0,0);}else c.fillText(character,0,0);
 destination.save();destination.setTransform(1,0,0,1,0,0);destination.globalAlpha=opacity;destination.drawImage(canvas,0,0);destination.restore();canvas.width=canvas.height=0;
}
function reference(text,style,origin){
 const out=image(),c=out.context;c.font=`${style.fontSize}px "G11 independent paint reference"`;c.textBaseline='alphabetic';c.direction='ltr';c.textAlign='left';
 let x=origin[0];const baseline=origin[1]+style.fontSize*.8;
 for(const character of text){const measured=c.measureText(character),size=style.fontSize,t=(-14+Math.sqrt(224))/2,s=1-t,bRight=s*s*s*400+3*s*s*t*750+3*s*t*t*750+t*t*t*350;
  // Paint bounds are source-outline coordinates, independent of hinted native ink boxes.
  const metrics={width:measured.width,actualBoundingBoxLeft:-.05*size,actualBoundingBoxRight:(character==='A'?.65:bRight/1000)*size,actualBoundingBoxAscent:.7*size,actualBoundingBoxDescent:0};c.save();c.translate(x,baseline);
  for(const fill of style.fills){if(fill.source.kind==='radial-gradient')radialReference(c,fill.source,metrics,character,fill.opacity??1);else{c.fillStyle=nativePaint(c,fill.source,metrics);c.globalAlpha=fill.opacity??1;c.fillText(character,0,0);}}
  for(const stroke of style.strokes??[]){if(stroke.source.kind==='radial-gradient')radialReference(c,stroke.source,metrics,character,stroke.opacity??1,stroke);else{c.strokeStyle=nativePaint(c,stroke.source,metrics);c.globalAlpha=stroke.opacity??1;c.lineWidth=stroke.width;c.lineJoin=stroke.join??'miter';c.strokeText(character,0,0);}}
  c.restore();x+=metrics.width+style.tracking;
 }return out;
}
function production(frame,origin){const out=image(),c=out.context;c.translate(...origin);for(const run of frame.runs)for(const glyph of run.glyphs){check(glyph.paint.kind==='bitmap','native paint must retain its existing bitmap path');bitmaps.add(glyph.paint.source.value);c.save();c.transform(...glyph.transform);c.globalAlpha=glyph.opacity;c.imageSmoothingEnabled=false;c.drawImage(glyph.paint.source.value,0,0,1,1);c.restore();}return out;}
function compare(id,actual,expected){const a=actual.context.getImageData(0,0,actual.canvas.width,actual.canvas.height).data,b=expected.context.getImageData(0,0,expected.canvas.width,expected.canvas.height).data;let max=0,different=0,ink=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d)different++;if(i%4===0&&a[i]!==240)ink++;}captures.push({id,actual:actual.canvas.toDataURL(),reference:expected.canvas.toDataURL()});cases.push({id,maximumChannelDifference:max,differingChannels:different,inkPixels:ink});check(ink>30,id+': absent real glyph ink');check(max<=2,id+': difference '+max+' exceeds original tolerance 2');}
const stops=[{offset:0,color:[.9,.1,.2,1]},{offset:.45,color:[.1,.7,.2,1]},{offset:1,color:[.1,.2,.9,1]}],linear={kind:'linear-gradient',start:[0,0],end:[1,0],stops};
try{
 const doc=await(await fetch('/paint-fixture/document.json')).json(),bytes=await(await fetch('/paint-fixture/font.otf')).arrayBuffer();face=await new FontFace('G11 independent paint reference',bytes).load();document.fonts.add(face);
 assets=new LayoutAssetOwner(doc,{policy:{mode:'deny'}});owner=new ProductionTextOwner(doc,createProductionBrowserFontPort(assets,{maxBitmapBytes:8*1024*1024}));await owner.prepare();
 const variants=[
  {id:'linear-horizontal-multiglyph',paint:linear},
  {id:'linear-vertical',paint:{...linear,end:[0,1]}},
  {id:'linear-diagonal',paint:{...linear,start:[-.2,.15],end:[1.2,.85]}},
  {id:'radial-ellipse',paint:{kind:'radial-gradient',center:[.3,.4],radius:.8,stops}},
  {id:'linear-alpha',paint:{...linear,stops:stops.map((s,i)=>({...s,color:[...s.color.slice(0,3),[.2,.8,.4][i]]}))}},
  {id:'radial-alpha',paint:{kind:'radial-gradient',center:[.5,.5],radius:.75,stops:stops.map((s,i)=>({...s,color:[...s.color.slice(0,3),[.2,.8,.4][i]]}))}},
  {id:'twelve-stops',paint:{...linear,stops:Array.from({length:12},(_,i)=>({offset:i/11,color:[i%2,(i+1)%2,.4,1]}))}},
  {id:'hard-repeated-stop',paint:{...linear,stops:[{offset:0,color:[1,0,0,1]},{offset:.5,color:[1,0,0,1]},{offset:.5,color:[0,0,1,1]},{offset:1,color:[0,0,1,1]}]}},
  {id:'degenerate-linear',paint:{...linear,end:[0,0]}},
  {id:'fractional-small',paint:linear,size:24,origin:[20.25,12.5]},
  {id:'gradient-opacity',paint:linear,opacity:.35},
  {id:'gradient-stroke-and-fill',paint:linear,stroke:true},
 ];
 for(const v of variants){
  const size=v.size??80,origin=v.origin??[20,12],style={...doc.textStyles[0],fontSize:size,lineHeight:size*1.2,tracking:0,fills:[{source:v.paint,opacity:v.opacity??1}],strokes:v.stroke?[{source:{kind:'radial-gradient',center:[.5,.5],radius:1,stops},width:2,join:'round',opacity:.7}]:[]};
  const request={block:'label',dpr,rasterOrigin:origin,strings:{value:'AB'},styles:{body:style},constraints:{width:{mode:'exact',value:280},height:{mode:'unbounded'}}};
  const frame=owner.shape(request);compare(v.id,production(frame,origin),reference('AB',style,origin));check(owner.shape(request)===frame,'identical paint request must reuse original result');
 }
 const invalid=[{...linear,stops:[stops[1],stops[0]]},{...linear,start:[NaN,0]},{...linear,stops:[{offset:0,color:[2,0,0,1]},stops[2]]},{kind:'radial-gradient',center:[0,0],radius:0,stops},{...linear,stops:[stops[0]]}];
 for(const paint of invalid){let error;try{owner.shape({block:'label',styles:{body:{fills:[{source:paint}]}}});}catch(e){error=e;}check(error?.code==='E_HYA_RUNTIME_TEXT','malformed native gradient must reject explicitly');}cases.push({id:'invalid-gradient-no-fallback',count:invalid.length});
 owner.dispose();owner.dispose();assets.dispose();document.fonts.delete(face);check([...bitmaps].every(b=>b.width===0&&b.height===0),'glyph bitmap residue');check(document.fonts.size===initialFonts,'owned FontFace residue');cases.push({id:'owned-font-and-bitmap-cleanup',bitmaps:bitmaps.size,fontResidue:0});
 result.textContent=JSON.stringify({status:'passed',caseCount:cases.length,cases,captures,dpr,scope:'Real native glyph bitmap port and opaque composite; independent FontFace paints and authored analytical bounds, all pixels tolerance 2. Not final GPU or physical Native qualification.'});result.dataset.status='passed';
}catch(error){owner?.dispose();assets?.dispose();if(face)document.fonts.delete(face);result.textContent=JSON.stringify({status:'failed',cases,captures,error:String(error.stack??error)});result.dataset.status='failed';}
