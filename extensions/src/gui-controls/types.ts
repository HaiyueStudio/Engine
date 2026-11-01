import type{GuiElement,GuiElementOptions,GuiFocusManager,GuiImageSource,GuiIconPosition}from'@haiyue/engine/gui';
export interface GuiBreadcrumbMenuItem{readonly key:string;readonly label:string;readonly disabled?:boolean;readonly icon?:GuiImageSource;}
export interface GuiBreadcrumbItem{readonly key:string;readonly label:string;readonly icon?:GuiImageSource;readonly iconPosition?:GuiIconPosition;readonly disabled?:boolean;readonly separator?:string;readonly menu?:readonly GuiBreadcrumbMenuItem[];}
export interface GuiBreadcrumbOptions{readonly items:readonly GuiBreadcrumbItem[];readonly currentKey?:string|null;readonly separator?:string;readonly focus?:GuiFocusManager;readonly onNavigate?:(key:string)=>void;readonly style?:GuiElementOptions['style'];}
export type GuiBadgeValue=number|string;
export type GuiBadgeStatus='default'|'processing'|'success'|'warning'|'error';
export type GuiBadgePlacement='top-left'|'top-right'|'bottom-left'|'bottom-right';
export interface GuiBadgeOptions{readonly content?:GuiElement;readonly value?:GuiBadgeValue;readonly variant?:'count'|'dot'|'status';readonly status?:GuiBadgeStatus;readonly statusText?:string;readonly overflowCount?:number;readonly showZero?:boolean;readonly placement?:GuiBadgePlacement;readonly offset?:readonly[number,number];readonly style?:GuiElementOptions['style'];}
export interface GuiCollapseItem{readonly key:string;readonly title:string;readonly content:GuiElement;readonly icon?:GuiImageSource;readonly iconPosition?:GuiIconPosition;readonly disabled?:boolean;readonly extra?:GuiElement;}
export interface GuiCollapseOptions{readonly items:readonly GuiCollapseItem[];readonly expandedKeys?:readonly string[];readonly accordion?:boolean;readonly toggleArea?:'header'|'icon';readonly expandIconPosition?:GuiIconPosition;readonly focus?:GuiFocusManager;readonly onExpandChange?:(keys:readonly string[])=>void;readonly style?:GuiElementOptions['style'];}
