/** DOM value sanitization changes line endings; stored Engine text stays byte-for-byte UTF-16. */
export class GuiNativeTextProjection {
  readonly value:string;
  private readonly offsets:number[]=[0];
  constructor(readonly stored:string,multiline:boolean){
    let value='';
    for(let index=0;index<stored.length;){
      const character=stored[index]!;
      if(character==='\r'){
        index++;this.offsets[index]=value.length;
        if(stored[index]==='\n')index++;
        if(multiline)value+='\n';
      }else {index++;if(character!=='\n'||multiline)value+=character;}
      this.offsets[index]=value.length;
    }
    this.value=value;
  }
  toNative(index:number):number {return this.offsets[Math.max(0,Math.min(this.stored.length,Math.trunc(index)))]!;}
  toStored(index:number):number {
    const target=Math.max(0,Math.min(this.value.length,Math.trunc(index)));let low=0,high=this.offsets.length-1;
    while(low<high){const mid=(low+high)>>>1;if(this.offsets[mid]!<target)low=mid+1;else high=mid;}
    return low;
  }
}
