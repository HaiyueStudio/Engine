import type {GuiRoot,GuiFocusManager,GuiElementOptions} from '@haiyue/engine/gui';
export interface GuiDatePickerOptions extends GuiElementOptions {
 readonly root:GuiRoot;readonly focusManager:GuiFocusManager;
 /** Calendar dates, never instants or local-midnight timestamps. */
 readonly value?:string|null;readonly month?:string;readonly min?:string;readonly max?:string;
 readonly firstDayOfWeek?:number;readonly locale?:string;readonly placeholder?:string;
 readonly isDateDisabled?:(date:string)=>boolean;readonly onChange?:(date:string|null)=>void;
}
export interface GuiTimePickerOptions extends GuiElementOptions {
 readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;
 readonly value?:string|null;readonly seconds?:boolean;readonly stepMinutes?:number;readonly stepSeconds?:number;
 readonly min?:string;readonly max?:string;readonly onChange?:(time:string|null)=>void;
}
