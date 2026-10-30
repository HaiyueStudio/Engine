/** One completion observation avoids repeated inspector queries starving a busy baseline.
 * This does not change the browser workload, GPU warmup or measurement windows.
 */
export async function waitForProductionResult(cdp, timeoutMs) {
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('A positive native capture timeout is required');
 const response=await cdp.call('Runtime.evaluate',{
  expression:`new Promise(resolve => {
   const completed=()=>{const status=document.querySelector('#result')?.dataset.status;return status==='passed'||status==='failed';};
   if(completed()){resolve(true);return;}
   const observer=new MutationObserver(()=>{if(completed()){observer.disconnect();resolve(true);}});
   observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-status']});
  })`,awaitPromise:true,returnByValue:true,
 },timeoutMs);
 if(response.result?.exceptionDetails||response.result?.result?.value!==true)throw Error('Native production completion observation failed');
}
