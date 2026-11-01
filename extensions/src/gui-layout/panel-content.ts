import type{GuiStyle,GuiImageSource,GuiIconPosition}from'@haiyue/engine/gui';
import{LayoutError}from'../layout.js';
export function iconPosition(value:GuiIconPosition|undefined):void{if(value!==undefined&&value!=='left'&&value!=='right')throw new LayoutError('invalid-input','Icon position must be left or right.');}
export function iconSource(value:GuiImageSource|undefined):void{
 if(value===undefined||value===null)return;
 if(typeof value!=='object'||Array.isArray(value))throw new LayoutError('invalid-input','A GUI image source must be borrowed.');
 const source='texture'in value?value.texture:value;
 if(!source||typeof source!=='object')throw new LayoutError('invalid-input','Invalid GUI texture source.');
 const width='naturalWidth'in source?source.naturalWidth:'width'in source?source.width:undefined,height='naturalHeight'in source?source.naturalHeight:'height'in source?source.height:undefined;
 if(!Number.isFinite(width)||!Number.isFinite(height)||width!<0||height!<0)throw new LayoutError('invalid-input','GUI image source dimensions must be finite and nonnegative.');
}
/** Configuration only; original GuiContent owns every measurement/paint rectangle. */
export function headerStyle(options:{readonly icon?:GuiImageSource|undefined;readonly iconPosition?:GuiIconPosition;readonly iconSize?:number;readonly iconGap?:number}):GuiStyle{
 iconPosition(options.iconPosition);iconSource(options.icon);
 for(const key of['iconSize','iconGap']as const)if(options[key]!==undefined&&(!Number.isFinite(options[key])||options[key]!<0))throw new LayoutError('invalid-input','Invalid GUI icon size/gap.');
 return{...(Object.hasOwn(options,'icon')?{icon:options.icon??null}:{}),...(options.iconPosition===undefined?{}:{iconPosition:options.iconPosition}),...(options.iconSize===undefined?{}:{iconSize:options.iconSize}),...(options.iconGap===undefined?{}:{iconGap:options.iconGap})};
}
