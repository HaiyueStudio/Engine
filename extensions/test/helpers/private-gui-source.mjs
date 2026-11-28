import {registerHooks} from 'node:module';
import {importEngineSource} from '../../../engine/test/helpers/internal-source.mjs';
import {importAnimationSource} from './private-animation-source.mjs';
// GUI activity and control classes must share the same module identity; do not add a public test export.
const gui=new URL('../../../engine/src/gui.ts',import.meta.url).href;
registerHooks({resolve(id,context,next){return id==='@haiyue/engine/gui'?{url:gui,shortCircuit:true}:next(id,context);}});
export const guiApi=()=>importEngineSource('gui.ts');
export const guiActivity=()=>importEngineSource('gui/GuiActivity.ts');
export const guiExtension=importAnimationSource;
