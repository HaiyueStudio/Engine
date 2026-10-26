import {resolve,relative,isAbsolute,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

/** G12 candidates never overwrite the corpus cache, checked-in latest, or an earlier run. */
export function qualificationOutput(root,directory) {
  if (typeof directory!=='string'||!directory.trim()) throw Error('A named G12 output directory is required.');
  const base=resolve(root,'artifacts/engine-0.2.2/g12'),output=resolve(root,directory),inside=relative(base,output);
  if (!inside||inside==='..'||inside.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(inside)) throw Error('G12 output must be a child of artifacts/engine-0.2.2/g12.');
  return {directory:output,generated:join(output,'generated'),browserInput:join(output,'browser-input.json')};
}
/** Formal candidate entry points never overwrite an earlier attempt, including failures. */
export function createQualificationOutput(root,directory){
  const output=qualificationOutput(root,directory);mkdirSync(dirname(output.directory),{recursive:true});mkdirSync(output.directory);return output;
}
