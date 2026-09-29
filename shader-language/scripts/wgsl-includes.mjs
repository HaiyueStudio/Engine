import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const moduleId=/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/;

/** Private authoring frontend. It never runs in Engine or accepts Graph JSON imports. */
export async function expandWgslIncludes({entry,root,modules}) {
  const sourceRoot=await realpath(root),registry=new Map(),dependencies=new Map(),visited=new Set(),active=[];
  const spans=[],parts=[];let offset=0;
  for(const {id,path} of modules){
    if(!moduleId.test(id)||typeof path!=='string'||registry.has(id))throw Error(`Invalid or duplicate WGSL module: ${id}`);
    registry.set(id,path);
  }
  async function file(path){
    const absolute=await realpath(resolve(sourceRoot,path));
    const local=relative(sourceRoot,absolute);
    if(local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local))throw Error(`WGSL include escapes source root: ${path}`);
    const source=await readFile(absolute,'utf8'),name=local.split(sep).join('/');
    dependencies.set(name,{path:name,sha256:hash(source)});
    return {source,name};
  }
  function append(text,sourceName,sourceLine){
    if(!text)return;
    spans.push({generatedOffset:offset,length:text.length,sourceName,sourceLine});
    parts.push(text);offset+=text.length;
  }
  async function visit(path,id){
    if(active.includes(id))throw Error(`WGSL include cycle: ${[...active,id].join(' -> ')}`);
    if(visited.has(id))return;
    active.push(id);
    const {source,name}=await file(path),visible=maskComments(source);
    const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[],masked=visible.match(/[^\n]*\n|[^\n]+$/g)??[];
    let depth=0;
    for(let i=0;i<lines.length;i++){
      const line=lines[i],text=masked[i];
      if(/^\s*#/.test(text)){
        const match=/^[ \t]*#include[ \t]+<([a-z0-9/-]+)>[ \t]*(?:\r?\n)?$/.exec(text);
        if(!match||depth!==0)throw Error(`${name}:${i+1}: expected a module-level #include <registered/id>`);
        const dependency=match[1];
        if(!registry.has(dependency))throw Error(`${name}:${i+1}: missing WGSL module ${dependency}`);
        try{await visit(registry.get(dependency),dependency);}catch(error){throw Error(`${name}:${i+1}: ${error.message}`,{cause:error});}
        // Keep the directive's newline; module bytes and authored separators remain lossless.
        append(line.endsWith('\r\n')?'\r\n':line.endsWith('\n')?'\n':'',name,i+1);
      }else{
        if(text.includes('#'))throw Error(`${name}:${i+1}: include directives must occupy a module-level line`);
        append(line,name,i+1);
        for(const ch of text){if(ch==='{')depth++;else if(ch==='}')depth--;}
      }
    }
    active.pop();visited.add(id);
  }
  await visit(entry,'<entry>');
  const code=parts.join(''),inputs=[...dependencies.values()].sort((a,b)=>a.path.localeCompare(b.path));
  const result={code,spans,dependencies:inputs,sha256:hash(JSON.stringify({version:1,modules,inputs,code}))};
  validateDeclarations(result);
  return result;
}

/** Preserve offsets/newlines while masking line comments and nested WGSL block comments. */
function maskComments(source){
  let output='',depth=0,line=false;
  for(let i=0;i<source.length;i++){
    const a=source[i],b=source[i+1];
    if(a==='\n'){line=false;output+='\n';continue;}
    if(!line&&a==='/'&&b==='*'){depth++;output+='  ';i++;continue;}
    if(depth&&a==='*'&&b==='/'){depth--;output+='  ';i++;continue;}
    if(!depth&&!line&&a==='/'&&b==='/'){line=true;output+='  ';i++;continue;}
    output+=(depth||line)&&a!=='\r'?' ':a;
  }
  if(depth)throw Error('Unclosed WGSL block comment');
  return output;
}

export function mapWgslIncludePosition(result,line,column=1){
  if(!Number.isInteger(line)||line<1||!Number.isInteger(column)||column<1)return null;
  const lines=result.code.split('\n');if(line>lines.length||column>lines[line-1].length+1)return null;
  let offset=column-1;for(let i=0;i<line-1;i++)offset+=lines[i].length+1;
  const span=result.spans.find(s=>offset>=s.generatedOffset&&offset<s.generatedOffset+s.length);
  if(!span)return null;
  return {sourceName:span.sourceName,line:span.sourceLine,column:offset-span.generatedOffset+1};
}

function validateDeclarations(result){
  const source=maskComments(result.code),symbols=new Set(),bindings=new Set();let depth=0;
  for(const match of source.matchAll(/[{}]|\b(fn|struct|alias|const|override|var)(?:\s*<[^>]+>)?\s+([A-Za-z_]\w*)/g)){
    if(match[0]==='{'){depth++;continue;}if(match[0]==='}'){depth--;continue;}
    if(depth!==0)continue;
    if(symbols.has(match[2]))fail(`duplicate WGSL symbol ${match[2]}`,match.index);
    symbols.add(match[2]);
  }
  for(const match of source.matchAll(/((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\b/g)){
    const group=/@group\s*\(\s*(\d+)\s*\)/.exec(match[1]),binding=/@binding\s*\(\s*(\d+)\s*\)/.exec(match[1]);
    if(!group||!binding)continue;
    const key=`${Number(group[1])}:${Number(binding[1])}`;
    if(bindings.has(key))fail(`duplicate WGSL binding ${key}`,match.index);
    bindings.add(key);
  }
  function fail(message,offset){
    const before=source.slice(0,offset),line=before.split('\n').length,column=offset-before.lastIndexOf('\n');
    const origin=mapWgslIncludePosition(result,line,column);
    throw Error(`${origin?.sourceName}:${origin?.line}: ${message}`);
  }
}

/** Registered only in the Shader Language build; Engine's raw WGSL loader is unchanged. */
export function wgslBuildIncludes({root,registryPath}){
  const records=new Map();
  return {name:'shader-language-build-includes',
    buildStart(){records.clear();this.addWatchFile(registryPath);},
    async load(id){
      if(!id.endsWith('.wgslinc'))return null;
      const registry=JSON.parse(await readFile(registryPath,'utf8'));
      if(registry.schemaVersion!==1||!Array.isArray(registry.modules))throw Error('Invalid WGSL module registry schema');
      const {modules}=registry;
      const expanded=await expandWgslIncludes({entry:id,root,modules});
      for(const dependency of expanded.dependencies)this.addWatchFile(resolve(root,dependency.path));
      const entry=relative(root,id).split(sep).join('/');
      records.set(entry,{entry,...expanded});
      return {code:`export default ${JSON.stringify(expanded.code)};`,map:{mappings:''}};
    },
    generateBundle(){
      // Build-only provenance is an asset, never imported by Engine or runtime bundles.
      this.emitFile({type:'asset',fileName:'wgsl-includes.provenance.json',source:JSON.stringify({schemaVersion:1,entries:[...records.values()].sort((a,b)=>a.entry.localeCompare(b.entry))},null,2)+'\n'});
    },
  };
}
