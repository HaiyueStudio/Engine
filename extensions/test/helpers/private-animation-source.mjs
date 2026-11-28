import {registerHooks} from 'node:module';
import {existsSync,readFileSync,statSync} from 'node:fs';
import ts from 'typescript';

const root = new URL('../../src/',import.meta.url).href;
// Private runtime assertions must not add public exports solely for testing.
registerHooks({
  resolve(specifier,context,next) {
    if(specifier.startsWith('.') && context.parentURL?.startsWith(root)) {
      const base = new URL(specifier,context.parentURL);
      for(const url of [base,new URL(base.href.replace(/\.js$/,'.ts')),new URL(base.href+'.ts'),new URL(base.href+'/index.ts')])
        if(existsSync(url)&&statSync(url).isFile()) return {url:url.href,shortCircuit:true};
    }
    return next(specifier,context);
  },
  load(url,context,next) {
    if(url.startsWith(root)&&url.endsWith('.ts'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};
    if(url.startsWith(root)&&url.endsWith('.wgsl'))return {format:'module',source:'export default '+JSON.stringify(readFileSync(new URL(url),'utf8'))+';',shortCircuit:true};
    return next(url,context);
  },
});

export const importAnimationSource = path => import(new URL(path,root).href);
