export type {GuiControlPaintContext} from './GuiRenderer';
export type {GuiTheme} from '../GuiTypes';
export {parseGuiColor as colorToRgba} from '../GuiColor';
export {guiContentBox} from '../GuiContent';
export {guiInputCaretVisible} from '../input/GuiInputPresentation';
export {guiInputPresentation} from '../input/GuiInputPresentation';
export {guiPasswordRevealed} from '../input/GuiInputAdornments';
export {isGuiLayoutManaged} from '../GuiLayoutState';
export {measureGuiTextWidth} from './GuiTextBatch';
export {requiredItemAt} from '../../math/arrayAccess';
export {withGuiAlpha as withAlpha} from '../GuiColor';
export {paintGuiBox, paintGuiLine, paintGuiArc} from './GuiBoxPaint';
import type {GuiControlPaintContext} from './GuiRenderer';
import type {GuiElement} from '../components/GuiElement';
import type {GuiSkin} from '../GuiThemeTypes';
import {guiStyleLayer} from '../GuiStyleLayers';
import {guiThemeState} from '../GuiThemeResolve';
const emptyPart:GuiSkin=Object.freeze({});
/** Stock painters reuse the owner's already resolved skin instead of rewalking the theme tree. */
export function guiPartStyle(context:GuiControlPaintContext,element:GuiElement,name:string):GuiSkin {
  const part=context.styleFor(element).parts?.[name];return part?guiStyleLayer(part,guiThemeState(element)):emptyPart;
}
