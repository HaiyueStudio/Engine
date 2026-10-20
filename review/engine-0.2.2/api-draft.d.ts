/** G01 proposed contract only. Not shipped declarations, exports or implemented APIs. */
import type {GuiElement, GuiRoot, GuiRect, GuiImageSource} from '@haiyue/engine/gui';

export namespace LayoutDraft {
  type LayoutLength = number | {readonly percent:number} | 'auto';
  interface LayoutEdges {readonly top?:LayoutLength;readonly right?:LayoutLength;readonly bottom?:LayoutLength;readonly left?:LayoutLength;}
  type LayoutTrack = number | {readonly percent:number} | {readonly fr:number} | {readonly min:number|{readonly percent:number};readonly max:number|{readonly percent:number}|{readonly fr:number}};
  interface LayoutStyle {
    readonly display?:'flex'|'grid'|'none';readonly position?:'relative'|'absolute';
    readonly width?:LayoutLength;readonly height?:LayoutLength;readonly minWidth?:LayoutLength;readonly minHeight?:LayoutLength;readonly maxWidth?:LayoutLength;readonly maxHeight?:LayoutLength;
    readonly aspectRatio?:number;readonly margin?:LayoutEdges;readonly padding?:LayoutEdges;readonly inset?:LayoutEdges;
    readonly direction?:'row'|'row-reverse'|'column'|'column-reverse';readonly writingDirection?:'ltr'|'rtl';readonly wrap?:'nowrap'|'wrap'|'wrap-reverse';
    readonly grow?:number;readonly shrink?:number;readonly basis?:LayoutLength;
    readonly justifyContent?:'start'|'end'|'center'|'space-between'|'space-around'|'space-evenly';
    readonly alignItems?:'start'|'end'|'center'|'stretch';readonly alignSelf?:'auto'|'start'|'end'|'center'|'stretch';
    readonly alignContent?:'start'|'end'|'center'|'stretch'|'space-between'|'space-around'|'space-evenly';
    readonly rowGap?:number|{readonly percent:number};readonly columnGap?:number|{readonly percent:number};
    readonly columns?:readonly LayoutTrack[];readonly rows?:readonly LayoutTrack[];
    readonly placement?:{readonly column?:number;readonly row?:number;readonly columnSpan?:number;readonly rowSpan?:number};
  }
  interface LayoutNode {readonly id:string;readonly contentVersion:number;readonly style:LayoutStyle;readonly children?:readonly LayoutNode[];}
  interface LayoutConstraints {readonly width:{readonly mode:'exact'|'at-most'|'unbounded';readonly value?:number};readonly height:{readonly mode:'exact'|'at-most'|'unbounded';readonly value?:number};}
  type LayoutMeasure = (nodeId:string,constraints:LayoutConstraints)=>{readonly width:number;readonly height:number;readonly minWidth:number;readonly minHeight:number};
  interface LayoutRect {readonly x:number;readonly y:number;readonly width:number;readonly height:number;}
  interface LayoutResult {readonly generation:number;readonly rects:ReadonlyMap<string,LayoutRect>;readonly contentBounds:ReadonlyMap<string,LayoutRect>;readonly measuredNodes:number;readonly solvedNodes:number;}
  interface LayoutLimits {readonly maxNodes:number;readonly maxDepth:number;readonly maxMeasureEntriesPerNode:number;readonly maxConstraintPasses:number;}
  interface LayoutSession {update(root:LayoutNode,constraints:LayoutConstraints,measure:LayoutMeasure,options?:{readonly metricsVersion:number;readonly signal?:AbortSignal}):LayoutResult;invalidate(nodeIds:readonly string[]):void;dispose():void;}
  function createLayoutSession(limits?:Partial<LayoutLimits>):LayoutSession;
  class LayoutError extends Error {readonly code:'invalid-input'|'cycle'|'limit'|'aborted'|'disposed';readonly nodeId?:string;}
}

export namespace GuiLayoutDraft {
  interface GuiLayoutOptions {readonly measure:LayoutDraft.LayoutMeasure;readonly limits?:Partial<LayoutDraft.LayoutLimits>;}
  interface GuiLayoutBinding {setStyle(element:GuiElement,style:LayoutDraft.LayoutStyle):void;invalidate(element:GuiElement):void;dispose():void;}
  function attachGuiLayout(root:GuiRoot,options:GuiLayoutOptions):GuiLayoutBinding;
  type GuiContainerPreset = 'row'|'column'|'flow'|'grid'|'margin'|'center';
  function createGuiContainer(preset:GuiContainerPreset,options?:{readonly id?:string;readonly style?:LayoutDraft.LayoutStyle}):GuiElement;
  interface GuiLayoutMeasurement {readonly contentVersion:number;readonly metricsVersion:number;measure(constraints:LayoutDraft.LayoutConstraints):ReturnType<LayoutDraft.LayoutMeasure>;}
  interface GuiSplitPanelOptions {readonly axis:'horizontal'|'vertical';readonly ratio:number;readonly first:GuiElement;readonly second:GuiElement;readonly onRatioChange?:(ratio:number)=>void;}
  class GuiSplitPanel {constructor(options:GuiSplitPanelOptions);readonly element:GuiElement;setRatio(ratio:number):void;dispose():void;}
  interface GuiTabPage {readonly id:string;readonly title:string;readonly content:GuiElement;}
  interface GuiTabContainerOptions {readonly pages:readonly GuiTabPage[];readonly activeId:string;readonly onActiveChange?:(id:string)=>void;}
  class GuiTabContainer {constructor(options:GuiTabContainerOptions);readonly element:GuiElement;activate(id:string):void;remove(id:string):void;dispose():void;}
}

