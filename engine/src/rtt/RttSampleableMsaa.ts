// Private capability, enabled before attachments are allocated. Ordinary RTTs
// keep their existing attachment usage and public constructor contract.
const enabled=new WeakSet<object>();
export function enableRttSampleableMsaa(owner:object):void {enabled.add(owner);}
export function rttHasSampleableMsaa(owner:object):boolean {return enabled.has(owner);}
