import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

test('native pointer button sentinel adapts to the unchanged logical input contract', async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const parent=resolve(root,'artifacts/engine-0.2.2/g13');mkdirSync(parent,{recursive:true});
  const output=mkdtempSync(resolve(parent,'pointer-test-'));
  try {
    const config=ts.readConfigFile(resolve(root,'extensions/tsconfig.json'),ts.sys.readFile);
    assert.equal(config.error,undefined);
    const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,resolve(root,'extensions'));
    const options={...parsed.options,noEmit:false,outDir:output,declaration:false,declarationMap:false,sourceMap:false};
    const files=['CompositionGuiBridge','CompositionInputOwner'].map(name=>resolve(root,'extensions/src/animation/production/'+name+'.ts'));
    const program=ts.createProgram(files,options),errors=ts.getPreEmitDiagnostics(program);
    assert.deepEqual(errors.map(e=>ts.flattenDiagnosticMessageText(e.messageText,'\n')),[]);
    assert.equal(program.emit().emitSkipped,false);
    const {ProductionCompositionGuiBridge:Bridge}=await import(pathToFileURL(resolve(output,'animation/production/CompositionGuiBridge.js')));
    const {ProductionCompositionInputOwner:Input}=await import(pathToFileURL(resolve(output,'animation/production/CompositionInputOwner.js')));
    const received=[],target={part:'layout',id:'field'};
    const owner={enqueueGui(event,actualTarget){
      Input.prototype.validateGui.call({}, {...event,consumed:false},actualTarget);
      received.push({event,target:actualTarget});
    }};
    const bridge={closed:false,synchronizing:false,owner};
    for(const kind of ['pointer-move','pointer-cancel']) {
      const event={kind,pointerId:1,point:[20,30],button:-1,pointerType:'mouse'};
      Bridge.prototype.enqueue.call(bridge,event,target);
      assert.deepEqual(received.at(-1),{event:{kind,pointerId:1,point:[20,30],pointerType:'mouse'},target});
      assert.equal(event.button,-1,'Borrowed native event must remain unchanged');
    }
    for(const kind of ['pointer-down','pointer-up','pointer-move']) {
      const event={kind,pointerId:1,point:[20,30],button:2,pointerType:'mouse'};
      Bridge.prototype.enqueue.call(bridge,event,target);
      assert.equal(received.at(-1).event.button,2);
    }
    for(const [kind,button]of [['pointer-down',-1],['pointer-up',-1],['pointer-move',-2],['pointer-move',NaN]]) {
      assert.throws(()=>Bridge.prototype.enqueue.call(bridge,{kind,pointerId:1,point:[20,30],button,pointerType:'mouse'},target),/invalid logical pointer/);
    }
    assert.equal(received.length,5,'Invalid input must not reach the logical queue');
    for(const guard of ['closed','synchronizing']) {
      Bridge.prototype.enqueue.call({...bridge,[guard]:true},{kind:'pointer-move',button:-1},target);
      assert.equal(received.length,5,'Inactive presentation must not enqueue');
    }
  } finally {
    const inside=relative(parent,output);
    assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));
    rmSync(output,{recursive:true,force:true});
  }
});
