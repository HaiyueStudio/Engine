import {fileURLToPath} from 'node:url';
import typescript from '@rollup/plugin-typescript';
import {haiyuePlugins,libraryOutput} from '../config/rollup.shared.js';
const output=fileURLToPath(new URL('../artifacts/engine-0.2.2/g04/target-bundle',import.meta.url));
export default {
  input:{'region-target':'src/renderer/regions/RegionColorTarget.ts','region-budget':'src/renderer/regions/RegionCacheBudget.ts','region-copy':'src/postprocess/SceneOutputPass.ts','region-submission':'src/postprocess/PostProcessSubmission.ts','region-working':'src/renderer/regions/RegionFrameTargets.ts','region-accounting':'src/renderer/regions/RegionAttachmentAccounting.ts'},
  output:libraryOutput(output),
  plugins:haiyuePlugins({typescriptPlugin:typescript({tsconfig:'./tsconfig.json',outDir:output,declarationDir:output})}),
};
