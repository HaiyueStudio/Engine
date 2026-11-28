import type {GuiElementOptions,GuiElement,GuiRoot,GuiFocusManager,GuiImageSource} from '@haiyue/engine/gui';
export interface GuiDisplayOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;}
export type GuiFeedbackStatus='default'|'info'|'success'|'warning'|'error';
export interface GuiCardOptions extends GuiDisplayOptions {readonly title?:string;readonly extra?:GuiElement;readonly cover?:GuiElement;readonly content?:GuiElement;readonly footer?:GuiElement;readonly bordered?:boolean;readonly hoverable?:boolean;readonly loading?:boolean;}
export interface GuiDividerOptions extends GuiDisplayOptions {readonly orientation?:'horizontal'|'vertical';readonly text?:string;readonly textAlign?:'start'|'center'|'end';readonly lineWidth?:number;}
export interface GuiTagOptions extends GuiDisplayOptions {readonly text:string;readonly status?:GuiFeedbackStatus;readonly icon?:GuiImageSource;readonly closable?:boolean;readonly onClose?:()=>boolean|void;}
export interface GuiImageViewOptions extends GuiDisplayOptions {readonly source?:GuiImageSource;readonly fallbackSource?:GuiImageSource;readonly fit?:'fill'|'contain'|'cover'|'none';readonly placeholder?:string;readonly errorText?:string;}
export interface GuiAvatarOptions extends GuiImageViewOptions {readonly label?:string;readonly size?:number;readonly shape?:'circle'|'square';}
export interface GuiAlertOptions extends GuiDisplayOptions {readonly title:string;readonly description?:string;readonly status?:Exclude<GuiFeedbackStatus,'default'>;readonly closable?:boolean;readonly action?:GuiElement;readonly onClose?:()=>boolean|void;}
export interface GuiEmptyOptions extends GuiDisplayOptions {readonly description?:string;readonly image?:GuiImageSource;readonly action?:GuiElement;}
export interface GuiSpinOptions extends GuiDisplayOptions {readonly spinning?:boolean;readonly delayMs?:number;readonly size?:number;readonly label?:string;readonly content?:GuiElement;}
export interface GuiSkeletonOptions extends GuiDisplayOptions {readonly rows?:number;readonly avatar?:boolean;readonly title?:boolean;readonly animated?:boolean;readonly loading?:boolean;readonly content?:GuiElement;}
export interface GuiSelectionItem {readonly key:string;readonly label:string;readonly icon?:GuiImageSource;readonly disabled?:boolean;}
export interface GuiButtonGroupOptions extends GuiDisplayOptions {readonly items:readonly GuiSelectionItem[];readonly orientation?:'horizontal'|'vertical';readonly selection?:'none'|'single';readonly selectedKey?:string|null;readonly onSelect?:(key:string)=>void;}
export interface GuiSegmentedOptions extends Omit<GuiButtonGroupOptions,'selection'> {}
