/** Private vendored algorithm; scalar-indexed, fixed Unicode 15.1. */
export interface BidiEmbedding{readonly levels:Uint8Array;readonly paragraphs:readonly Readonly<{start:number;end:number;level:number}>[];}
export function embeddingLevels(text:string,direction?:'ltr'|'rtl'|'auto'):BidiEmbedding;
export function reorderedIndices(text:string,levels:BidiEmbedding,start?:number,end?:number):number[];
export function getBidiCharTypeName(char:string):string;
export function getMirroredCharacter(char:string):string|null;
export function reorderedLineIndices(points:readonly string[],levels:BidiEmbedding,start:number,end:number):number[];
