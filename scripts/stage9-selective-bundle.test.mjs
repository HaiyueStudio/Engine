import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadShaderCostBudget,validateProductionBundleCost} from '../shader-language/scripts/shader-cost-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const current=loadShaderCostBudget(root);
const historical=JSON.parse(readFileSync(new URL('../shader-language/stage9-contract.json',import.meta.url)));
test('selective GUI exports have bounded current gzip capacity; historical observations stay immutable',()=>{
 assert.equal(historical.bundle.engine2dUiArtifactGzipBytes,4742);
 assert.equal(historical.bundle.engine2dUiArtifactRawBytes,53787);
 assert.equal(historical.bundle.engineArtifactGzipBudgetBytes,12000);
 assert.equal(current.productionBundles.engine2dUiArtifactGzipBytes,4800);
 for(const value of [0,4742,4746,4800])assert.equal(validateProductionBundleCost('engine2dUiArtifactGzipBytes',value,current),null);
 for(const value of [4801,-1,NaN,Infinity,4.5,undefined])assert.ok(validateProductionBundleCost('engine2dUiArtifactGzipBytes',value,current));
 assert.ok(validateProductionBundleCost('engine2dUiArtifactGzipBytes',4746,{productionBundles:historical.bundle}));
 assert.ok(validateProductionBundleCost('engine2dUiArtifactGzipBytes',4746,{productionBundles:{}}));
});
test('bundle gate routes only current gzip admission while retaining raw and total checks',()=>{
 const checker=readFileSync(new URL('../shader-language/scripts/check-stage9-bundle.mjs',import.meta.url),'utf8');
 assert.match(checker,/\['engine2dUiArtifactGzipBytes', 'simple3dArtifactGzipBytes', 'componentsEvidenceArtifactGzipBytes'\]/);
 assert.match(checker,/productionBundles: contract.bundle/);
 assert.match(checker,/engineArtifactGzipBytes > contract.bundle.engineArtifactGzipBudgetBytes/);
});
