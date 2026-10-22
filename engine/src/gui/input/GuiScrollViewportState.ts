import type {GuiScrollView} from '../components/GuiScrollView';
const occlusions=new WeakMap<GuiScrollView,number>();
export const guiScrollOcclusion=(view:GuiScrollView):number=>occlusions.get(view)??0;
export function setGuiScrollOcclusion(view:GuiScrollView,bottom:number):void {
  const value=Math.max(0,Math.min(view.rect.height,bottom));
  if(guiScrollOcclusion(view)===value)return;
  if(value)occlusions.set(view,value);else occlusions.delete(view);
  view.scrollTo(view.scrollY);
}
