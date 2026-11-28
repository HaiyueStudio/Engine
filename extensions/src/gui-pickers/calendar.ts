import {fail} from '../gui-common/composite.js';
export function dateValue(value:string):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01'||value>'9999-12-31')fail('Use a calendar date YYYY-MM-DD.');
 const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.valueOf())||d.toISOString().slice(0,10)!==value)fail('Invalid calendar date.');return value;
}
export function monthValue(value:string):string {dateValue(value+'-01');return value;}
export function shiftMonth(value:string,delta:number):string {const year=Number(value.slice(0,4)),month=Number(value.slice(5,7))-1,total=year*12+month+delta;if(total<12||total>119999)fail('Calendar month is out of range.');return String(Math.floor(total/12)).padStart(4,'0')+'-'+String(total%12+1).padStart(2,'0');}
export function calendarDays(month:string,firstDay:number):readonly (string|null)[] {
 const date=new Date(month+'-01T00:00:00Z'),offset=(date.getUTCDay()-firstDay+7)%7,start=date.valueOf()-offset*86400000;
 return Array.from({length:42},(_,index)=>{const d=new Date(start+index*86400000),y=d.getUTCFullYear();return y<1||y>9999?null:d.toISOString().slice(0,10);});
}
