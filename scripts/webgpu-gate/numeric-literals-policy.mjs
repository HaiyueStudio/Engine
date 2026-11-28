export const NUMERIC_LITERAL_IDS=Object.freeze(['zero','negative-zero','integer','negative-integer','fixed-boundary','exponent-boundary','negative-exponent-boundary','large','negative-large','small','small-normal','f32-max']);
export function validateNumericLiteralCompilation(report){
 const check=(condition,message)=>{if(!condition)throw Error('Numeric literal compilation: '+message);};
 check(report?.schemaVersion===1&&report.status==='passed','fixture failed');
 check(Array.isArray(report.cases)&&report.cases.length===NUMERIC_LITERAL_IDS.length,'incomplete positive population');
 const ids=new Set(report.cases.map(row=>row.id));check(ids.size===NUMERIC_LITERAL_IDS.length&&NUMERIC_LITERAL_IDS.every(id=>ids.has(id)),'missing or duplicate case');
 check(report.cases.every(row=>row.wgslErrors===0&&row.wgslValidationErrors===0&&row.glslCompileErrors===0&&row.glslLinkErrors===0),'positive compilation failed');
 check(Array.isArray(report.oldSyntax)&&report.oldSyntax.length===3&&report.oldSyntax.every((row,index)=>row.literal===['1e+21.0','-1e+21.0','1e+30.0'][index]&&row.wgslErrors>0&&row.glslErrors>0),'old malformed syntax was not rejected');
 check(report.validationErrors?.length===0&&report.uncapturedErrors?.length===0,'unexpected GPU errors');check(report.glResources?.shaders===0&&report.glResources?.programs===0,'GL resources remain');
 check(report.sourceVerified===true,'shader payload fingerprint mismatch');return{status:'passed',cases:report.cases.length,negativeControls:report.oldSyntax.length};
}
