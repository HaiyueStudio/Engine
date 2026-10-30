import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

test('published JSON schemas parse, have unique IDs and resolve local JSON pointers',()=>{
 const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../schema');
 const files=readdirSync(directory).filter(name=>name.endsWith('.schema.json')).sort();
 assert.ok(files.includes('hya-composition.schema.json'));
 assert.ok(files.includes('responsive-layout-2d.schema.json'));
 const ids=new Set();
 for(const file of files){
  const schema=JSON.parse(readFileSync(resolve(directory,file),'utf8'));
  assert.equal(typeof schema.$id,'string',file+': missing schema ID');
  assert.ok(!ids.has(schema.$id),file+': duplicate schema ID');ids.add(schema.$id);
  const visit=(value,path)=>{
   if(!value||typeof value!=='object')return;
   if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')){
    let target=schema;
    for(const token of value.$ref.slice(2).split('/').map(s=>decodeURIComponent(s).replaceAll('~1','/').replaceAll('~0','~'))){
     assert.ok(target&&typeof target==='object'&&Object.hasOwn(target,token),file+path+': unresolved '+value.$ref);target=target[token];
    }
   }
   for(const[key,child]of Object.entries(value))visit(child,path+'/'+key);
  };
  visit(schema,'');
 }
});
