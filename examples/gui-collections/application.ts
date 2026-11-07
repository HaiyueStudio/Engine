import {HaiyueEngine} from '@haiyue/engine';
import {Entity} from '@haiyue/engine/ecs';
import {GuiElement,GuiRoot,GuiLabel,GuiInput,GuiButton,GuiSystem} from '@haiyue/engine/gui';
import {createGuiVirtualList,createGuiVirtualTree} from '@haiyue/extensions/gui-collections';

/** Also compiled against installed tarballs by the collection verifier. */
export async function createCollectionExample(canvas:HTMLCanvasElement,count=1000){
  const coldStart={startedAt:performance.now(),readyAt:0};
  const engine=new HaiyueEngine({canvas,msaaSamples:1,timestampQuery:false,diagnostics:{enabled:true},clearColor:{r:.025,g:.035,b:.055,a:1}});await engine.init();
  const scene=engine.createScene({name:'Bounded GUI collections',camera:{type:'2d',camera2D:{designWidth:960,designHeight:700,viewportMode:'fixed'}},render2D:false,render3D:false,gui:false});
  const root=new GuiRoot({theme:{fontSize:14,radius:4}}),gui=new GuiSystem(engine,{roots:new Set([root])});scene.add(new Entity('Collections').addComponent(root));scene.addSystem(gui);
  root.add(new GuiLabel({x:20,y:12,width:920,height:32,text:'GUI COLLECTIONS — stable keys, bounded original GUI rows',fontSize:21}));
  const status=root.add(new GuiLabel({x:20,y:654,width:920,height:28,text:count+' logical rows. Edit or navigate; wheel / touch scroll.'}));
  const left=root.add(new GuiElement({x:20,y:78,width:440,height:560,pointerFilter:'pass'})),right=root.add(new GuiElement({x:500,y:78,width:440,height:560,pointerFilter:'pass'}));
  const items=Array.from({length:count},(_,i)=>({key:'item-'+i,value:'Item '+i})),edits=new Map<string,string>(),rowCounts={created:0,disposed:0,bind:0,unbind:0};
  const list=createGuiVirtualList({items,keyOf:item=>item.key,rowHeight:28,height:560,focus:gui.focus,onSelection:key=>{status.text='Selected '+key;},createRow(){
    rowCounts.created++;const element=new GuiInput({width:'100%',height:28,value:''});
    return {element,bind(item,key){rowCounts.bind++;element.setValue(edits.get(key)??item.value);const change=(value:string)=>edits.set(key,value);element.onChange=change;return()=>{if(element.onChange===change)element.onChange=null;rowCounts.unbind++;};},dispose(){rowCounts.disposed++;element.removeAllListeners();}};
  }});left.add(list.element);
  const nodes=Array.from({length:10},(_,i)=>({key:'group-'+i,value:'Group '+i,children:Array.from({length:Math.ceil(count/10)},(_,j)=>({key:'node-'+i+'-'+j,value:'Node '+i+' / '+j,disabled:j===2}))}));
  const tree=createGuiVirtualTree({nodes,rowHeight:28,height:560,focus:gui.focus,expandedKeys:['group-0'],createRow(){const element=new GuiButton({width:'100%',height:28,text:''});return {element,bind(node){element.text=node.value;return()=>{};},dispose(){element.removeAllListeners();}};}});right.add(tree.element);
  root.add(new GuiButton({x:20,y:45,width:210,height:28,text:'Go to item 500',onClick:()=>list.scrollToKey('item-'+Math.min(500,count-1))}));
  root.add(new GuiButton({x:250,y:45,width:210,height:28,text:'Insert at beginning',onClick:()=>{if(items[0]?.key==='inserted')return;items.unshift({key:'inserted',value:'Inserted'});list.setItems(items);}}));
  root.add(new GuiButton({x:500,y:45,width:210,height:28,text:'Expand all groups',onClick:()=>tree.setExpandedKeys(nodes.map(node=>node.key))}));
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;try{list.dispose();tree.dispose();}finally{scene.destroy();engine.destroy();}};
  engine.switchScene(scene).run();coldStart.readyAt=performance.now();
  return {engine,scene,gui,root,list,tree,items,nodes,edits,rowCounts,coldStart,dispose};
}
