/** Fail visibly instead of waiting for rAF on an occluded/background page. */
export async function readFrameGraphPresentation(cdp) {
  const response=await cdp.call('Runtime.evaluate',{expression:'({visible:document.visibilityState,focused:document.hasFocus()})',returnByValue:true});
  if(response.result?.exceptionDetails)throw Error('Cannot inspect presentation state');
  return response.result?.result?.value;
}
export async function requireFrameGraphPresentation(cdp,{timeoutMs=5000,pollMs=100}={}) {
  // Run after navigation and fixture initialization so this request addresses
  // the actual measurement page, rather than the preceding about:blank page.
  await cdp.call('Page.bringToFront');
  const deadline=Date.now()+timeoutMs;
  let state;
  do {
    state=await readFrameGraphPresentation(cdp);
    if(state?.visible==='visible'&&state.focused===true)return state;
    if(Date.now()>=deadline)break;
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }while(Date.now()<=deadline);
  const error=Error(`Visible sampling unavailable: ${JSON.stringify(state)}. No capture started; restore the test window before a new attempt.`);
  error.code='G09_PRESENTATION_UNAVAILABLE';error.presentation=state;throw error;
}
