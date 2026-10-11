import test from 'node:test';
import assert from 'node:assert/strict';
import { captureShareImage, renderShareCard, prepareShareContent, createChallengeLink, parseChallengeLink } from '@haiyue/extensions/share-content';
import { I18n } from '@haiyue/extensions/i18n';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const dataURL=`data:image/png;base64,${png}`;
const challenge={gameId:'sudoku',rulesVersion:'v3',mode:'expert',seed:'中文 /?&= 123'};
const policy={gameId:'sudoku',rulesVersion:'v3',allowedOrigins:['https://example.com']};
function canvas() {
 const text=[],images=[];
 const context={font:'20px sans-serif',fillStyle:'',textBaseline:'top',fillRect(){},fillText:(value,x,y)=>text.push({value,x,y}),drawImage:(...args)=>images.push(args),measureText(value){return {width:Array.from(value).length*parseFloat(this.font.replace('bold ',''))*.6};}};
 const source={width:1200,height:630,getContext:()=>context,toDataURL:()=>dataURL};
 return {source,text,images,context,createCanvas:()=>source};
}
test('challenge links round trip Unicode with schema, preserve route/query/hash and are deterministic',()=>{
 const base='https://example.com/play?campaign=test#level';const link=createChallengeLink(base,challenge);
 assert.equal(link,createChallengeLink(base,challenge));assert.equal(new URL(link).hash,'#level');assert.equal(new URL(link).searchParams.get('campaign'),'test');
 assert.deepEqual(parseChallengeLink(link,policy),challenge);assert.equal(parseChallengeLink(base,policy),null);
});
test('challenge imports reject foreign games/origins/rules, duplicate parameters and malformed or excessive data',()=>{
 const link=createChallengeLink('https://example.com',challenge),u=new URL(link);
 u.searchParams.append('hyChallenge',u.searchParams.get('hyChallenge'));assert.throws(()=>parseChallengeLink(u.href,policy),/duplicate/);
 for(const change of [{gameId:'other'},{rulesVersion:'v2'},{allowedOrigins:['https://evil.example']}])assert.throws(()=>parseChallengeLink(link,{...policy,...change}));
 for(const raw of ['null','[]','{"v":2}',JSON.stringify({v:1,...challenge,script:'evil'}),'x'.repeat(2049)])assert.throws(()=>parseChallengeLink(`https://example.com?hyChallenge=${encodeURIComponent(raw)}`,policy));
 for(const base of ['javascript:alert(1)','file:///tmp/a','https://user:password@example.com',link])assert.throws(()=>createChallengeLink(base,challenge));
 assert.throws(()=>createChallengeLink('https://example.com',{...challenge,seed:'x'.repeat(257)}));
});
test('capture calls encoder synchronously and preserves borrowed source dimensions',async()=>{
 let called=false,callback;
 const source={width:23,height:11,toBlob:cb=>{called=true;callback=cb;}};
 const pending=captureShareImage(source);assert.equal(called,true);source.width=99;
 callback(new Blob([Buffer.from(png,'base64')],{type:'image/png'}));const result=await pending;
 assert.equal(result.width,23);assert.equal(result.height,11);assert.equal(source.width,99);assert.equal(result.filename,'result.png');assert.deepEqual(result.bytes,new Uint8Array(Buffer.from(png,'base64')));
});
test('Native-compatible data URL capture needs no DOM, atob, Blob or Buffer in the implementation',async()=>{
 const result=await captureShareImage({width:1,height:1,toDataURL:()=>dataURL});
 assert.deepEqual(result.bytes,new Uint8Array(Buffer.from(png,'base64')));
 const jpeg=await captureShareImage({width:1,height:1,toDataURL:()=> 'data:image/jpeg;base64,/9j/AA=='},{mimeType:'image/jpeg',filename:'score.jpg'});
 assert.equal(jpeg.mimeType,'image/jpeg');assert.equal(jpeg.filename,'score.jpg');
});
test('capture rejects encoder fallback, empty/corrupt data, bad names, dimensions and quality',async()=>{
 const source={width:1,height:1,toDataURL:()=>dataURL};
 for(const settings of [{mimeType:'image/jpeg'},{filename:'../a.png'},{quality:NaN},{quality:2},{mimeType:'image/webp'}])await assert.rejects(captureShareImage(source,settings));
 for(const value of ['data:,','data:image/png;base64,@@@@','data:image/png;base64,AAAA','data:image/png;base64,A==='])await assert.rejects(captureShareImage({...source,toDataURL:()=>value}));
 for(const [width,height] of [[0,1],[1.5,1],[4097,1],[4096,4096]])await assert.rejects(captureShareImage({...source,width,height}));
 await assert.rejects(captureShareImage({width:1,height:1,toBlob:cb=>cb(null)}));
});
test('abort settles without waiting for encoder and ignores late completion',async()=>{
 let callback;const controller=new AbortController();const source={width:2,height:2,toBlob:cb=>callback=cb};
 const pending=captureShareImage(source,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});
 callback(new Blob([Buffer.from(png,'base64')],{type:'image/png'}));
 let touched=false;await assert.rejects(captureShareImage({...source,toBlob:()=>touched=true},{signal:controller.signal}));assert.equal(touched,false);
});
test('card resolves localized text once, supports portrait and releases its private canvas',async()=>{
 const i18n=new I18n({locale:'en',fallbackLocale:'en'});i18n.register({schemaVersion:1,locale:'en',messages:{title:'Best {score}',label:'Score'}});
 const f=canvas();const result=await renderShareCard({width:630,height:1000,title:{key:'title',params:{score:100}},stats:[{label:{key:'label'},value:'100'}]}, {i18n,createCanvas:f.createCanvas});
 assert.equal(result.width,630);assert.equal(result.height,1000);assert.ok(f.text.some(t=>t.value==='Best 100'));assert.ok(f.text.some(t=>t.value==='Score'));
 assert.equal(f.source.width,0);assert.equal(f.source.height,0);i18n.dispose();
});
test('card composition crops cover and centers contain without mutating or closing borrowed artwork',async()=>{
 for(const fit of ['cover','contain']){
  const f=canvas(),borrowed={};await renderShareCard({title:'Result',image:{source:borrowed,width:400,height:200,fit}},{createCanvas:f.createCanvas});
  assert.equal(f.images.length,1);assert.equal(f.images[0][0],borrowed);assert.equal(f.images[0].length,fit==='cover'?9:5);
 }
});
test('English card titles wrap at word boundaries before reducing font size',async()=>{
 const f=canvas(),title='Expert Sudoku · Personal Best';
 await renderShareCard({width:900,height:1200,title},{createCanvas:f.createCanvas});
 assert.equal(f.text.map(t=>t.value).join(' '),title);
});
test('plain-text cards support Native runtimes with no Intl global',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Intl');
 try {
  Object.defineProperty(globalThis,'Intl',{value:undefined,configurable:true});
  const f=canvas();await renderShareCard({title:'中文 Native result'},{createCanvas:f.createCanvas});
  assert.ok(f.text.some(t=>t.value.includes('Native')));
 } finally {Object.defineProperty(globalThis,'Intl',descriptor);}
});
test('card layout rejects overflow, excessive stats and invalid colors, frees output on encode failure',async()=>{
 for(const card of [{title:'x'.repeat(3000)},{title:'x',stats:Array(5).fill({label:'x',value:'1'})},{title:'x',colors:{text:'red'}},{title:'x',width:100},{title:'x',image:{source:{},width:0,height:2}}])await assert.rejects(renderShareCard(card,{createCanvas:canvas().createCanvas}));
 const f=canvas();f.source.toDataURL=()=>{throw Error('tainted canvas');};await assert.rejects(renderShareCard({title:'x'},{createCanvas:f.createCanvas}),/tainted/);assert.equal(f.source.width,0);
});
test('preparation produces ready platform input with versioned link and no Native dependency',async()=>{
 const f=canvas();const result=await prepareShareContent({title:'Best run',text:'Beat my score',card:{title:'100'},challenge:{baseUrl:'https://example.com/play',data:challenge}},{createCanvas:f.createCanvas});
 assert.equal(result.title,'Best run');assert.equal(result.text,'Beat my score');assert.equal(result.image.mimeType,'image/png');assert.deepEqual(parseChallengeLink(result.url,policy),challenge);
});
test('language changes during encode cannot mix languages within prepared content',async()=>{
 const i18n=new I18n({locale:'en',fallbackLocale:'en'});i18n.register({schemaVersion:1,locale:'en',messages:{title:'English'}});i18n.register({schemaVersion:1,locale:'zh-CN',messages:{title:'中文'}});
 const f=canvas();let callback;f.source.toBlob=cb=>callback=cb;
 const pending=prepareShareContent({title:{key:'title'},text:{key:'title'},card:{title:{key:'title'}}},{i18n,createCanvas:f.createCanvas});
 await i18n.setLocale('zh-CN');callback(new Blob([Buffer.from(png,'base64')],{type:'image/png'}));const result=await pending;
 assert.equal(result.title,'English');assert.equal(result.text,'English');assert.ok(f.text.some(t=>t.value==='English'));i18n.dispose();
});
