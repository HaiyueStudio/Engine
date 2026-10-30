const point = value => ({unit:'point',value});
const fraction = value => ({unit:'fraction',value});
const leaf = (id, style) => ({id,parent:'root',kind:'leaf',style:{height:point(20),...style}});
export const cases = [
  {id:'grid-gap', width:220, height:40,
    root:{display:'grid',gridColumns:[{min:fraction(1)},{min:fraction(1)}],gridRows:[{min:point(20)}],gap:[point(20),point(0)]},
    children:[leaf('a',{}),leaf('b',{})], css:{display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)',gridTemplateRows:'20px',columnGap:'20px'}, childCss:[{},{}],
    expected:[{x:0,y:0,width:100,height:20},{x:120,y:0,width:100,height:20}], classification:'declared-gap-ignored'},
  {id:'grid-track-max',width:300,height:40,
    root:{display:'grid',gridColumns:[{min:point(50),max:point(100)},{min:fraction(1)}],gridRows:[{min:point(20)}]},
    children:[leaf('a',{}),leaf('b',{})],css:{display:'grid',gridTemplateColumns:'minmax(50px,100px) minmax(0,1fr)',gridTemplateRows:'20px'},childCss:[{},{}],
    expected:[{x:0,y:0,width:100,height:20},{x:100,y:0,width:200,height:20}],classification:'track-max-contract-ambiguity'},
  {id:'flex-clamp-redistribution',width:300,height:40,
    root:{display:'flex',direction:'row',align:'start'},children:[leaf('a',{width:{unit:'fill'},maxWidth:point(100)}),leaf('b',{width:{unit:'fill'}})],
    css:{display:'flex',alignItems:'flex-start'},childCss:[{flex:'1 1 0px',maxWidth:'100px',height:'20px'},{flex:'1 1 0px',height:'20px'}],
    expected:[{x:0,y:0,width:100,height:20},{x:100,y:0,width:200,height:20}],classification:'fill-contract-vs-flex-redistribution'},
  {id:'flex-wrap-line-justify',width:100,height:80,
    root:{display:'flex',direction:'row',wrap:true,justify:'center',align:'start',gap:[point(10),point(10)]},children:[leaf('a',{width:point(60)}),leaf('b',{width:point(60)})],
    css:{display:'flex',flexWrap:'wrap',justifyContent:'center',alignItems:'flex-start',alignContent:'flex-start',gap:'10px'},childCss:[{flex:'0 0 60px',height:'20px'},{flex:'0 0 60px',height:'20px'}],
    expected:[{x:20,y:0,width:60,height:20},{x:20,y:30,width:60,height:20}],classification:'line-construction-before-justification'}
];

export function documentFor(base, c) {
  return {...base,artboards:[{id:'main',width:c.width,height:c.height,root:'root',nodes:[{id:'root',kind:'container',style:{width:{unit:'fill'},height:{unit:'fill'},...c.root}},...c.children]}],instances:[{id:'stage',artboard:'main',fit:'fill',alignment:[0,0]}]};
}
