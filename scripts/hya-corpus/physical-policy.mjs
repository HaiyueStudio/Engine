/** Hardware assertions supplement, and never replace, the operator's real-device confirmation. */
export function validatePhysicalEvidence(report, confirmation) {
  const errors=[];
  if(report?.status!=='awaiting-operator-confirmation'||report.smoke!==false)errors.push('A completed manual run is required; smoke is never input qualification.');
  if(confirmation?.confirmed!==true||!confirmation.note?.trim()||!Number.isFinite(Date.parse(confirmation.confirmedAt)))errors.push('Explicit operator confirmation is required.');
  if(report?.servedBytes?.status!=='passed'||report.changed?.length!==0||report.failures?.length!==0)errors.push('Current source, served bytes and all runtime checks must pass.');
  if(report?.leases!==0||report.resources?.totals?.resources!==0)errors.push('Input run must release all owned resources.');
  if(report.profile==='browser-real-ime'){
    const events=report.events??[],commits=report.commits??[],snapshots=report.snapshots??[];
    for(const type of ['compositionstart','compositionupdate','compositionend'])
      if(!events.some(e=>e.type===type&&e.isTrusted===true))errors.push('Missing real trusted '+type);
    if(events.filter(e=>e.type==='compositionstart'&&e.isTrusted).length<2)errors.push('Commit and cancellation must each use real composition.');
    if(!events.some(e=>e.type==='keydown'&&e.key==='Escape'&&e.isTrusted))errors.push('Missing real cancellation key.');
    if(commits.filter(c=>c.data==='你好').length!==1||commits.some(c=>c.data!=='你好'))errors.push('Expected exactly one committed 你好 and no cancellation commit.');
    if(snapshots.length<3||snapshots.some(s=>s.data!=='你好'||s.composing))errors.push('Commit, cancel and resize checkpoints must retain the committed value.');
    if(snapshots.length>=3&&snapshots.every(s=>String(s.viewport)===String(snapshots[0].viewport)))errors.push('No actual viewport change recorded.');
  }else if(report.profile==='physical-gamepad'){
    const controls=report.controls??[],down=controls.filter(c=>c.control==='button:0'&&c.phase==='down'),up=controls.filter(c=>c.control==='button:0'&&c.phase==='up');
    if(!report.hardware?.some(h=>h.id&&h.buttons>0&&h.axes>0)||!(report.polls>0))errors.push('No original-sampler hardware identity.');
    if(down.length!==1||up.length!==1||up[0].time-down[0].time<700)errors.push('One sustained A down/up pair of at least 700 ms is required.');
    if(!controls.some(c=>c.control==='axis:0'&&c.value<=-.5)||!controls.some(c=>c.control==='axis:0'&&c.value>=.5)
      ||!controls.some(c=>c.control==='axis:0'&&Math.abs(c.value)<=.15))errors.push('Left, right and centered axis changes are required.');
    if(JSON.stringify(report.commits?.map(c=>c.data))!==JSON.stringify(['AAA','AA']))errors.push('Gamepad down/up must commit exactly once each.');
  }else errors.push('Unknown physical input profile.');
  return errors;
}
