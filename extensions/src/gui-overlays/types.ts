import type {GuiElement,GuiRoot,GuiFocusManager,GuiStyle,GuiImageSource} from '@haiyue/engine/gui';
export type GuiOverlayCloseReason='trigger'|'outside'|'escape'|'select'|'confirm'|'cancel'|'close'|'anchor-hidden'|'disposed';
export interface GuiOverlayOptions {
  readonly root:GuiRoot;readonly focusManager:GuiFocusManager;readonly anchor?:GuiElement;
  readonly width?:number;readonly height?:number;readonly placement?:'top'|'right'|'bottom'|'left';readonly align?:'start'|'center'|'end';
  readonly closeOnOutside?:boolean;readonly closeOnEscape?:boolean;readonly style?:GuiStyle;
  readonly onOpenChange?:(open:boolean,reason:GuiOverlayCloseReason)=>void;
}
export interface GuiPopoverOptions extends GuiOverlayOptions {readonly content:GuiElement;readonly trigger?:'click'|'hover'|'manual';}
export interface GuiMenuItem {readonly key:string;readonly label?:string;readonly type?:'item'|'separator';readonly icon?:GuiImageSource;readonly shortcut?:string;readonly disabled?:boolean;readonly danger?:boolean;readonly checked?:boolean;readonly children?:readonly GuiMenuItem[];}
export interface GuiMenuOptions {readonly items:readonly GuiMenuItem[];readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly style?:GuiStyle|undefined;readonly onSelect?:(key:string)=>void;}
export interface GuiDropdownOptions extends GuiOverlayOptions {readonly items:readonly GuiMenuItem[];readonly trigger?:'click'|'hover'|'manual';readonly onSelect?:(key:string)=>void;}
export interface GuiContextMenuOptions extends Omit<GuiDropdownOptions,'trigger'> {readonly longPressMs?:number;}
export interface GuiDialogOptions extends GuiOverlayOptions {readonly title?:string;readonly content:GuiElement;readonly header?:GuiElement;readonly footer?:GuiElement;readonly confirmText?:string;readonly cancelText?:string;readonly onConfirm?:()=>boolean|void;readonly onCancel?:()=>boolean|void;}
export interface GuiDrawerOptions extends GuiDialogOptions {readonly side?:'left'|'right'|'top'|'bottom';}
export interface GuiPopconfirmOptions extends GuiOverlayOptions {readonly title:string;readonly description?:string;readonly confirmText?:string;readonly cancelText?:string;readonly onConfirm?:()=>boolean|void;readonly onCancel?:()=>void;}
export interface GuiNotificationOptions {readonly key?:string;readonly title:string;readonly description?:string;readonly status?:'info'|'success'|'warning'|'error';readonly durationMs?:number;readonly action?:GuiElement;}
export interface GuiNotificationCenterOptions {readonly root:GuiRoot;readonly focusManager:GuiFocusManager;readonly placement?:'top-left'|'top-right'|'bottom-left'|'bottom-right';readonly maxVisible?:number;readonly durationMs?:number;readonly style?:GuiStyle;}
