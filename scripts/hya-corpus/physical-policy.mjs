// Chromium queues compositionend through DispatchScopedEvent, bypassing the trusted
// DispatchEvent path. Bound this observed quirk to the tested native browser only;
// preserve the raw flag and require its complete trusted start/update/input session.
// https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/editing/ime/input_method_controller.cc
export function validateImeSessions(report) {
  const errors=[],sessions=[];let active;
  const chromiumScopedEnd=report.browserEvidence?.product==='Chrome/155.0.8059.85'
    &&report.browserEvidence.nativeBackend===true&&report.browserEvidence.presentationMode==='visible-window';
  for(const event of report.events??[]){
    if(event.type==='compositionstart'){
      if(active)errors.push('Overlapping real composition sessions.');
      active={responder:event.responder,trusted:event.isTrusted===true,updates:0,inputs:0,cancelKey:false};
      if(!active.trusted||!active.responder)errors.push('Composition must begin on a trusted original responder.');
    }else if(active&&event.responder===active.responder){
      if(event.type==='compositionupdate'&&event.isTrusted===true)active.updates++;
      if(event.type==='beforeinput'&&event.isTrusted===true&&event.inputType==='insertCompositionText')active.inputs++;
      // Windows IME reports the physical cancellation key as Process/229 while composing.
      // The empty completed session plus unchanged data proves cancellation; the operator
      // separately confirms using Esc. Never fabricate or relabel that original key event.
      if(event.type==='keydown'&&event.isTrusted===true&&(event.key==='Escape'
        ||event.key==='Process'&&event.keyCode===229&&event.nativeComposing===true))active.cancelKey=true;
      if(event.type==='compositionend'){
        if(!(event.isTrusted===true||chromiumScopedEnd&&event.isTrusted===false)||!active.updates||!active.inputs)
          errors.push('Composition end requires a complete trusted native session.');
        if(event.compositionData===''&&!active.cancelKey)errors.push('Cancellation requires a real key in the same native session.');
        sessions.push({...active,data:event.compositionData,endTrusted:event.isTrusted});active=undefined;
      }
    }else if(event.type==='compositionend')errors.push('Composition ended without the same original responder.');
  }
  if(active)errors.push('Unfinished composition session.');
  if(sessions.length<2||!sessions.some(s=>s.data==='你好')||!sessions.some(s=>s.data===''))errors.push('Real commit and cancellation sessions are both required.');
  return errors;
}

/** Hardware assertions supplement, and never replace, the operator's real-device confirmation. */
export function validatePhysicalEvidence(report, confirmation) {
  const errors=[];
  if(report?.status!=='awaiting-operator-confirmation'||report.smoke!==false)errors.push('A completed manual run is required; smoke is never input qualification.');
  if(confirmation?.confirmed!==true||!confirmation.note?.trim()||!Number.isFinite(Date.parse(confirmation.confirmedAt)))errors.push('Explicit operator confirmation is required.');
  if(report?.servedBytes?.status!=='passed'||report.changed?.length!==0||report.failures?.length!==0)errors.push('Current source, served bytes and all runtime checks must pass.');
  if(report?.leases!==0||report.resources?.totals?.resources!==0)errors.push('Input run must release all owned resources.');
  if(report.profile==='browser-real-ime'){
    const commits=report.commits??[],snapshots=report.snapshots??[];
    errors.push(...validateImeSessions(report));
    if(commits.filter(c=>c.data==='你好').length!==1||commits.some(c=>c.data!=='你好'))errors.push('Expected exactly one committed 你好 and no cancellation commit.');
    if(snapshots.length<3||snapshots.some(s=>s.data!=='你好'||s.composing))errors.push('Commit, cancel and resize checkpoints must retain the committed value.');
    if(snapshots.length>=3&&snapshots.every(s=>String(s.viewport)===String(snapshots[0].viewport)))errors.push('No actual viewport change recorded.');
  }else if(report.profile==='physical-gamepad'){
    if(!(report.inputAudit?.readySamples>0)||report.inputAudit.sceneActionLeaks!==0||report.inputAudit.unarmedGuiControls!==0)
      errors.push('Gamepad workflow requires original GUI focus, neutral acquisition and zero scene leakage.');
    const controls=report.controls??[],down=controls.filter(c=>c.control==='button:0'&&c.phase==='down'),up=controls.filter(c=>c.control==='button:0'&&c.phase==='up');
    if(!report.hardware?.some(h=>h.id&&h.buttons>0&&h.axes>0)||!(report.polls>0))errors.push('No original-sampler hardware identity.');
    if(down.length!==1||up.length!==1||up[0].time-down[0].time<700)errors.push('One sustained A down/up pair of at least 700 ms is required.');
    if(!controls.some(c=>c.control==='axis:0'&&c.value<=-.5)||!controls.some(c=>c.control==='axis:0'&&c.value>=.5)
      ||!controls.some(c=>c.control==='axis:0'&&Math.abs(c.value)<=.15))errors.push('Left, right and centered axis changes are required.');
    if(JSON.stringify(report.commits?.map(c=>c.data))!==JSON.stringify(['AAA','AA']))errors.push('Gamepad down/up must commit exactly once each.');
  }else errors.push('Unknown physical input profile.');
  return errors;
}