export namespace GuiDraft {
  interface GuiMeasureConstraint {readonly mode:'exact'|'at-most'|'unbounded';readonly value?:number;}
  interface GuiLayoutDelegate {measure(element:GuiElement,width:GuiMeasureConstraint,height:GuiMeasureConstraint):{readonly width:number;readonly height:number};arrange(root:GuiElement,viewport:GuiRect,commit:(element:GuiElement,rect:GuiRect)=>void):void;dispose():void;}
  type GuiInvalidationReason = 'layout'|'paint'|'input'|'animation'|'resource';
  interface GuiInvalidation {readonly generation:number;readonly reasons:readonly GuiInvalidationReason[];readonly previousBounds?:GuiRect;readonly nextBounds?:GuiRect;readonly activeAnimation:boolean;}
  type GuiPointerFilter = 'stop'|'pass'|'ignore';
  type GuiFocusMode = 'none'|'click'|'all';
  interface GuiFocusOptions {readonly mode:GuiFocusMode;readonly tabIndex?:number;readonly neighbours?:Partial<Record<'left'|'right'|'up'|'down',string>>;}
  interface GuiActionEvent {readonly action:'next'|'previous'|'left'|'right'|'up'|'down'|'confirm'|'cancel';readonly source:'keyboard'|'gamepad';readonly consumed:boolean;consume():void;}
  interface GuiTextEdit {readonly startUtf16:number;readonly endUtf16:number;readonly text:string;readonly generation:number;}
  interface GuiTextComposition {readonly phase:'start'|'update'|'commit'|'cancel';readonly text:string;readonly selectionUtf16:readonly [number,number];readonly generation:number;}
  interface GuiTextInputSession {setSelection(startUtf16:number,endUtf16:number):void;setCaretRect(rect:GuiRect):void;close():void;}
  interface GuiTextInputHost {open(request:{readonly value:string;readonly selectionUtf16:readonly [number,number];readonly inputType:'text'|'email'|'number'|'password';readonly multiline:boolean;readonly generation:number;readonly onEdit:(edit:GuiTextEdit)=>void;readonly onComposition:(event:GuiTextComposition)=>void;readonly onViewportInset:(inset:{top:number;right:number;bottom:number;left:number})=>void}):GuiTextInputSession;}
  interface GuiThemeResource {readonly version:number;resolve(controlType:string,state:GuiThemeState):GuiSkin;subscribe(changed:()=>void):()=>void;}
  type GuiThemeState = Readonly<{hover:boolean;focus:boolean;pressed:boolean;disabled:boolean}>;
  interface GuiSkin {readonly color?:string;readonly backgroundColor?:string;readonly fontFamily?:string;readonly fontSize?:number;readonly icon?:GuiImageSource;readonly contentInsets?:{top:number;right:number;bottom:number;left:number};readonly nineSlice?:GuiNineSliceOptions;}
  interface GuiNineSliceOptions {readonly source:GuiImageSource;readonly sourceWidth:number;readonly sourceHeight:number;readonly cuts:readonly [number,number,number,number];readonly uv?:readonly [number,number,number,number];}
  class GuiNineSlice extends GuiElement {constructor(options:GuiNineSliceOptions);}
  interface GuiDragSource {getData():unknown;createPreview?():GuiElement;onEnd?(accepted:boolean):void;}
  interface GuiDropTarget {canDrop(data:unknown,position:{x:number;y:number}):boolean;drop(data:unknown,position:{x:number;y:number}):void;}
  interface GuiDragSession {readonly pointerId?:number;readonly sourceId:string;cancel():void;}
}

export namespace RegionDraft {
  type RegionUpdateMode = 'demand'|'once'|'continuous'|'disabled';
  interface RenderRegionOptions {readonly id:string;readonly bounds:GuiRect;readonly updateMode:RegionUpdateMode;readonly clearMode:'on-update'|'once'|'never-after-initialization';readonly visible:boolean;}
  interface RenderRegion {readonly id:string;invalidate(reason:string):void;setBounds(rect:GuiRect):void;setMode(mode:RegionUpdateMode):void;setVisible(visible:boolean):void;requestOnce():void;dispose():void;}
}

export namespace GeometryDraft {
  interface NineSliceOptions {readonly width:number;readonly height:number;readonly sourceWidth:number;readonly sourceHeight:number;readonly cuts:readonly [number,number,number,number];readonly uv?:readonly [number,number,number,number];}
  interface NineSlicePatch {readonly rect:Readonly<GuiRect>;readonly uv:readonly [number,number,number,number];}
  function computeNineSlicePatches(options:NineSliceOptions):readonly NineSlicePatch[];
}

/** Proposed compatible methods on existing public classes; no runtime augmentation is performed. */
declare module '@haiyue/engine/gui' {
  interface GuiRoot {
    installLayoutDelegate(delegate:GuiDraft.GuiLayoutDelegate):()=>void;
    onInvalidation(listener:(change:GuiDraft.GuiInvalidation)=>void):()=>void;
    measureElement(element:GuiElement,width:GuiDraft.GuiMeasureConstraint,height:GuiDraft.GuiMeasureConstraint):{readonly width:number;readonly height:number};
  }
}
declare module '@haiyue/engine/core' {
  interface RenderView {
    createRegion(options:RegionDraft.RenderRegionOptions):RegionDraft.RenderRegion;
  }
}
