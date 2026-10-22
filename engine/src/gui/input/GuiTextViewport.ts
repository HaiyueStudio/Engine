import type {GuiInput} from '../components/GuiInput';
import {GuiScrollView} from '../components/GuiScrollView';
import type {GuiRect} from '../GuiTypes';
import {setGuiScrollOcclusion} from './GuiScrollViewportState';

/** Reveal a caret through existing scroll containers without rewriting layout or stored options. */
export class GuiTextViewport {
  private readonly affected=new Set<GuiScrollView>();
  clear():void {for(const view of this.affected)setGuiScrollOcclusion(view,0);this.affected.clear();}
  reveal(input:GuiInput,caret:GuiRect,viewport:GuiRect):void {
    const parents:GuiScrollView[]=[];
    for(let parent=input.parent;parent;parent=parent.parent)if(parent instanceof GuiScrollView)parents.push(parent);
    for(const old of this.affected)if(!parents.includes(old)){setGuiScrollOcclusion(old,0);this.affected.delete(old);}
    let top=viewport.y,bottom=viewport.y+viewport.height;
    // Outer clips constrain every inner scroll container as well.
    for(const parent of [...parents].reverse()){top=Math.max(top,parent.rect.y);bottom=Math.min(bottom,parent.rect.y+parent.rect.height);}
    let caretY=caret.y;
    for(const parent of parents){
      setGuiScrollOcclusion(parent,Math.max(0,parent.rect.y+parent.rect.height-bottom));this.affected.add(parent);
      const previous=parent.scrollY;
      const delta=caretY<top?caretY-top:caretY+caret.height>bottom?caretY+caret.height-bottom:0;
      if(delta)parent.scrollBy(delta);
      caretY-=parent.scrollY-previous;
    }
  }
}
