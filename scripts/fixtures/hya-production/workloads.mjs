const point=value=>({unit:'point',value});

/** Frozen G01 geometry with a real, licensed prepared font instead of synthetic glyph rectangles. */
export function productionLayoutWorkload(count,fontDocument) {
  if (![128,1000,10000].includes(count)) throw Error('Expected one frozen G01 workload size.');
  const document=structuredClone(fontDocument),textCount=Math.round(count*.25);
  const style={...document.textStyles[0],fontSize:12,lineHeight:14};
  document.textStyles=[style];document.textBlocks=[];
  const nodes=[{id:'root',kind:'container',style:{display:'flex',direction:'row',wrap:true,width:{unit:'fill'},height:{unit:'fill'},gap:[point(4),point(4)]}}];
  for(let index=0;index<count-1;index++) {
    const text=index<textCount;
    if(text)document.textBlocks.push({id:'label-'+index,runs:[{id:'run',style:style.id,text:'ABA',valuePort:'value-'+index}],width:40,height:24,wrap:'grapheme',overflow:'clip'});
    nodes.push({id:'node-'+index,parent:'root',kind:text?'text':'leaf',...(text?{text:'label-'+index}:{}),style:{width:point(40),height:point(24)},visual:{background:[.1,.2,.3,1]}});
  }
  document.artboards=[{id:'main',width:1280,height:720,root:'root',nodes}];document.instances=[{id:'stage',artboard:'main',fit:'fill',alignment:[0,0]}];
  return document;
}

export function layoutMutationRequest(nodes,percent,frame) {
  if(![128,1000,10000].includes(nodes)||![0,1,10].includes(percent)||!Number.isSafeInteger(frame)||frame<0)throw Error('Invalid frozen workload request.');
  const strings={},changed=Math.ceil(nodes*percent/100),texts=Math.round(nodes*.25);
  for(let index=0;index<changed;index++)strings['value-'+((index+frame)%texts)]=frame%2?'BAB':'ABA';
  return {viewport:[1280,720],dpr:1,time:frame/60,...(changed?{strings}:{})};
}
