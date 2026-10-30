import type {GuiInput} from '../components/GuiInput';
import {GuiDirtyFlags} from '../GuiTypes';
import {guiInputCaretRevision,resetGuiInputCaret,toggleGuiInputCaret} from './GuiInputPresentation';

/** One focused-control timer. Retained regions repaint only when the caret phase changes. */
export class GuiCaretClock {
  private target:GuiInput|null=null;
  private revision=0;
  private timer:ReturnType<typeof setTimeout>|null=null;
  constructor(private readonly valid:(input:GuiInput)=>boolean){}
  synchronize(input:GuiInput|null):void {
    const target=input&&this.valid(input)&&!input.readOnly&&!input.disabled&&!input.hasSelection&&!input.isComposing?input:null;
    if(this.target===target&&(!target||this.revision===guiInputCaretRevision(target)))return;
    this.stop();if(!target)return;this.target=target;this.revision=guiInputCaretRevision(target);this.schedule();
  }
  stop():void {if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.target=null;}
  private schedule():void {
    this.timer=setTimeout(()=>{
      this.timer=null;const target=this.target;if(!target)return;
      if(!this.valid(target)||target.disabled||target.readOnly||target.hasSelection||target.isComposing){this.stop();return;}
      const revision=guiInputCaretRevision(target);
      if(revision!==this.revision){this.revision=revision;resetGuiInputCaret(target);this.revision=guiInputCaretRevision(target);}
      else {toggleGuiInputCaret(target);target.markDirty(GuiDirtyFlags.Visual);}
      this.schedule();
    },500);
    // Node-based hosts/tests should not stay alive solely for a GUI caret.
    (this.timer as unknown as {unref?:()=>void}).unref?.();
  }
}
