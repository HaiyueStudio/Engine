import {OverlayController,validateOverlayTrigger} from './overlay.js';
import type {GuiPopoverOptions} from './types.js';
export class GuiPopover extends OverlayController {
  constructor(options:GuiPopoverOptions){super(validateOverlayTrigger(options,options.trigger??'click'),options.content);this.bindTrigger(options.trigger??'click');}
}
