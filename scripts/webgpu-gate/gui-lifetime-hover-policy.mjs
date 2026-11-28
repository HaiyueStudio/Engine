export const GUI_LIFETIME_HOVER_CASE_IDS=Object.freeze(['number-dispose','number-blur','constructor-popover','constructor-dropdown','constructor-popconfirm','popup-child-hover','popup-child-switch','popup-outside-close','carousel-child-hover','carousel-resume','submenu-child-hover','submenu-outside-close','touch-no-hover-open','custom-style','subscriptions-released','resources-released']);
export function validateGuiLifetimeHover(report){
  const check=(condition,message)=>{if(!condition)throw Error('GUI lifetime/hover: '+message);};
  check(report?.schemaVersion===1&&report.role==='native-gui-interaction-regression'&&report.status==='passed','fixture failed');
  check(Array.isArray(report.cases)&&report.cases.length===GUI_LIFETIME_HOVER_CASE_IDS.length,'incomplete cases');const ids=new Set(report.cases.map(entry=>entry.id));check(ids.size===report.cases.length&&GUI_LIFETIME_HOVER_CASE_IDS.every(id=>ids.has(id)),'missing or duplicate named interaction');
  check(report.cases.every(entry=>entry.passed===true),'interaction failed');check(Array.isArray(report.failures)&&report.failures.length===0,'failures were recorded');check(Array.isArray(report.validationErrors)&&report.validationErrors.length===0,'GPU validation failed');check(report.resourceResidue?.resources===0,'resources remain');return{status:'passed',interactions:report.cases.length};
}
