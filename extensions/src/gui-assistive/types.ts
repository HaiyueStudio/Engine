import type {GuiElementOptions,GuiRoot,GuiFocusManager,GuiInput} from '@haiyue/engine/gui';
import type {GuiSuggestion} from '../gui-forms/types.js';
import type {GuiVirtualPointerHost} from '../gui-composition/types.js';
export interface GuiMentionsOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly value?:string;readonly trigger?:string;readonly suggestions:(query:string,signal:AbortSignal)=>readonly GuiSuggestion[]|Promise<readonly GuiSuggestion[]>;readonly onChange?:(value:string)=>void;}
export interface GuiVirtualKey {readonly key:string;readonly label:string;readonly text?:string;readonly action?:'backspace'|'delete'|'left'|'right'|'enter'|'space';}
export interface GuiVirtualKeyboardOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly target:()=>GuiInput|null;readonly rows?:readonly (readonly GuiVirtualKey[])[];}
export interface GuiVirtualMouseOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly host:GuiVirtualPointerHost;readonly step?:number;}
export interface GuiHistorySnapshot {readonly canUndo:boolean;readonly canRedo:boolean;readonly entries:readonly {readonly key:string;readonly label:string}[];readonly currentKey?:string;}
export interface GuiHistoryPort {readonly read:()=>GuiHistorySnapshot;readonly subscribe:(changed:()=>void)=>()=>void;readonly undo:()=>void;readonly redo:()=>void;readonly goTo?:(key:string)=>void;}
export interface GuiHistoryControlsOptions extends GuiElementOptions {readonly root?:GuiRoot;readonly focusManager?:GuiFocusManager;readonly history:GuiHistoryPort;readonly showEntries?:boolean;}
