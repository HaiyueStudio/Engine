/** A GUI-consumption assertion requires its original focus owner and a neutral start. */
export function physicalGamepadReadiness(previous, {focused, foreground, connected, buttons, axes}) {
  if(!focused||!foreground)return 'waiting-focus';
  if(!connected)return 'waiting-controller';
  if(previous==='ready')return 'ready';
  if(buttons.some(value=>value>0.000001)||axes.some(value=>Math.abs(value)>.15))return 'waiting-neutral';
  return 'ready';
}

/** Preserve native slot numbers; never silently change a selected controller. */
export function physicalGamepadSelection(pads, selectedIndex = null) {
  if(selectedIndex!==null)return pads[selectedIndex]?.connected===true?{index:selectedIndex,pad:pads[selectedIndex]}:null;
  for(let index=0;index<pads.length;index++)if(pads[index]?.connected===true)return {index,pad:pads[index]};
  return null;
}

/** Detection is separate from editor focus and from acceptance. No polling here. */
export function physicalGamepadDetection({requested,foreground,suspended,polls,lastSampleAgeMs,connectedIndices,selectedIndex,prepared}) {
  if(!requested)return {state:'start-required',message:'请先点击准备按钮，再按 B 一次并松开。'};
  if(!foreground)return {state:'foreground-required',message:'请将此测试窗口置于前台；当前不进行 READY 判定。'};
  if(suspended||!polls||lastSampleAgeMs>1500)return {state:'sampling-paused',message:'采样心跳已暂停，请保持窗口可见并置于前台。'};
  if(!connectedIndices.length)return {state:'waiting-browser',message:'浏览器尚未提供手柄。请在本窗口按 B 一次并松开；这不代表系统未识别设备。'};
  if(selectedIndex===null||!connectedIndices.includes(selectedIndex))return {state:'selected-disconnected',message:'本轮选定手柄已断开，请保存记录后重新开始。'};
  if(!prepared)return {state:'waiting-neutral',message:'手柄已检测到，请松开全部按钮并将摇杆回中。'};
  return {state:'detected',message:'手柄已检测到。请点击画布内文字，再等待绿色 READY。'};
}
