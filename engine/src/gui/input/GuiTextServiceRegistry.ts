import type {GuiTextServices} from './GuiTextServices';
import type {GuiTextServiceContext,GuiSystemOptions} from '../systems/GuiSystem';
type Factory=(context:GuiTextServiceContext,options:GuiSystemOptions,document:Document|undefined)=>GuiTextServices;
let factory:Factory|undefined;
/** Registered by the reachable GuiInput prototype, without an additional sampler or host. */
export function admitGuiTextServices(value:Factory):void{factory=value;}
export function getGuiTextServiceFactory():Factory|undefined{return factory;}
