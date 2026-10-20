import { AppError } from './errors.ts';
import { won } from './money.ts';
export const expenseTypes = {
  office: '사무용품', personnel: '연구인력지원비',
  other: '연구활동기타비용(현수막, 인쇄, 여행자보험등)',
  student_travel: '학생출장비', materials: '연구재료구입비', professor_travel: '교수출장비',
  software: '소프트웨어 활용비', expertise: '외부전문기술활용비', meeting: '회의비',
} as const;
export type ExpenseType = keyof typeof expenseTypes;
export function expenseType(value: unknown): ExpenseType {
  if (typeof value !== 'string' || !Object.hasOwn(expenseTypes,value)) throw new AppError('INVALID_INPUT');
  return value as ExpenseType;
}
export function optionalText(value: unknown, max=200): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new AppError('INVALID_INPUT');
  return value.trim();
}
export function optionalWon(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const n=won(value); if(n<0n) throw new AppError('INVALID_INPUT'); return n.toString();
}
export function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if(typeof value!=='string'|| !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0,10)!==value) throw new AppError('INVALID_INPUT');
  return value;
}
export function draftData(input: Record<string,unknown>) {
  if (!['planned','actual'].includes(String(input.dateKind))) throw new AppError('INVALID_INPUT');
  return {type:expenseType(input.type),title:optionalText(input.title),purpose:optionalText(input.purpose,5000),
    calculation:optionalText(input.calculation,2000),dateKind:input.dateKind as string,
    useDate:optionalDate(input.useDate),amount:optionalWon(input.amount)};
}
export function policyData(input: Record<string,unknown>) {
  if(!['pending','verified'].includes(String(input.status))) throw new AppError('INVALID_INPUT');
  const data={status:String(input.status),unit:optionalText(input.unit,100),
    rate:optionalWon(input.rate),caseLimit:optionalWon(input.caseLimit),periodLimit:optionalWon(input.periodLimit),
    limitPeriod:optionalText(input.limitPeriod,200),deadlineEvent:optionalText(input.deadlineEvent,200),
    deadlineDays:optionalWon(input.deadlineDays),calendar:optionalText(input.calendar,20),
    source:optionalText(input.source,500),sourceVersion:optionalText(input.sourceVersion,200),
    clause:optionalText(input.clause,500),startsOn:optionalDate(input.startsOn),endsOn:optionalDate(input.endsOn)};
  if (data.startsOn&&data.endsOn&&data.endsOn<data.startsOn) throw new AppError('INVALID_INPUT');
  if (data.calendar && !['calendar','business'].includes(data.calendar)) throw new AppError('INVALID_INPUT');
  if (data.deadlineDays!==null && (!data.deadlineEvent||!data.calendar)) throw new AppError('INVALID_INPUT');
  if (data.periodLimit!==null&&!data.limitPeriod) throw new AppError('INVALID_INPUT');
  if (data.rate!==null&&!data.unit) throw new AppError('INVALID_INPUT');
  if(data.status==='verified' && (!data.source||!data.sourceVersion||!data.clause||!data.startsOn ||
    [data.rate,data.caseLimit,data.periodLimit,data.deadlineDays].every(v=>v===null))) throw new AppError('INVALID_INPUT');
  return data;
}
