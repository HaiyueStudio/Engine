import type {GuiActionEvent} from '@haiyue/engine/gui';
import {VirtualList,invalid} from './List.js';
import type {GuiVirtualTree,GuiVirtualTreeNode,GuiVirtualTreeOptions} from './types.js';
type Model<T>={nodes:readonly GuiVirtualTreeNode<T>[];byKey:Map<string,GuiVirtualTreeNode<T>>;parents:Map<string,string|null>};

class VirtualTree<T> implements GuiVirtualTree<T> {
  readonly element;
  private model:Model<T>;
  private expanded:Set<string>;
  private readonly list:VirtualList<GuiVirtualTreeNode<T>>;
  private dead=false;
  private selectionBatch=false;
  private readonly maxItems:number;
  constructor(private readonly options:GuiVirtualTreeOptions<T>) {
    this.maxItems=options.maxItems??100000;
    if(!Number.isInteger(this.maxItems)||this.maxItems<1||this.maxItems>1000000)throw invalid('Invalid tree item limit.');
    this.model=this.validate(options.nodes);this.expanded=this.validateExpanded(options.expandedKeys??[],this.model);
    this.list=new VirtualList({...options,items:this.flatten(this.model,this.expanded),keyOf:node=>node.key,onSelection:key=>{if(!this.selectionBatch)options.onSelection?.(key);}},node=>!node.disabled,event=>this.action(event));
    this.element=this.list.element;
  }
  private alive():void {if(this.dead)throw invalid('Tree is disposed.');}
  private update(action:()=>void):void {
    const before=this.selectedKey;this.selectionBatch=true;
    try{action();}finally{this.selectionBatch=false;}
    if(before!==this.selectedKey)this.options.onSelection?.(this.selectedKey);
  }
  private validate(nodes:readonly GuiVirtualTreeNode<T>[]):Model<T> {
    if(!Array.isArray(nodes))throw invalid('Tree nodes must be an array.');
    const byKey=new Map<string,GuiVirtualTreeNode<T>>(),parents=new Map<string,string|null>();
    const stack:{nodes:readonly GuiVirtualTreeNode<T>[];index:number;parent:string|null}[]=[{nodes,index:0,parent:null}];
    while(stack.length){const frame=stack[stack.length-1]!;if(frame.index>=frame.nodes.length){stack.pop();continue;}
      const node=frame.nodes[frame.index++];
      if(!node||typeof node.key!=='string'||!node.key||byKey.has(node.key)||node.disabled!==undefined&&typeof node.disabled!=='boolean'||node.children!==undefined&&!Array.isArray(node.children))throw invalid('Tree keys must be unique, acyclic and nonempty.');
      byKey.set(node.key,node);parents.set(node.key,frame.parent);if(byKey.size>this.maxItems)throw invalid('Tree logical item limit exceeded.');
      if(node.children?.length)stack.push({nodes:node.children,index:0,parent:node.key});
    }
    return {nodes:[...nodes],byKey,parents};
  }
  private validateExpanded(keys:readonly string[],model:Model<T>):Set<string> {
    if(!Array.isArray(keys))throw invalid('Expanded keys must be an array.');const result=new Set<string>();
    for(const key of keys){if(!model.byKey.has(key)||result.has(key))throw invalid('Unknown or duplicate expanded tree key.');result.add(key);}return result;
  }
  private flatten(model:Model<T>,expanded:Set<string>):GuiVirtualTreeNode<T>[] {
    const rows:GuiVirtualTreeNode<T>[]=[],stack:{nodes:readonly GuiVirtualTreeNode<T>[];index:number}[]=[{nodes:model.nodes,index:0}];
    while(stack.length){const frame=stack[stack.length-1]!;if(frame.index>=frame.nodes.length){stack.pop();continue;}const node=frame.nodes[frame.index++]!;rows.push(node);if(node.children?.length&&expanded.has(node.key))stack.push({nodes:node.children,index:0});}return rows;
  }
  setNodes(nodes:readonly GuiVirtualTreeNode<T>[]):void {
    this.alive();const model=this.validate(nodes),expanded=new Set([...this.expanded].filter(key=>model.byKey.has(key))),rows=this.flatten(model,expanded);
    this.update(()=>{this.model=model;this.expanded=expanded;this.list.setItems(rows);});
  }
  setExpandedKeys(keys:readonly string[]):void {
    this.alive();const expanded=this.validateExpanded(keys,this.model),rows=this.flatten(this.model,expanded),visible=new Set(rows.map(row=>row.key));
    let selection=this.selectedKey;
    while(selection!==null&&!visible.has(selection))selection=this.model.parents.get(selection)??null;
    this.update(()=>{this.expanded=expanded;this.list.setItems(rows);if(selection!==this.selectedKey)this.list.setSelection(selection);});
  }
  getExpandedKeys():readonly string[] {return Object.freeze([...this.model.byKey.keys()].filter(key=>this.expanded.has(key)));}
  setScrollOffset(offset:number):void {this.alive();this.list.setScrollOffset(offset);}
  scrollToKey(key:string,align:'nearest'|'start'|'center'|'end'='nearest'):void {
    this.alive();if(!this.model.byKey.has(key)||!['nearest','start','center','end'].includes(align))throw invalid('Unknown tree key or alignment.');
    const expanded=new Set(this.expanded);for(let parent=this.model.parents.get(key);parent;parent=this.model.parents.get(parent))expanded.add(parent);
    if(expanded.size!==this.expanded.size)this.setExpandedKeys([...expanded]);this.list.scrollToKey(key,align);
  }
  setSelection(key:string|null):void {this.alive();if(key!==null)this.scrollToKey(key);this.list.setSelection(key);}
  get selectedKey():string|null {return this.list.selectedKey;}
  get stats(){return Object.freeze({...this.list.stats,logicalItems:this.model.byKey.size});}
  private action(event:GuiActionEvent):void {
    const key=this.selectedKey,node=key===null?undefined:this.model.byKey.get(key);
    if(!node||node.disabled)return;
    if(event.action==='right'&&node.children?.length){
      if(!this.expanded.has(node.key))this.setExpandedKeys([...this.expanded,node.key]);
      else {const child=node.children.find(child=>!child.disabled);if(child)this.list.navigate(child.key);}event.consume();
    }else if(event.action==='left'){
      if(this.expanded.has(node.key)){const expanded=new Set(this.expanded);expanded.delete(node.key);this.setExpandedKeys([...expanded]);}
      else {let parent=this.model.parents.get(node.key);while(parent&&this.model.byKey.get(parent)?.disabled)parent=this.model.parents.get(parent);if(parent)this.list.navigate(parent);}event.consume();
    }
  }
  dispose():void {if(this.dead)return;this.dead=true;try{this.list.dispose();}finally{this.expanded.clear();this.model={nodes:[],byKey:new Map(),parents:new Map()};}}
}
export function createGuiVirtualTree<T>(options:GuiVirtualTreeOptions<T>):GuiVirtualTree<T> {return new VirtualTree(options);}
