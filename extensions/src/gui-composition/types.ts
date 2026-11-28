import type {GuiElement,GuiRoot,GuiFocusManager,GuiElementOptions,GuiScrollView,GuiRect} from '@haiyue/engine/gui';
export interface GuiAnchorItem {readonly key:string;readonly label:string;readonly target:GuiElement;}
export interface GuiAnchorOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly viewport:GuiScrollView;readonly items:readonly GuiAnchorItem[];readonly offset?:number;readonly onChange?:(key:string)=>void;}
export interface GuiAffixOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly viewport:GuiScrollView;readonly content:GuiElement;readonly top?:number;/** Content-space top of the normal-flow placeholder. */readonly contentOffset?:number;}
export interface GuiMasonryItem {readonly key:string;readonly content:GuiElement;/** Caller-measured height at the supplied columnWidth. */readonly height:number;}
export interface GuiMasonryOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly columns?:number;readonly columnWidth?:number;readonly gap?:number;readonly items:readonly GuiMasonryItem[];}
export interface GuiTourStep {readonly key:string;readonly target:GuiElement;readonly title:string;readonly description:string;readonly prepare?:(signal:AbortSignal)=>void|Promise<void>;}
export interface GuiTourOptions {readonly root:GuiRoot;readonly focusManager:GuiFocusManager;readonly steps:readonly GuiTourStep[];readonly onFinish?:()=>void;readonly onChange?:(key:string)=>void;readonly style?:import('@haiyue/engine/gui').GuiStyle;}
export interface GuiWatermarkOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly content:GuiElement;readonly text:string;readonly columns?:number;readonly rows?:number;}
export interface GuiBorderBeamOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly content:GuiElement;readonly durationMs?:number;readonly size?:number;readonly paused?:boolean;}
export interface GuiVirtualPointerEvent {readonly type:'move'|'down'|'up'|'cancel';readonly x:number;readonly y:number;readonly button:0;readonly buttons:0|1;}
export interface GuiVirtualPointerHost {readonly bounds:()=>Readonly<GuiRect>;readonly dispatch:(event:GuiVirtualPointerEvent)=>void;}
