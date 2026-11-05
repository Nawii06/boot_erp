import { AppError } from './errors.ts';
import { uuid } from './validation.ts';
import { won } from './money.ts';

export interface DashboardFilters {
  projectId: string | null;
  year: number | null;
  from: string | null;
  to: string | null;
}
export interface DashboardLine {
  id: string; projectId: string; projectName: string; label: string;
  current: string; committed: string; available: string; paid: string;
  withheld: string; received: string; refunded: string; netExecution: string;
}
export interface DashboardRecent {
  id: string; applicationId: string | null; number: string; projectId: string; projectName: string; title: string;
  amount: string | null; createdAt: string;
  state: 'draft'|'submitted'|'reviewing'|'supplement'|'approved'|'withdrawn'|'rejected'|'cancelled'|'revision';
}
export interface DashboardResult {
  asOf: string;
  scope: DashboardFilters & {
    role: string; dateBasis: 'draft_created_at_kst'; budgetBasis: 'current_snapshot';
    paymentBasis:'paid_on_kst';refundBasis:'refunded_on_kst';processingBasis:'current_state_no_period_filter';paymentScope:'assigned_work'|'project_all';
  };
  totals: { current: string; committed: string; available: string; paid: string;withheld:string;received:string;refunded:string;netExecution:string };
  lines: DashboardLine[];
  recent: DashboardRecent[];
  projects: { id: string; name: string; businessYear: number | null }[];
  processing:{review:number|null;supplement:number|null;payment:number|null};
  capabilities: { submission: true; payments: true };
  unavailable: { paid: false; review: false };
}

function date(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new AppError('INVALID_INPUT');
  }
  return value;
}

export function dashboardFilters(input: Record<string, unknown> | URLSearchParams = {}): DashboardFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT');
  let values: Record<string, unknown>;
  if (input instanceof URLSearchParams) {
    for (const name of ['projectId', 'year', 'from', 'to']) {
      if (input.getAll(name).length > 1) throw new AppError('INVALID_INPUT');
    }
    values = Object.fromEntries(input);
  } else values = input;
  const projectId = values.projectId === undefined || values.projectId === null || values.projectId === ''
    ? null : uuid(values.projectId).toLowerCase();
  let year: number | null = null;
  if (values.year !== undefined && values.year !== null && values.year !== '') {
    if ((typeof values.year !== 'string' && typeof values.year !== 'number') ||
        !/^\d{4}$/.test(String(values.year))) throw new AppError('INVALID_INPUT');
    year = Number(values.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new AppError('INVALID_INPUT');
  }
  const from = date(values.from), to = date(values.to);
  if (from && to && from > to) throw new AppError('INVALID_INPUT');
  return { projectId, year, from, to };
}

// Individual ledger amounts are int64; a report may sum many int64 amounts exactly.
export function dashboardTotals(lines: readonly DashboardLine[]): DashboardResult['totals'] {
  let current = 0n, committed = 0n,paid=0n,withheld=0n,received=0n,refunded=0n;
  for (const line of lines) {
    const c = won(line.current), d = won(line.committed);
    if (c < 0n || d < 0n || d > c || won(line.available) !== c - d) throw new AppError('UNAVAILABLE');
    for(const key of ['paid','withheld','received','refunded'] as const)if(typeof line[key]!=='string'||!/^(0|[1-9]\d*)$/.test(line[key]))throw new AppError('UNAVAILABLE');
    const p=BigInt(line.paid),w=BigInt(line.withheld),r=BigInt(line.received),f=BigInt(line.refunded);
    if(p!==w+r||line.netExecution!==(p-f).toString())throw new AppError('UNAVAILABLE');
    current += c; committed += d;paid+=p;withheld+=w;received+=r;refunded+=f;
  }
  return { current: current.toString(), committed: committed.toString(), available: (current - committed).toString(),paid:paid.toString(),withheld:withheld.toString(),received:received.toString(),refunded:refunded.toString(),netExecution:(paid-refunded).toString() };
}

export const dashboardStates:Record<DashboardRecent['state'],string>={draft:'초안',submitted:'신청',reviewing:'검토 중',supplement:'보완 요청',approved:'내부 승인',withdrawn:'회수',rejected:'반려',cancelled:'취소',revision:'수정 준비'};

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  // Quotes alone do not stop spreadsheet formulas, including after leading whitespace.
  const safe = /^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

// Accept only an already authorised snapshot. No file URLs, applicant identities, or raw data.
export function dashboardCsv(result: DashboardResult): string {
  const rows: (string | number | null)[][] = [
    ['기준시각', result.asOf],
    ['조회범위', result.scope.projectId ?? '허용 범위 전체', '학년도', result.scope.year],
    ['기간기준', '최근 신청/초안의 초안 생성일(KST)', result.scope.from, result.scope.to],
    ['예산기준', '동일 조회범위의 현재 잔액, 기간 필터 미적용'],
    ['지급·환입기준','지급일/환입일(KST)의 기간 실적, 순집행=지급총액-환입액. 실수령액과 구분'],
    ['실적열람범위',result.scope.paymentScope==='assigned_work'?'현재 배정 업무의 개인 실적':'허용 과제 전체 실적'],
    ['처리현황기준','현재 상태, 과제/학년도 적용, 기간 필터 미적용'],
    [], ['예산항목ID', '과제ID', '과제', '항목', '현재예산(조회시점)', '유효 신청 차감액(조회시점)', '가용예산(조회시점)', '기간 실제 지급총액','기간 공제','기간 실수령','기간 환입','기간 순집행'],
    ...result.lines.map(line => [line.id, line.projectId, line.projectName, line.label, line.current, line.committed, line.available,line.paid,line.withheld,line.received,line.refunded,line.netExecution]),
    ['합계', '', '', '', result.totals.current, result.totals.committed, result.totals.available,result.totals.paid,result.totals.withheld,result.totals.received,result.totals.refunded,result.totals.netExecution],
    [], ['초안ID','신청ID', '과제ID', '과제', '제목', '금액', '초안 생성시각', '상태'],
    ...result.recent.map(draft => [draft.id,draft.applicationId, draft.projectId, draft.projectName, draft.title, draft.amount, draft.createdAt,dashboardStates[draft.state]]),
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
