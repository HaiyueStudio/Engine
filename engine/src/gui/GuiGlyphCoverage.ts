import type {GuiElement} from './components/GuiElement';
import {GuiPrimitiveTree} from './GuiPrimitiveTree';
import {guiTextClusters} from './rendering/GuiTextGlyphs';

/** Retained text census only; atlas construction and retirement stay with GuiFontOwner. */
export class GuiGlyphCoverage {
  private readonly texts=new Map<GuiElement,string>();
  private readonly counts=new Map<string,number>();
  readonly glyphs=new Set<string>();
  private constructor(private readonly tree:GuiPrimitiveTree){for(const entry of tree.entries){const text=this.text(entry.element);this.texts.set(entry.element,text);this.add(text,1);}}
  static capture(root:GuiElement):GuiGlyphCoverage|null {const tree=GuiPrimitiveTree.capture(root,false);return tree?new GuiGlyphCoverage(tree):null;}
  update():boolean {
    if(!this.tree.valid())return false;
    for(const entry of this.tree.entries){const e=entry.element,text=this.text(e),before=this.texts.get(e)!;if(text!==before){this.add(before,-1);this.add(text,1);this.texts.set(e,text);}}
    return true;
  }
  private text(e:GuiElement):string {return 'text'in e&&typeof e.text==='string'?e.text:'';}
  private add(text:string,delta:number):void {for(const glyph of guiTextClusters(text)){if(/^[\r\n]+$/u.test(glyph))continue;const count=(this.counts.get(glyph)??0)+delta;if(count){this.counts.set(glyph,count);this.glyphs.add(glyph);}else{this.counts.delete(glyph);this.glyphs.delete(glyph);}}}
}
