import { AppError } from './errors.ts';
import { draftData, optionalText, optionalDate, type ExpenseType } from './expense.ts';
import { won, checkedWon } from './money.ts';

export const detailFields: Record<ExpenseType, readonly [string,string][]> = {
  office: [['item','품명·규격'],['location','사용·수령 장소']],
  personnel: [['recipientCategory','지원 대상 구분'],['periodStart','지원 시작일'],['periodEnd','지원 종료일'],['activity','활동 내용'],['calculationMethod','산정 방식']],
  other: [['subtype','현수막·인쇄·보험 등 세부 구분'],['activity','연계 활동'],['periodStart','이용 시작일'],['periodEnd','이용 종료일'],['item','규격·내역']],
  student_travel: [['travelerCategory','출장자·학생 구분'],['travelPurpose','출장 목적'],['periodStart','출장 시작일'],['periodEnd','출장 종료일'],['location','출장 장소'],['schedule','일정'],['costBreakdown','교통·숙박 등 비용 내역']],
  materials: [['item','품명·규격'],['location','수령 장소']],
  professor_travel: [['travelerCategory','출장자·소속 구분'],['travelPurpose','출장 목적'],['periodStart','출장 시작일'],['periodEnd','출장 종료일'],['location','출장 장소'],['schedule','일정'],['costBreakdown','비용 내역']],
  software: [['product','제품·서비스'],['periodStart','이용 시작일'],['periodEnd','이용 종료일'],['purchaseKind','구매·구독 구분']],
  expertise: [['serviceType','자문·기술지원 등 구분'],['providerType','개인·업체 구분'],['activity','전문 내용'],['periodStart','시작일'],['periodEnd','종료일'],['calculationMethod','산정 방식'],['deliverable','결과물 계획']],
  meeting: [['meetingName','회의명'],['meetingAt','회의 일시'],['location','장소'],['affiliation','참석자 소속 구분'],['costBreakdown','식비·다과 등 내역']],
};
export const documentLabels: Record<string,string> = {
  calculation:'금액 산출내역', plan:'활동·출장·활용 계획', transaction:'거래·청구 근거',
  completion:'납품·수령·수행 확인', participation:'활동·참석·출장 결과',
  minutes:'회의록', licence:'이용권한·라이선스 확인', quotation:'견적·요금·주문 내역',
};
export const requiredDocuments: Record<ExpenseType, { submit: readonly string[]; approve: readonly string[] }> = {
  office:{submit:[],approve:['transaction','completion']},
  personnel:{submit:['plan','calculation'],approve:['participation','transaction']},
  other:{submit:[],approve:['transaction','completion']},
  student_travel:{submit:['plan','calculation'],approve:['participation','transaction']},
  materials:{submit:[],approve:['transaction','completion']},
  professor_travel:{submit:['plan','calculation'],approve:['participation','transaction']},
  software:{submit:['quotation'],approve:['transaction','licence']},
  expertise:{submit:['plan','calculation'],approve:['completion','transaction']},
  meeting:{submit:[],approve:['minutes','participation','transaction']},
};
export interface ApplicationData extends ReturnType<typeof draftData> {
  details: Record<string,string>;
  documents: Record<string,string[]>;
  items: {label:string;quantity:string;unitPrice:string}[];
}
export function applicationData(input: Record<string,unknown>): ApplicationData {
  const base=draftData(input), details:Record<string,string>={}, documents:Record<string,string[]>={};
  if(input.details!==undefined && (!input.details||typeof input.details!=='object'||Array.isArray(input.details)))throw new AppError('INVALID_INPUT');
  const source=(input.details??{}) as Record<string,unknown>;
  const keys=[...detailFields[base.type].map(([key])=>key),'quantity','days','people','hours','unitPrice','conditionalEvidence'];
  for(const key of keys)details[key]=optionalText(source[key],key==='conditionalEvidence'?2000:1000);
  for(const key of ['quantity','days','people','hours','unitPrice'])if(details[key] && won(details[key])<1n)throw new AppError('INVALID_INPUT');
  for(const key of ['periodStart','periodEnd'])if(details[key])optionalDate(details[key]);
  if(details.periodStart&&details.periodEnd&&details.periodStart>details.periodEnd)throw new AppError('INVALID_INPUT');
  if(input.documents!==undefined&&(!input.documents||typeof input.documents!=='object'||Array.isArray(input.documents)))throw new AppError('INVALID_INPUT');
  for(const [id,kinds] of Object.entries((input.documents??{}) as Record<string,unknown>)) {
    if(!/^[0-9a-f-]{36}$/i.test(id)||!Array.isArray(kinds)||kinds.some(k=>typeof k!=='string'||!Object.hasOwn(documentLabels,k)))throw new AppError('INVALID_INPUT');
    documents[id]=[...new Set(kinds as string[])];
  }
  if(input.items!==undefined&&(!Array.isArray(input.items)||input.items.length>50))throw new AppError('INVALID_INPUT');
  const items=((input.items??[]) as unknown[]).map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_INPUT');
    const row=value as Record<string,unknown>,label=optionalText(row.label,200),quantity=optionalText(row.quantity,30),unitPrice=optionalText(row.unitPrice,30);
    if(quantity&&won(quantity)<1n||unitPrice&&won(unitPrice)<1n)throw new AppError('INVALID_INPUT');
    return {label,quantity,unitPrice};
  });
  return {...base,details,documents,items};
}

