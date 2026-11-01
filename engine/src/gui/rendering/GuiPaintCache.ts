import type {GuiRoot} from '../components/GuiRoot';
import type {GuiElement} from '../components/GuiElement';
import type {GuiTheme} from '../GuiTypes';
import type {BitmapFontData} from '../../font/BitmapFontData';
import {GuiPrimitiveTree,type GuiPrimitiveEntry} from '../GuiPrimitiveTree';
import {guiDirtyState} from '../GuiDirtyState';
import {isGuiLayoutHidden} from '../GuiLayoutState';
import {GuiBatch} from './GuiBatch';
import {GuiTextBatch} from './GuiTextBatch';
import {guiFontLayoutState} from './GuiTextGlyphs';

interface Span {shape:number;shapes:number;text:number;texts:number;theme:GuiTheme;}
/** Own-command spans retain order without duplicating a flattened command list per subtree. */
export class GuiPaintCache {
  private readonly spans=new Map<GuiElement,Span>();
  private readonly shapes=new GuiBatch();
  private readonly texts=new GuiTextBatch();
  private readonly theme:GuiTheme;
  private readonly themeKey:string;
  private readonly broad:number|undefined;
  private dense:GuiPrimitiveEntry[]=[];
  private readonly textWork:number;
  private readonly fontState:readonly unknown[]|undefined;
  private constructor(private readonly root:GuiRoot,private readonly tree:GuiPrimitiveTree,private readonly font:BitmapFontData|null){this.theme=root.theme;this.themeKey=JSON.stringify(root.theme);this.broad=guiDirtyState(root.root)?.broadVersion;this.textWork=tree.entries.reduce((n,e)=>n+('text'in e.element&&typeof e.element.text==='string'?e.element.text.length:0),0);this.fontState=font?guiFontLayoutState(font,this.textWork):[];}
  static capture(root:GuiRoot,font:BitmapFontData|null):GuiPaintCache|null {const tree=GuiPrimitiveTree.capture(root.root);if(!tree)return null;const cache=new GuiPaintCache(root,tree,font);return cache.fontState?cache:null;}
  record(element:GuiElement,shape:number,shapes:number,text:number,texts:number,theme:GuiTheme):void {this.spans.set(element,{shape,shapes,text,texts,theme});}
  complete():void {for(const entry of this.dense)this.tree.remember(entry);this.dense=[];}
  patch(font:BitmapFontData|null,batch:GuiBatch,text:GuiTextBatch,paint:(element:GuiElement,theme:GuiTheme,shapes:GuiBatch,texts:GuiTextBatch)=>void):{shapes:boolean;text:boolean}|'dense'|null {
    if(font!==this.font||this.root.theme!==this.theme||JSON.stringify(this.root.theme)!==this.themeKey||guiDirtyState(this.root.root)?.broadVersion!==this.broad||!this.tree.valid())return null;
    // Centered/aligned painters measure text before geometry packing; mutable metrics invalidate both.
    const state=font?guiFontLayoutState(font,this.textWork):[];
    if(!state||!this.fontState||state.length!==this.fontState.length||!state.every((v,i)=>Object.is(v,this.fontState![i])))return null;
    const changed:GuiPrimitiveEntry[]=[];
    for(const entry of this.tree.entries)if(this.tree.changed(entry)){
      // Parent paint can change inherited theme/context. Visibility can expose a previously skipped subtree.
      if(entry.children.length||(!entry.element.visible||isGuiLayoutHidden(entry.element)||!!entry.parent?.hidden)!==entry.hidden)return null;
      changed.push(entry);
    }
    // At high density the original linear collector is cheaper than per-leaf scratch lists.
    if(changed.length>this.tree.entries.length/3){this.dense=changed;return 'dense';}
    const edits=new Map<GuiElement,{shapes:GuiBatch['commands'];texts:GuiTextBatch['commands']}>();
    let shapes=false,texts=false,resize=false;
    for(const entry of changed){
      if(!entry.hidden){
        const span=this.spans.get(entry.element);if(!span)return null;
        const incoming=entry.parent?this.spans.get(entry.parent.element)?.theme:this.root.theme;if(!incoming)return null;
        this.shapes.clear();this.texts.clear();paint(entry.element,incoming,this.shapes,this.texts);
        resize||=this.shapes.commands.length!==span.shapes||this.texts.commands.length!==span.texts;
        shapes||=span.shapes>0||this.shapes.commands.length>0;texts||=span.texts>0||this.texts.commands.length>0;
        edits.set(entry.element,{shapes:this.shapes.commands.slice(),texts:this.texts.commands.slice()});
      }
      this.tree.remember(entry);
    }
    if(resize){
      // Rebase references in order; clean elements keep their original commands and never repaint.
      const nextShapes:GuiBatch['commands']=[],nextTexts:GuiTextBatch['commands']=[];
      for(const entry of this.tree.entries){const span=this.spans.get(entry.element);if(!span)continue;const edit=edits.get(entry.element),shape=nextShapes.length,first=nextTexts.length;
        for(let i=0;i<(edit?.shapes.length??span.shapes);i++)nextShapes.push(edit?edit.shapes[i]!:batch.commands[span.shape+i]!);
        for(let i=0;i<(edit?.texts.length??span.texts);i++)nextTexts.push(edit?edit.texts[i]!:text.commands[span.text+i]!);
        span.shape=shape;span.text=first;if(edit){span.shapes=edit.shapes.length;span.texts=edit.texts.length;}
      }
      batch.commands.length=0;text.commands.length=0;for(const command of nextShapes)batch.commands.push(command);for(const command of nextTexts)text.commands.push(command);
    }else for(const [element,edit]of edits){const span=this.spans.get(element)!;for(let i=0;i<span.shapes;i++)batch.commands[span.shape+i]=edit.shapes[i]!;for(let i=0;i<span.texts;i++)text.commands[span.text+i]=edit.texts[i]!;}
    return {shapes,text:texts};
  }
}
