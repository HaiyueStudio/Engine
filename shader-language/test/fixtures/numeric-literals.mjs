import {defineTypedShaderModule} from '../../dist/index.js';
export const numericLiteralCases=Object.freeze([
 ['zero',0,'0.0'],['negative-zero',-0,'0.0'],['integer',2,'2.0'],['negative-integer',-2,'-2.0'],
 ['fixed-boundary',1e20,'100000000000000000000.0'],['exponent-boundary',1e21,'1e+21'],
 ['negative-exponent-boundary',-1e21,'-1e+21'],['large',1e30,'1e+30'],['negative-large',-1e30,'-1e+30'],
 ['small',1e-7,'1e-7'],['small-normal',1e-30,'1e-30'],['f32-max',Math.fround(3.4028234663852886e38),'3.4028234663852886e+38']
]);
export function literalProgram(id,value){
 return defineTypedShaderModule({id:'numeric.'+id,entries:[
  {id:'vertexMain',name:'vertexMain',stage:'vertex',inputs:[{id:'position',location:0,type:{dataType:'vec4<f32>',semantic:'position',coordinateSpace:'clip'}}],output:{type:{dataType:'vec4<f32>',semantic:'position',coordinateSpace:'clip'},builtin:'position'},build:(_builder,inputs)=>inputs.position},
  {id:'fragmentMain',name:'fragmentMain',stage:'fragment',output:{type:{dataType:'vec4<f32>',semantic:'color',colorSpace:'linear'},location:0},build:builder=>builder.literal({dataType:'vec4<f32>',semantic:'color',colorSpace:'linear'},[value,value,value,1])}
 ]});
}
