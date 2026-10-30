// Source CPU profile only. Never a reduced formal qualification population.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {productionFontFixture} from '../../extensions/test/text-production-font-fixture.mjs';
import {loadResponsiveLayoutModules} from '../../extensions/test/responsive-layout-fixture.mjs';
import {productionLayoutWorkload,layoutMutationRequest} from '../fixtures/hya-production/workloads.mjs';
import {qualificationOutput} from './qualification-output.mjs';
import {snapshotSourceInputs} from './source-snapshot.mjs';
const root=process.cwd(),at=process.argv.indexOf('--output'),output=qualificationOutput(root,process.argv[at+1]).directory;mkdirSync(output,{recursive:true});
const modules=await loadResponsiveLayoutModules(),font=productionFontFixture(),document=modules.spec.parseResponsiveLayoutDocument(productionLayoutWorkload(1000,font.document));
const assets=new modules.runtime.LayoutAssetOwner(document,{policy:{mode:'deny'}}),text=new modules.textProduction.ProductionTextOwner(document,modules.outlineProduction.createProductionOutlineFontPort(assets));await text.prepare();
const layout=new modules.layoutProduction.ProductionLayoutOwner(document,text),rows=[];
try{for(let frame=0;frame<42;frame++){const started=performance.now();layout.evaluate(layoutMutationRequest(1000,10,frame));rows.push({frame,warmup:frame<12,ms:performance.now()-started,shapes:layout.stats.shapes});}}
finally{layout.dispose();text.dispose();assets.dispose();}
writeFileSync(resolve(output,'result.json'),JSON.stringify({scope:'One pressure cohort CPU diagnosis only; not G12 qualification',rows,sourceInputs:snapshotSourceInputs(root,['extensions/src/animation','extensions/src/layout'])},null,2)+'\n');
