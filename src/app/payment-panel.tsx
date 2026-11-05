'use client';
import { useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode } from 'react';
import { externalAttemptKinds } from '../lib/payments.ts';
import { formSaved,requestFormLeave } from './form-state.ts';
type Row=Record<string,unknown>;
const s=(value:unknown)=>String(value??'');
const day=(value:unknown)=>s(value).slice(0,10);
const money=(value:unknown)=>{try{return BigInt(s(value)).toLocaleString('ko-KR')+'원';}catch{return '확인 필요';}};
async function api(path:string,data?:Row) {
  const r=await fetch('/api/erp/'+path,{cache:'no-store',credentials:'same-origin',...(data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
  const out=await r.json();if(!r.ok)throw new Error(out.error?.code??'UNAVAILABLE');return out;
}
function Form({children,label,send}:{children:ReactNode;label:string;send:(data:Row)=>Promise<unknown>}) {
  const[busy,setBusy]=useState(false);
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget;setBusy(true);try{const result=await send(Object.fromEntries(new FormData(form)));if(result!==false&&result!==null)formSaved(form);}finally{setBusy(false);}}
  return <form className="editor" onSubmit={submit}>{children}<label>처리 사유<textarea name="reason" maxLength={1000} required/></label><button disabled={busy}>{busy?'처리 중…':label}</button></form>;
}
const Evidence=()=> <label>실제 사실 확인 근거<textarea name="evidence" maxLength={1000} required/></label>;
export default function PaymentPanel({role,projects,fail}:{role:string;projects:Row[];fail:(e:unknown)=>void}) {
  const[project,setProject]=useState(''),[rows,setRows]=useState<Row[]>([]),[detail,setDetail]=useState<Row|null>(null),[notice,setNotice]=useState('');
  const pending=useRef(new Map<string,string>()),manage=['staff','admin'].includes(role);
  const refresh=useCallback(async()=>{try{setRows(await api('payments'+(project?'?project='+encodeURIComponent(project):'')));}catch(e){setRows([]);fail(e);}},[project,fail]);
  useEffect(()=>{setRows([]);setDetail(null);setNotice('');void refresh();},[refresh]);
  async function open(id:string,guard=true){if(guard&&!requestFormLeave())return;try{setDetail(await api('payments/'+id));}catch(e){setDetail(null);fail(e);}}
  const item=detail?.item as Row|undefined,document=detail?.document as Row|undefined;
  const payments=(detail?.payments??[]) as Row[],refunds=(detail?.refunds??[]) as Row[],attempts=(detail?.attempts??[]) as Row[];
  async function mutate(path:string,data:Row) {
    if(!item)return false;
    try {
      const payload={...data,caseId:item.case_id,projectId:item.project_id,version:item.version},key=JSON.stringify({path,payload});
      let requestId=pending.current.get(key);if(!requestId){requestId=crypto.randomUUID();pending.current.set(key,requestId);}
      await api(path,{...payload,requestId});pending.current.delete(key);setNotice('기록했습니다. 실제 송금이나 대학 ERP 자동 상신은 수행하지 않습니다.');
      await open(s(item.case_id),false);await refresh();return true;
    }catch(e){fail(e);return false;}
  }
  return <section><h1>실청구·지급</h1><p>내부 승인 · 대학 ERP 실청구 · 실제 지급을 구분합니다. 지급·공제·실수령은 근거를 확인해 수동 기록하며 세율을 자동 계산하지 않습니다.</p>
    <label>과제·비교과<select value={project} onChange={e=>{if(requestFormLeave())setProject(e.target.value);}}><option value="">조회 가능 전체</option>{projects.map(p=><option key={s(p.id)} value={s(p.id)}>{s(p.name)}</option>)}</select></label><button onClick={()=>void refresh()}>새로고침</button>
    <p role="status">{notice}</p><div className="budget-table"><table><thead><tr><th>업무</th><th>과제·비교과</th><th>승인 신청금액</th><th>누적 지급 총액</th><th>상세</th></tr></thead><tbody>{rows.map(row=><tr key={s(row.case_id)}><td>{s(row.title)}</td><td>{s(row.project_name)}</td><td>{money(row.amount)}</td><td>{money(row.paid_amount)}</td><td><button onClick={()=>void open(s(row.case_id))}>상세 보기</button></td></tr>)}</tbody></table></div>
    {!rows.length&&<p>조회 가능한 내부 승인 신청·지급 기록이 없습니다.</p>}
    {item&&<article className="detail"><h2>{s(item.title)}</h2><p>{s(item.project_name)} · 버전 {s(item.version)} · {detail?.closed?'마감':'진행 중'}</p>
      <p>신청 {money(item.amount)} / 누적 지급 총액 {money(item.paid_amount)}. 지급 총액은 환입으로 감소하지 않으며 환입을 별도 표시합니다.</p>
      <h3>대학 ERP 수동 처리 이력</h3><p>연결 문서: {s(document?.document_number)||'미등록'}. 초기 범위는 신청 한 건과 문서 한 건의 연결입니다.</p>
      <ul>{attempts.map(a=><li key={s(a.id)}>{day(a.occurred_on)} · {externalAttemptKinds[s(a.kind) as keyof typeof externalAttemptKinds]} · {s(a.evidence)} · {s(a.reason)}</li>)}</ul>
      {manage&&!detail?.closed&&<details><summary>실청구·반려·재상신 사실 기록</summary><Form key={'external'+s(item.version)} label="실청구 사실 기록" send={f=>mutate('external-claims',f)}>
        <label>처리<select name="action" aria-label="처리">{Object.entries(externalAttemptKinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>대학 ERP 문서번호<input name="documentNumber" defaultValue={s(document?.document_number)} readOnly={!!document} required maxLength={200}/></label><label>처리일<input name="occurredOn" type="date" required/></label><Evidence/>
      </Form></details>}
      <h3>실제 지급 이력</h3><div className="budget-table"><table><thead><tr><th>지급일</th><th>총액</th><th>공제</th><th>실수령</th><th>근거·사유</th></tr></thead><tbody>{payments.map(p=><tr key={s(p.id)}><td>{day(p.paid_on)}</td><td>{money(p.gross_amount)}</td><td>{money(p.withheld_amount)}</td><td>{money(p.net_amount)}</td><td>{s(p.evidence)} · {s(p.reason)}</td></tr>)}</tbody></table></div>
      {manage&&!detail?.closed&&<details><summary>부분·실제 지급 기록</summary><Form key={'pay'+s(item.version)} label="실제 지급 기록" send={f=>mutate('payments',{...f,action:'pay'})}>
        <label>실제 지급일<input name="paidOn" type="date" required/></label><label>지급 총액(원)<input name="grossAmount" inputMode="numeric" pattern="[1-9][0-9]*" required/></label><label>공제 금액(원)<input name="withheldAmount" inputMode="numeric" pattern="0|[1-9][0-9]*" required/></label><label>실수령액(원)<input name="netAmount" inputMode="numeric" pattern="0|[1-9][0-9]*" required/></label><p>총액 = 공제 + 실수령. 지급은 신청 차감액에서 다시 차감하지 않습니다.</p><Evidence/>
      </Form></details>}
      <h3>환입 및 예산복원</h3><ul>{refunds.map(r=><li key={s(r.id)}>{day(r.refunded_on)} · {money(r.amount)} · {r.restored_on?'예산복원 확인 '+day(r.restored_on):'복원 보류'} · {s(r.evidence)} · {s(r.reason)}</li>)}</ul>
      <p>실제 환입과 예산복원은 별개입니다. 원사용 연차·사용기간 내 명시적 확인 때만 복원하며 연차를 넘는 환입은 사실만 기록하고 복원을 보류합니다.</p>
      {manage&&!detail?.closed&&payments.length>0&&<details><summary>실제 환입 기록</summary><Form key={'refund'+s(item.version)} label="환입 사실 기록" send={f=>mutate('payments',{...f,action:'refund',restoreBudget:f.restoreBudget==='on'})}>
        <label>원 지급<select name="paymentId" aria-label="원 지급" required>{payments.map(p=><option key={s(p.id)} value={s(p.id)}>{day(p.paid_on)} · {money(p.gross_amount)}</option>)}</select></label><label>환입 금액(원)<input name="amount" inputMode="numeric" pattern="[1-9][0-9]*" required/></label><label>실제 환입일<input name="refundedOn" type="date" required/></label><Evidence/>
        <label><input name="restoreBudget" type="checkbox"/>같은 사용연차·기간의 예산복원을 명시적으로 확인합니다.</label><label>예산복원 확인일<input name="restoredOn" type="date"/></label>
      </Form></details>}
      {manage&&!detail?.closed&&refunds.some(r=>!r.restored_on)&&<details><summary>보류 환입의 동일 연차 복원 확인</summary><Form key={'restore'+s(item.version)} label="예산복원 확인" send={f=>mutate('payments',{...f,action:'restore-refund'})}>
        <label>환입 기록<select name="refundId" aria-label="환입 기록" required>{refunds.filter(r=>!r.restored_on).map(r=><option key={s(r.id)} value={s(r.id)}>{day(r.refunded_on)} · {money(r.amount)}</option>)}</select></label><label>확인일<input name="restoredOn" type="date" required/></label>
      </Form></details>}
      <h3>마감·재개방 이력</h3><ul>{((detail?.settlements??[]) as Row[]).map(e=><li key={s(e.id)}>{s(e.created_at)} · {e.action==='close'?'마감':'재개방'} · {s(e.reason)}</li>)}</ul>
      {manage&&<Form key={'settle'+s(item.version)} label={detail?.closed?'사유를 남기고 재개방':'정합성 확인 후 마감'} send={f=>mutate('settlements',{...f,action:detail?.closed?'reopen':'close'})}><p>마감에는 내부 승인·신청금액 전액 지급·지급 합계 일치·미복원 환입 없음·반려 미해결 없음이 필요합니다.</p></Form>}
      <button onClick={()=>{if(requestFormLeave())setDetail(null);}}>상세 닫기</button>
    </article>}
  </section>;
}