export function validateApplication(data:ApplicationData, policy:Record<string,unknown>, applicationDate:string, approval=false):void {
  if(!data.title||!data.purpose||!data.calculation||!data.useDate||data.amount===null||won(data.amount)<=0n)throw new AppError('INVALID_INPUT');
  for(const [key] of detailFields[data.type])if(!data.details[key])throw new AppError('INVALID_INPUT');
  for(const key of ['quantity','days','people'])if(!data.details[key])throw new AppError('INVALID_INPUT');
  if(policy.status!=='verified'||!policy.source||!policy.sourceVersion||!policy.clause||!policy.startsOn||
    String(policy.startsOn)>applicationDate||(policy.endsOn&&String(policy.endsOn)<applicationDate))throw new AppError('CONFLICT');
  if(data.type==='personnel'&&!String(policy.personnelScope??'').trim())throw new AppError('CONFLICT');
  for(const key of ['rateMode','caseLimitMode','periodLimitMode','deadlineMode'])if(!['apply','not_applicable'].includes(String(policy[key])))throw new AppError('CONFLICT');
  const amount=won(data.amount);
  if(data.items.length){let total=0n;for(const item of data.items){
    if(!item.label||!item.quantity||!item.unitPrice)throw new AppError('INVALID_INPUT');
    total=checkedWon(total+checkedWon(won(item.quantity)*won(item.unitPrice)));
  }if(total!==amount)throw new AppError('INVALID_INPUT');}
  if(policy.rateMode==='apply') {
    if(policy.rate===null||policy.rate===undefined)throw new AppError('CONFLICT');
    const rate=won(policy.rate);
    if(policy.calculationUnit==='per_item'&&data.items.length){
      if(data.items.some(item=>won(item.unitPrice)>rate))throw new AppError('CONFLICT');
    }else{
    if(!data.details.unitPrice)throw new AppError('CONFLICT');
    const price=won(data.details.unitPrice);
    if(price>rate)throw new AppError('CONFLICT');
    const q=won(data.details.quantity),days=won(data.details.days),people=won(data.details.people);
    const factors:Record<string,bigint>={per_item:q,per_person:people,per_day:days,per_person_day:days*people,flat:1n};
    if(data.details.hours)factors.per_hour=won(data.details.hours);
    const factor=factors[String(policy.calculationUnit)];
    if(factor===undefined||checkedWon(price*factor)!==amount)throw new AppError('INVALID_INPUT');
    }
  } else if(!data.items.length&&data.details.unitPrice && checkedWon(won(data.details.unitPrice)*won(data.details.quantity)*won(data.details.days)*won(data.details.people))!==amount)throw new AppError('INVALID_INPUT');
  if(policy.caseLimitMode==='apply'&&(policy.caseLimit===null||policy.caseLimit===undefined||amount>won(policy.caseLimit)))throw new AppError('CONFLICT');
  if(policy.periodLimitMode==='apply'&&(policy.periodLimit===null||policy.periodLimit===undefined||!['business_period','calendar_month'].includes(String(policy.periodBasis))))throw new AppError('CONFLICT');
  if(policy.deadlineMode==='apply') {
    if(policy.deadlineDays===null||policy.deadlineDays===undefined||!['calendar','business'].includes(String(policy.calendar))||String(policy.deadlineEvent)!=='before_use')throw new AppError('CONFLICT');
    const date=new Date(applicationDate+'T00:00:00Z'),target=new Date(data.useDate+'T00:00:00Z');let count=0n;
    if(date>target)throw new AppError('CONFLICT');
    // Calendar gap computation is exact; business mode uses only explicitly configured holidays.
    if(policy.calendar==='calendar')count=BigInt(Math.floor((target.getTime()-date.getTime())/86400000));
    else {const gap=Math.floor((target.getTime()-date.getTime())/86400000),weeks=Math.floor(gap/7);count=BigInt(weeks*5);
      for(let i=1;i<=gap%7;i++){const day=(date.getUTCDay()+i)%7;if(day!==0&&day!==6)count++;}
      for(const holiday of new Set((policy.holidayDates??[]) as string[])){const h=new Date(holiday+'T00:00:00Z');
        if(h>date&&h<=target&&h.getUTCDay()!==0&&h.getUTCDay()!==6)count--;}}
    if(count<won(policy.deadlineDays))throw new AppError('CONFLICT');
  }
  const present=new Set(Object.values(data.documents).flat());
  for(const kind of approval?[...requiredDocuments[data.type].submit,...requiredDocuments[data.type].approve]:requiredDocuments[data.type].submit)if(!present.has(kind))throw new AppError('INVALID_INPUT');
}
