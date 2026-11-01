import type {GuiElement,GuiElementOptions,GuiFocusManager} from '@haiyue/engine/gui';
export interface GuiCollectionRow<T> {readonly element:GuiElement;bind(item:T,key:string,index:number):()=>void;dispose():void;}
export interface GuiCollectionStats {readonly logicalItems:number;readonly first:number;readonly last:number;readonly rowInstances:number;readonly boundRows:number;}
export interface GuiVirtualListOptions<T> {
  readonly items:readonly T[];readonly keyOf:(item:T)=>string;readonly rowHeight:number;readonly height:number;
  readonly createRow:()=>GuiCollectionRow<T>;readonly overscan?:number;readonly maxItems?:number;
  readonly focus?:GuiFocusManager;readonly onSelection?:(key:string|null)=>void;readonly style?:GuiElementOptions['style'];
}
export interface GuiVirtualTreeNode<T> {readonly key:string;readonly value:T;readonly disabled?:boolean;readonly children?:readonly GuiVirtualTreeNode<T>[];}
export interface GuiVirtualTreeOptions<T> {
  readonly nodes:readonly GuiVirtualTreeNode<T>[];readonly rowHeight:number;readonly height:number;
  readonly createRow:()=>GuiCollectionRow<GuiVirtualTreeNode<T>>;readonly expandedKeys?:readonly string[];
  readonly overscan?:number;readonly maxItems?:number;readonly focus?:GuiFocusManager;
  readonly onSelection?:(key:string|null)=>void;readonly style?:GuiElementOptions['style'];
}
export interface GuiVirtualList<T> {
  readonly element:GuiElement;setItems(items:readonly T[]):void;setScrollOffset(offset:number):void;
  scrollToKey(key:string,align?:'nearest'|'start'|'center'|'end'):void;setSelection(key:string|null):void;
  readonly selectedKey:string|null;readonly stats:GuiCollectionStats;dispose():void;
}
export interface GuiVirtualTree<T> {
  readonly element:GuiElement;setNodes(nodes:readonly GuiVirtualTreeNode<T>[]):void;
  setExpandedKeys(keys:readonly string[]):void;getExpandedKeys():readonly string[];setScrollOffset(offset:number):void;
  scrollToKey(key:string,align?:'nearest'|'start'|'center'|'end'):void;setSelection(key:string|null):void;
  readonly selectedKey:string|null;readonly stats:GuiCollectionStats;dispose():void;
}
