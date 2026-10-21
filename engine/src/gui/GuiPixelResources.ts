import {GuiImage} from './components/GuiImage';
import type {GuiRoot} from './components/GuiRoot';
import type {GuiElement} from './components/GuiElement';
/** Borrowed image readiness/version changes invalidate pixels even without a layout attachment. */
export class GuiPixelResources {
  private readonly watched=new Map<GuiImage,{source:GuiImage['source'];key:string;release:()=>void}>();
  private roots:readonly GuiRoot[]=[];
  constructor(private readonly changed:(image:GuiImage)=>void){}
  sync(roots:readonly GuiRoot[]):void {
    const rebuild=roots.length!==this.roots.length||roots.some((r,i)=>r!==this.roots[i]||r.dirty);
    this.roots=[...roots];
    if(rebuild){
      const live=new Set<GuiImage>(),visit=(element:GuiElement):void=>{if(element instanceof GuiImage)live.add(element);for(const child of element.children)visit(child)};
      for(const root of roots)visit(root.root);
      for(const [image,entry]of this.watched)if(!live.has(image)||entry.source!==image.source){entry.release();this.watched.delete(image)}
      for(const image of live)if(!this.watched.has(image)){
        const source=image.source,loaded=()=>{if(image.source===source&&this.belongs(image)){this.changed(image);const e=this.watched.get(image);if(e)e.key=this.key(image)}};
        if(source&&'addEventListener'in source&&'removeEventListener'in source){source.addEventListener('load',loaded);source.addEventListener('error',loaded)}
        this.watched.set(image,{source,key:this.key(image),release:()=>{if(source&&'removeEventListener'in source){source.removeEventListener('load',loaded);source.removeEventListener('error',loaded)}}});
      }
    }
    for(const [image,entry]of this.watched){const next=this.key(image);if(next!==entry.key){entry.key=next;this.changed(image)}}
  }
  private belongs(image:GuiImage):boolean {let node:GuiElement|null=image;while(node?.parent)node=node.parent;return this.roots.some(r=>r.root===node)}
  private key(image:GuiImage):string {
    const s=image.source;if(!s)return 'none';const texture='texture'in s?s.texture:s;
    return JSON.stringify(['version'in s?s.version:0,'naturalWidth'in texture?texture.naturalWidth:'width'in texture?texture.width:0,'naturalHeight'in texture?texture.naturalHeight:'height'in texture?texture.height:0,'currentSrc'in s?s.currentSrc:undefined]);
  }
  release():void {for(const e of this.watched.values())e.release();this.watched.clear();this.roots=[];}
}
