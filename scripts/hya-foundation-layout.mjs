import {existsSync,readFileSync,lstatSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
/** G10 recorded this empty source directory alongside its real cubism.ts module.
 * Git omits empty directories; reproduce that frozen filesystem fixture explicitly.
 * Never synthesize a missing implementation or change the capability census.
 */
export function ensureFrozenHyaFoundationLayout(root){
  const file=resolve(root,'config/hya-022-contract.json');
  if(!existsSync(file))return {required:false};
  const contract=JSON.parse(readFileSync(file));
  if(JSON.stringify(contract.foundationModules?.cubism)!=='["licensed-clip-baked"]'||JSON.stringify(contract.foundationModules?.['cubism.ts'])!=='["licensed-clip-baked"]')throw Error('Frozen Cubism census changed');
  const implementation=resolve(root,'animation-spec/src/cubism.ts'),directory=resolve(root,'animation-spec/src/cubism');
  if(!existsSync(implementation)||!lstatSync(implementation).isFile()||!readFileSync(implementation).length)throw Error('Actual Cubism format module is missing');
  if(existsSync(directory)){if(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())throw Error('Cubism source fixture must be a regular directory');}
  else mkdirSync(directory);
  return {required:true,directory};
}
