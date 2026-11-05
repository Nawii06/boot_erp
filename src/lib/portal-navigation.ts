export type PortalPage = 'dashboard'|'work'|'projects'|'budgets'|'expenses'|'policies'|'accounts'|'security'|'applications'|'payments';
export const pageLabels: Record<PortalPage,string> = {
  dashboard:'대시보드',work:'내·전체 업무',projects:'과제·비교과',budgets:'예산배정·변경',
  expenses:'지출 초안·증빙',policies:'단가·한도 기준',accounts:'계정 관리',security:'추가 본인 확인',applications:'신청·검토·보완',payments:'실청구·지급',
};
export function permittedPage(page: PortalPage, role: string) {
  return !['accounts','security'].includes(page) || ['staff','admin'].includes(role);
}
export function pageGroup(page: PortalPage) {
  return ['policies','accounts','security'].includes(page)?'설정':page==='dashboard'?'현황·보고서':'업무 관리';
}
