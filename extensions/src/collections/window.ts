/** Numeric range only: callers own validation, overscroll, identity and lifetime. End is exclusive. */
export function collectionWindow(count:number,offset:number,extent:number,stride:number,overscan:number):{first:number;last:number} {
  return {first:Math.max(0,Math.floor(offset/stride)-overscan),last:Math.min(count,Math.ceil((offset+extent)/stride)+overscan)};
}
