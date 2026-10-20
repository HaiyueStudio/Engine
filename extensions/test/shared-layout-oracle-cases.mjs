const n=(id,style={},children=[])=>({id,contentVersion:0,style,children});
export const oracleCases=[
  {id:'grid-gap',width:220,height:40,style:{display:'grid',columns:[{fr:1},{fr:1}],rows:[20],columnGap:20},children:[n('a'),n('b')]},
  {id:'grid-track-max',width:300,height:40,style:{display:'grid',columns:[{min:50,max:100},{fr:1}],rows:[20]},children:[n('a'),n('b')]},
  {id:'flex-clamp-redistribution',width:300,height:40,style:{alignItems:'start'},children:[n('a',{basis:0,grow:1,maxWidth:100,height:20}),n('b',{basis:0,grow:1,height:20})]},
  {id:'flex-wrap-line-justify',width:100,height:80,style:{wrap:'wrap',justifyContent:'center',alignItems:'start',alignContent:'start',columnGap:10,rowGap:10},children:[n('a',{width:60,height:20,shrink:0}),n('b',{width:60,height:20,shrink:0})]},
  {id:'grid-fraction-floor',width:150,height:20,style:{display:'grid',columns:[{min:100,max:{fr:1}},{fr:1}],rows:[20]},children:[n('a'),n('b')]},
  {id:'grid-spans',width:130,height:45,style:{display:'grid',columns:[40,40,40],rows:[20,20],columnGap:5,rowGap:5},children:[n('a'),n('b',{placement:{column:0,row:0,columnSpan:2}}),n('c')]},
  {id:'percent-box',width:200,height:100,style:{alignItems:'start'},children:[n('a',{width:100,height:80,padding:{top:{percent:10},left:5},border:{left:2,top:3}},[n('b',{width:10,height:10})])]},
  {id:'shrink-redistribution',width:200,height:40,style:{alignItems:'start'},children:[n('a',{width:200,minWidth:150,height:20}),n('b',{width:100,height:20})]},
  {id:'grow-less-than-one',width:100,height:40,style:{alignItems:'start'},children:[n('a',{basis:0,grow:.5,height:20})]},
  {id:'aspect-ratio',width:200,height:100,style:{alignItems:'start'},children:[n('a',{width:60,aspectRatio:2}),n('b',{width:20,height:30,aspectRatio:4})]},
  {id:'absolute',width:200,height:100,style:{},children:[n('a',{position:'absolute',inset:{left:10,right:20,top:5,bottom:15}}),n('b',{position:'absolute',width:20,height:10,inset:{right:3,bottom:4}})]},
  {id:'absolute-padding',width:200,height:100,style:{padding:{left:10,right:20,top:5,bottom:15},border:{left:3,top:2}},children:[n('a',{position:'absolute',inset:{left:10,right:20,top:5,bottom:15}})]},
  {id:'auto-wrap-height',width:100,height:200,style:{direction:'column',alignItems:'start'},children:[n('panel',{width:100,wrap:'wrap',alignContent:'start',alignItems:'start',columnGap:10,rowGap:10},[n('a',{width:60,height:20,shrink:0}),n('b',{width:60,height:20,shrink:0})]),n('after',{width:10,height:10})]},
  {id:'rtl-nested',width:200,height:100,style:{writingDirection:'rtl',alignItems:'start'},children:[n('panel',{width:100,height:60,alignItems:'start'},[n('a',{width:10,height:10}),n('b',{width:20,height:10})])]},
  {id:'relative-negative',width:200,height:100,style:{alignItems:'start'},children:[n('a',{width:20,height:20,inset:{left:-5,top:3}}),n('b',{width:20,height:20,margin:{left:5,right:-2,top:3}})]},
  {id:'aspect-stretch-basis',width:200,height:100,style:{},children:[n('a',{aspectRatio:2})]},
  {id:'aspect-grid-default',width:200,height:100,style:{display:'grid',columns:[200],rows:[100]},children:[n('a',{aspectRatio:4})]},
  {id:'fractional-tracks',width:200,height:100,style:{display:'grid',columns:[{fr:.25},{fr:.25}],rows:[100]},children:[n('a'),n('b')]},
  {id:'percent-lengths-and-gaps',width:200,height:100,style:{alignItems:'start',columnGap:{percent:5},rowGap:{percent:2}},children:[n('a',{width:{percent:25},height:{percent:20},margin:{top:{percent:2}}}),n('b',{width:{percent:25},height:20})]},
  {id:'rtl-relative-start',width:200,height:100,style:{writingDirection:'rtl',alignItems:'start'},children:[n('a',{width:20,height:20,inset:{left:5,right:10}})]},
  {id:'column-basis-percent',width:200,height:100,style:{direction:'column',alignItems:'start'},children:[n('a',{basis:{percent:25},width:20}),n('b',{basis:{percent:25},width:20})]},
  {id:'cross-max-stretch',width:200,height:100,style:{},children:[n('a',{width:20,maxHeight:30}),n('b',{width:20,minHeight:120})]},
  {id:'grid-alignment',width:200,height:100,style:{display:'grid',columns:[20,30],rows:[10,20],justifyContent:'space-around',alignContent:'space-between'},children:[n('a',{placement:{column:0,row:0,columnSpan:2}}),n('b',{placement:{column:0,row:1}})]},
  {id:'grid-rtl-sized',width:200,height:100,style:{display:'grid',writingDirection:'rtl',columns:[100,100],rows:[100]},children:[n('a',{width:20,height:30}),n('b',{width:50,height:30})]},
  {id:'grid-definite-row-first',width:200,height:100,style:{display:'grid',columns:[100,100],rows:[50,50]},children:[n('a'),n('b',{placement:{row:0}})]},
  {id:'grid-definite-column',width:200,height:100,style:{display:'grid',columns:[100,100],rows:[50,50]},children:[n('a'),n('b',{placement:{column:0}})]},
  {id:'padding-border-floor-flex',width:100,height:50,style:{alignItems:'start'},children:[n('a',{width:10,height:10,padding:{left:20,right:20,top:10,bottom:10},border:{left:2,right:2,top:1,bottom:1}})]},
  {id:'padding-border-floor-grid',width:100,height:50,style:{display:'grid',columns:[100],rows:[50]},children:[n('a',{width:10,height:10,padding:{left:20,right:20,top:10,bottom:10},border:{left:2,right:2,top:1,bottom:1}})]},
  {id:'absolute-margin-stretch',width:100,height:50,style:{},children:[n('a',{position:'absolute',inset:{left:10,right:20,top:5,bottom:15},margin:{left:3,right:7,top:2,bottom:4}})]},
  {id:'absolute-end-margin',width:100,height:50,style:{},children:[n('a',{position:'absolute',width:20,height:10,inset:{right:5,bottom:5},margin:{left:3,right:7,top:2,bottom:4}})]},
];
let seed=0x47a092;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let i=0;i<80;i++){
  const direction=['row','column','row-reverse','column-reverse'][i%4],wrap=['nowrap','wrap','wrap-reverse'][i%3];
  const children=Array.from({length:2+random(6)},(_,j)=>n(`item-${j}`,{width:10+random(70),height:10+random(40),grow:random(3),shrink:random(3),...(j%2?{minWidth:10,maxWidth:70}:{}),margin:{left:random(5),top:random(4),right:random(5),bottom:random(4)},...(j%3===0?{alignSelf:['start','end','center','stretch'][random(4)]}:{})}));
  oracleCases.push({id:`seeded-${i}`,width:120+random(200),height:100+random(120),style:{direction,wrap,writingDirection:i%2?'rtl':'ltr',alignItems:['start','end','center','stretch'][i%4],alignContent:['start','end','center','stretch','space-between','space-around','space-evenly'][i%7],justifyContent:['start','end','center','space-between','space-around','space-evenly'][i%6],rowGap:random(10),columnGap:random(10),padding:{left:random(6),right:random(6),top:random(6),bottom:random(6)}},children});
}

