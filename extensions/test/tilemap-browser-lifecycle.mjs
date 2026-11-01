/** Observe the original owner's retirement; never hide residue by destroying the device. */
export async function drainTilemap(renderer,device){
 await device.queue.onSubmittedWorkDone();
 const start=performance.now();
 while(renderer.stats.totalBytes>0&&performance.now()-start<5000)await new Promise(resolve=>setTimeout(resolve,0));
 const stats=renderer.stats;
 if(stats.totalBytes!==0||stats.pendingRecordings!==0)throw Error('Tilemap retirement did not reach zero within five seconds.');
 return {elapsedMs:performance.now()-start,stats};
}
export async function renderedFrames(engine,count){
 return new Promise(resolve=>{let seen=0;const onFrame=()=>{if(++seen>=count){engine.off('after-update',onFrame);resolve();}};engine.on('after-update',onFrame);engine.run();});
}
