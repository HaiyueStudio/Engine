import type {GuiRect} from '../GuiTypes';

/** Optional event IDs increase across edits/snapshots/commits within one generation; retries reuse the ID. */
export interface GuiTextEdit {readonly startUtf16:number;readonly endUtf16:number;readonly text:string;readonly generation:number;readonly eventId?:number;readonly selectionUtf16?:readonly [number,number];}
export interface GuiTextComposition {
  readonly phase:'start'|'update'|'commit'|'cancel';readonly text:string;
  readonly selectionUtf16:readonly [number,number];readonly generation:number;readonly eventId?:number;
}
export interface GuiTextInputSession {
  setSelection(startUtf16:number,endUtf16:number):void;
  setCaretRect(rect:GuiRect):void;
  /** Additive state synchronization; old hosts can instead reopen on a value change. */
  setValue?(value:string):void;
  /** Only an explicit, synchronous host confirmation may commit on focus loss. */
  finish?():GuiTextComposition|null;
  close():void;
}
export interface GuiTextInputRequest {
  readonly value:string;readonly selectionUtf16:readonly [number,number];
  readonly inputType:'text'|'email'|'number'|'password';readonly multiline:boolean;readonly generation:number;
  readonly onEdit:(edit:GuiTextEdit)=>void;
  /** Full native snapshots are diffed at Engine's pinned grapheme boundaries. */
  readonly onValue:(value:string,selectionUtf16:readonly [number,number],generation:number,eventId?:number)=>void;
  readonly onComposition:(event:GuiTextComposition)=>void;
  readonly onSelection:(startUtf16:number,endUtf16:number,generation:number)=>void;
  /** Occlusion inside the input surface, in host CSS pixels / UIKit points, before GUI projection. */
  readonly onViewportInset:(inset:{top:number;right:number;bottom:number;left:number})=>void;
  readonly onCommand:(command:'next'|'previous'|'submit'|'cancel'|'undo'|'redo'|'deleteBackward'|'deleteForward'|'left'|'right'|'extendLeft'|'extendRight')=>void;
  readonly onFocusLost:(generation:number)=>void;
}
export interface GuiTextInputHost {
  open(request:GuiTextInputRequest):GuiTextInputSession;
  /** Browser-only ownership query; Native hosts need not implement DOM behavior. */
  ownsTarget?(target:EventTarget|null):boolean;
}