const cssLength=value=>typeof value==='number'?`${value}px`:value==='auto'?'auto':`${value.percent}%`;
const cssTrack=value=>typeof value==='number'||'percent'in value?cssLength(value):'fr'in value?`${value.fr}fr`:`minmax(${cssLength(value.min)},${typeof value.max==='object'&&'fr'in value.max?`${value.max.fr}fr`:cssLength(value.max)})`;
const align=value=>value==='start'?'flex-start':value==='end'?'flex-end':value;
export function cssStyle(style){
  const result={display:'flex',position:'relative',boxSizing:'border-box',minWidth:'0px',minHeight:'0px',flexGrow:'0',flexShrink:'1',flexBasis:'auto',margin:'0',padding:'0',border:'0 solid transparent'};
  for(const key of ['width','height','minWidth','minHeight','maxWidth','maxHeight'])if(style[key]!==undefined)result[key]=cssLength(style[key]);
  for(const key of ['margin','padding','inset','border'])if(style[key])for(const side of ['top','right','bottom','left'])if(style[key][side]!==undefined){const name=key==='inset'?side:key+side[0].toUpperCase()+side.slice(1)+(key==='border'?'Width':'');result[name]=cssLength(style[key][side]);}
  for(const [input,output]of Object.entries({display:'display',position:'position',direction:'flexDirection',writingDirection:'direction',wrap:'flexWrap',grow:'flexGrow',shrink:'flexShrink',aspectRatio:'aspectRatio'}))if(style[input]!==undefined)result[output]=String(style[input]);
  if(style.basis!==undefined)result.flexBasis=cssLength(style.basis);
  for(const key of ['justifyContent','alignItems','alignContent','alignSelf'])if(style[key]!==undefined)result[key]=align(style[key]);
  for(const key of ['rowGap','columnGap'])if(style[key]!==undefined)result[key]=cssLength(style[key]);
  if(style.columns)result.gridTemplateColumns=style.columns.map(cssTrack).join(' ');
  if(style.rows)result.gridTemplateRows=style.rows.map(cssTrack).join(' ');
  if(style.placement){const p=style.placement;result.gridColumn=`${p.column===undefined?'auto':p.column+1} / span ${p.columnSpan??1}`;result.gridRow=`${p.row===undefined?'auto':p.row+1} / span ${p.rowSpan??1}`;}
  return result;
}
