import {GuiImage,GuiLabel,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiImageSource} from '@haiyue/engine/gui';
import {Composite,textElement,choice,number} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiImageViewOptions,GuiAvatarOptions} from './types.js';

/** Observes a borrowed image; no fetching, decoding or texture ownership is added. */
export class GuiImageView extends Composite {
  readonly image:GuiImage;readonly placeholder:GuiLabel;
  private source:GuiImageSource=null;
  private sourceOff:()=>void=()=>{};
  private state:'empty'|'loading'|'ready'|'error'='empty';
  constructor(private readonly options:GuiImageViewOptions={}){
    super('GuiImageView',{direction:'column',width:160,height:100},options,theme=>({backgroundColor:theme.colors.hover,radius:8,clipRadius:8,parts:{placeholder:{color:theme.colors.textMuted,fontSize:13}}}));
    const fill={position:'absolute' as const,width:'auto' as const,height:'auto' as const,inset:{left:0,right:0,top:0,bottom:0}};
    this.image=this.part('image',new GuiImage({fit:choice(options.fit??'contain',['fill','contain','cover','none'],'image fit')}));setContainerStyle(this.image,fill);
    this.placeholder=this.part('placeholder',textElement(options.placeholder??'Image',fill,{style:{textOverflow:'ellipsis'}}));this.placeholder.textAlign='center';
    this.releases.push(()=>this.sourceOff());try{this.setSource(options.source??null);}catch(error){this.dispose();throw error;}this.finish();
  }
  get status():'empty'|'loading'|'ready'|'error'{return this.state;}
  setSource(source:GuiImageSource):void {
    this.alive();if(source!==null&&(!source||typeof source!=='object'))throw new TypeError('Invalid borrowed image.');
    this.sourceOff();this.sourceOff=()=>{};this.source=source;
    const value=source&&'texture'in source?source.texture:source;
    const update=(error=false)=>{if(this.dead||this.source!==source)return;const loading=!!value&&'complete'in value&&value.complete===false,broken=error||!!value&&'naturalWidth'in value&&'complete'in value&&value.complete===true&&value.naturalWidth===0;
      this.state=broken?'error':loading?'loading':source?'ready':'empty';this.image.setSource(broken?this.options.fallbackSource??null:loading?null:source);this.image.setVisible(this.image.source!==null);this.placeholder.setVisible(this.image.source===null);this.placeholder.setText(broken?this.options.errorText??'Image unavailable':this.options.placeholder??'Image');this.element.markDirty(GuiDirtyFlags.Visual);};
    if(value&&'addEventListener'in value&&'removeEventListener'in value){const loaded=()=>update(),failed=()=>update(true);this.sourceOff=()=>{value.removeEventListener('load',loaded);value.removeEventListener('error',failed);};try{value.addEventListener('load',loaded);value.addEventListener('error',failed);}catch(error){this.sourceOff();this.sourceOff=()=>{};throw error;}}update();
  }
}
export class GuiAvatar extends GuiImageView {
  constructor(options:GuiAvatarOptions={}){
    const size=number(options.size??40,'avatar size',16,512),shape=choice(options.shape??'circle',['circle','square'],'avatar shape'),initials=(options.label??'').trim().split(/\s+/u).filter(Boolean).slice(0,2).map(word=>Array.from(word)[0]??'').join('').toUpperCase()||'?';
    super({...options,width:size,height:size,fit:options.fit??'cover',placeholder:initials,themeControlType:'GuiAvatar'});
    this.element.setDefaultSkin(theme=>({backgroundColor:theme.colors.primary,radius:shape==='circle'?size/2:8,clipRadius:shape==='circle'?size/2:8,parts:{placeholder:{color:theme.colors.onPrimary??'#fff',fontSize:Math.max(12,size*.36),fontWeight:600}}}));
  }
}
