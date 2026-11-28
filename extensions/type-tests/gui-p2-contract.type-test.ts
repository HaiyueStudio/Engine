import {GuiForm,GuiInputNumber,GuiAutoComplete} from '@haiyue/extensions/gui-forms';
import {GuiTable,GuiCascader,GuiTreeSelect} from '@haiyue/extensions/gui-data';
import {GuiCarousel,GuiRate} from '@haiyue/extensions/gui-content';
const table=new GuiTable({items:[{id:'x',title:'X'}],keyOf:item=>item.id,columns:[{key:'title',title:'Title',width:200,text:item=>item.title,editable:true,onEdit:(item,value)=>{item.title=value;}}]});
table.setFilter(item=>item.title.length>0);table.dispose();new GuiInputNumber({precision:2,step:.01}).dispose();new GuiAutoComplete({suggestions:async(query,signal)=>signal.aborted?[]:[{key:query,label:query,value:query}]}).dispose();new GuiRate({allowHalf:true,value:2.5}).dispose();
// @ts-expect-error Tree selection must borrow the original root and focus owner.
new GuiTreeSelect({nodes:[],labelOf:(value:string)=>value});
// @ts-expect-error A cascader loader receives a readonly path and AbortSignal.
new GuiCascader({nodes:[],loadChildren:(path:string)=>Promise.resolve([])});
// @ts-expect-error Business state is read and written through an explicit field adapter.
new GuiForm().register({key:'x',value:'hidden model'});
// @ts-expect-error Borrowed slides must be original GUI elements.
new GuiCarousel({slides:['HTML']});
