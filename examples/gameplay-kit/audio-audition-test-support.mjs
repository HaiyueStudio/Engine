import assert from 'node:assert/strict';
import ts from 'typescript';

// Observe the actual example controls without starting their GPU/native hosts.
// This records configuration only; audible output is verified separately.
export async function observeAudition(source, native=false) {
 const file=ts.createSourceFile('application.ts',source,ts.ScriptTarget.Latest,true),nodes=[];
 const visit=node=>{nodes.push(node);ts.forEachChild(node,visit);};visit(file);
 const variable=name=>{const matches=nodes.filter(n=>ts.isVariableDeclaration(n)&&n.name.getText(file)===name);assert.equal(matches.length,1,name);return matches[0].initializer.getText(file);};
 let setup;
 if(native){
  const loops=nodes.filter(n=>ts.isForOfStatement(n)&&n.getText(file).includes("'Hear left'")&&n.getText(file).includes('audioPosition='));assert.equal(loops.length,1);
  const binds=nodes.filter(n=>ts.isCallExpression(n)&&n.expression.getText(file)==='gameAudio.bindEmitter2D'&&n.arguments[0].getText(file).includes("owner:'native-probe'"));assert.equal(binds.length,1);
  setup='let audioPosition=[0,0],audioEvent=0;const gameAudio=audio,unlockAudio=async()=>true,mixer={stats:{}},record=()=>{};const sounds={add:button=>buttons.push(button)},audioButton=(text,click)=>({text,click});binding='+binds[0].arguments[0].getText(file)+';'+loops[0].getText(file);
 }else{
  setup='let auditionPosition=[0,0],stopAudition=()=>{},serial=0,tick=0;const unlock=async()=>{},current=null,run=action=>action(),button=(text,click)=>({text,click}),stack=(...values)=>values;const audition='+variable('audition')+';const audioControls='+variable('audioControls')+';buttons.push(...audioControls());';
 }
 const javascript=ts.transpileModule(setup,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const observe=Function(`let binding,buttons=[],plays=0,unbinds=0;
 const audio={setListener(){},bindEmitter2D(options){binding=options;return()=>{unbinds++;};},play(){plays++;},update(){}};
 ${javascript}
 return{async click(label){const button=buttons.find(b=>b.text===label);if(!button)throw Error('Missing audition control '+label);await button.click();return {label,position:[...binding.position()],maxDistance:binding.maxDistance,volume:binding.volume??1,panStrength:binding.panStrength??1,plays,unbinds};}};`)();
 const values=[];for(const label of ['Hear left','Hear center','Hear right',native?'Distance 100: silent':'Far / silent'])values.push(await observe.click(label));return values;
}
