'use client';
import { useCallback,useEffect,useState } from 'react';
import { expenseTypes } from '../lib/expense.ts';
type Row=Record<string,unknown>;
const s=(v:unknown)=>String(v??'');
async function api(path:string,data?:Row) {
  const r=await fetch('/api/erp/'+path,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',
    headers:data?{'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined});
  const out=await r.json();if(!r.ok)throw new Error(out.error?.code??'UNAVAILABLE');return out;
}
function Field({name,label,value,type='text',required=false,max=200}:{name:string;label:string;value?:unknown;type?:string;required?:boolean;max?:number}) {
  return <label>{label}{type==='textarea'?<textarea name={name} defaultValue={s(value)} required={required} maxLength={max}/>:
    <input name={name} type={type} defaultValue={s(value)} required={required} maxLength={max}/>}</label>;
}
const numericFields=new Set(['amount','rate','caseLimit','periodLimit','deadlineDays']);
export default function ExpensePanel({role,fail}:{role:string;fail:(e:unknown)=>void}) {
  const [rows,setRows]=useState<Row[]>([]),[work,setWork]=useState<Row[]>([]),[policies,setPolicies]=useState<Row[]>([]);
  const [detail,setDetail]=useState<Row|null>(null),[policy,setPolicy]=useState<Row|null>(null),[history,setHistory]=useState<Row[]>([]);
  const [tab,setTab]=useState('drafts'),[query,setQuery]=useState(''),[workId,setWorkId]=useState(''),[lines,setLines]=useState<Row[]>([]);
  const [type,setType]=useState('office'),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const write=role!=='principal_investigator',manage=['staff','admin'].includes(role);
  const item=detail?.item as Row|undefined,data=item?.data as Row|undefined;
  const project=s(work.find(w=>w.id===workId)?.project_id);
  const refresh=useCallback(async()=>{
    const [r,w,p]=await Promise.all([api('expense-drafts?q='+encodeURIComponent(query)),api('work'),api('expense-policies')]);
    setRows(r);setWork(w);setPolicies(p);
  },[query]);
  useEffect(()=>{void refresh().catch(fail);},[refresh,fail]);
  useEffect(()=>{let valid=true;setLines([]);if(project)void api('budgets?project='+project).then(r=>{if(valid)setLines(r);}).catch(fail);return()=>{valid=false;};},[project,fail]);
  async function open(id:string){const d=await api('expense-drafts/'+id);setDetail(d);setWorkId(d.item.work_id);setType(d.item.data.type);}
  function reset(){setDetail(null);setWorkId('');setType('office');setNotice('');}
  async function mutate(path:string,payload:Row) {
    setBusy(true);setNotice('');
    try {
      const result=await api(path,{...payload,requestId:crypto.randomUUID()});
      await refresh();
      if(path!=='expense-policies')await open(result.id);
      else {setPolicy(null);setHistory([]);}
      setNotice('저장했습니다. 신청 제출·승인은 아직 제공하지 않습니다.');
    } catch(e) {fail(e);}
    finally{setBusy(false);}
  }
  const formData=(form:HTMLFormElement)=>Object.fromEntries(new FormData(form));
  const policyData=(policy?.data??{}) as Row;
  const files=(detail?.files??[]) as Row[];
  const latest=new Map<string,Row>();for(const f of files){const old=latest.get(s(f.slot_id));if(!old||BigInt(s(f.version))>BigInt(s(old.version)))latest.set(s(f.slot_id),f);}
  return <section aria-label="지출 초안과 기준 설정"><h1>지출 초안·증빙</h1>
    <p className="warning">현재는 초안 저장과 첨부만 가능합니다. 예산은 차감되지 않으며 신청 제출·승인은 보류 중입니다. 유형별 필수서류도 아직 적용하지 않습니다.</p>
    <nav aria-label="지출 메뉴"><button onClick={()=>setTab('drafts')}>초안 관리</button><button onClick={()=>setTab('policies')}>{manage?'단가·한도 설정':'단가·한도 기준'}</button></nav>
    <p role="status">{notice}</p>
    {tab==='drafts'&&<>
      <form className="search" onSubmit={e=>{e.preventDefault();void refresh().catch(fail);}}><label>초안 제목 검색<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label><button>검색</button></form>
      <p>조회 가능한 초안 {rows.length}건 (최대 1,000건)</p>
      <ul className="items">{rows.map(r=><li key={s(r.id)}><button onClick={()=>void open(s(r.id)).catch(fail)}>{s((r.data as Row).title)||'제목 없는 초안'}</button><span>{s(r.work_title)} · 초안</span></li>)}</ul>
      {write&&<button onClick={reset}>새 초안</button>}
      {item&&<article className="detail"><h2>{s(data?.title)||'제목 없는 초안'}</h2><p>{s(item.work_title)} · 버전 {s(item.version)}</p>
        <p>{expenseTypes[s(data?.type) as keyof typeof expenseTypes]} · {s(data?.amount)||'금액 미입력'}원 · {data?.dateKind==='actual'?'실제 사용일':'사용 예정일'} {s(data?.useDate)}</p>
        <p className="prewrap">{s(data?.purpose)}</p><p className="prewrap">산출근거: {s(data?.calculation)}</p>
        <details><summary>수정 이력</summary><ul>{((detail?.history??[]) as Row[]).map(v=><li key={s(v.id)}>
          버전 {s(v.version)} · {new Date(s(v.created_at)).toLocaleString('ko-KR')} · 작성자 {s(v.actor_id)} · {s(v.reason)}
          <pre>{JSON.stringify(v.data,null,2)}</pre></li>)}</ul></details>
      </article>}
      {write&&<form className="editor" key={s(item?.id)+s(item?.version)} onSubmit={e=>{
        e.preventDefault();const f=formData(e.currentTarget);
        void mutate('expense-drafts',{...f,type,action:item?'edit':'create',...(item?{id:item.id,version:item.version}:{projectId:project,workId})});
      }}>
        <h2>{item?'초안 수정':'초안 작성'}</h2>
        <label>배정 업무<select aria-label="배정 업무" required value={workId} disabled={!!item} onChange={e=>setWorkId(e.target.value)}><option value="">선택</option>{work.map(w=><option key={s(w.id)} value={s(w.id)}>{s(w.project_name)} · {s(w.title)}</option>)}</select></label>
        <label>지출 유형<select aria-label="지출 유형" value={type} onChange={e=>setType(e.target.value)}>{Object.entries(expenseTypes).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label>예산항목 (초안에서는 미선택 가능)<select aria-label="예산항목 (초안에서는 미선택 가능)" name="lineId" key={project+':'+lines.length+':'+s(item?.version)} defaultValue={s(item?.budget_line_id)}><option value="">미선택</option>{lines.map(l=><option key={s(l.id)} value={s(l.id)}>{s(l.internal_label)} · 가용 {s(l.available_amount)}원</option>)}</select></label>
        <Field name="title" label="제목" value={data?.title}/>
        <label>날짜 구분<select aria-label="날짜 구분" name="dateKind" defaultValue={s(data?.dateKind)||'planned'}><option value="planned">예정</option><option value="actual">실제</option></select></label>
        <Field name="useDate" label="사용일 (초안 기록용)" type="date" value={data?.useDate}/>
        <Field name="amount" label="금액 (원 단위 정수, 초안에서는 미입력 가능)" value={data?.amount}/>
        <Field name="purpose" label="목적·내용" type="textarea" value={data?.purpose} max={5000}/>
        <Field name="calculation" label="금액 산출근거" type="textarea" value={data?.calculation} max={2000}/>
        <label>참고 기준 버전 (자동 판정 없음)<select aria-label="참고 기준 버전 (자동 판정 없음)" name="policyVersionId" defaultValue={s(item?.policy_version_id)} key={type+':'+s(item?.version)}>
          <option value="">미선택·확인 필요</option>
          {!!item?.policy_version_id&&data?.type===type&&!policies.some(p=>p.id===item.policy_version_id)&&<option value={s(item.policy_version_id)}>기존에 선택한 기준 버전 유지</option>}
          {policies.filter(p=>p.type_key===type&&(p.data as Row).status==='verified').map(p=><option key={s(p.id)} value={s(p.id)}>{s(p.subtype)||'공통'} · 버전 {s(p.version)}</option>)}
        </select></label>
        <Field name="reason" label="저장·수정 사유" required max={1000}/><button disabled={busy||!workId}>초안 저장</button>
      </form>}
      {item&&<article><h2>비공개 첨부</h2><p>현재 첨부 최대 10개·합계 20MiB, 파일당 5MiB. 교체 전 파일도 이력으로 보존합니다. ZIP은 지원하지 않습니다.</p>
        <ul>{Array.from(latest.values()).map(f=><li key={s(f.id)}>{s(f.label)} · <a href={'/api/erp/expense-files/'+s(f.id)}>{s(f.filename)}</a> ({s(f.size)} bytes)</li>)}</ul>
        <details><summary>이전 첨부 포함 전체 이력</summary><ul>{files.map(f=><li key={s(f.id)}>{s(f.label)} · 버전 {s(f.version)} · <a href={'/api/erp/expense-files/'+s(f.id)}>{s(f.filename)}</a> · {s(f.reason)}</li>)}</ul></details>
        {write&&<form className="editor" key={'file'+s(item.version)} onSubmit={async e=>{
          e.preventDefault();const f=new FormData(e.currentTarget),file=f.get('upload') as File;
          if(!file?.size||file.size>5242880){setNotice('파일 크기는 1byte 이상 5MiB 이하로 선택해 주세요.');return;}
          setBusy(true);
          try {
            const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
            for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            await mutate('expense-files',{action:'attach',id:item.id,version:item.version,slotId:f.get('slotId')||undefined,reason:f.get('reason'),
              file:{name:file.name,label:f.get('label'),content:btoa(binary)}});
          }catch(e){fail(e);}finally{setBusy(false);}
        }}>
          <label>추가·교체 대상<select aria-label="추가·교체 대상" name="slotId"><option value="">새 첨부 추가</option>{Array.from(latest.values()).map(f=><option key={s(f.slot_id)} value={s(f.slot_id)}>{s(f.label)} · {s(f.filename)} 교체</option>)}</select></label>
          <Field name="label" label="자료 설명 (필수서류 자동 판정 없음)" required/>
          <label>파일<input name="upload" type="file" accept=".pdf,.jpg,.jpeg,.png,.hwp,.hwpx,.doc,.docx,.xls,.xlsx" required/></label>
          <Field name="reason" label="첨부·교체 사유" required max={1000}/><button disabled={busy}>첨부 저장</button>
        </form>}
      </article>}
    </>}
    {tab==='policies'&&<>
      <h2>{manage?'단가·한도 설정':'단가·한도 기준'}</h2><p>빈 값은 확인 필요입니다. 확인 완료는 근거를 확인했다는 기록이며 신청 제출·승인을 활성화하지 않습니다.</p>
      <ul className="items">{policies.map(p=><li key={s(p.id)}><button onClick={async()=>{
        setPolicy(p);setHistory([]);if(role!=='researcher')try{setHistory(await api('expense-policy-history?type='+s(p.type_key)+'&subtype='+encodeURIComponent(s(p.subtype))));}catch(e){fail(e);}
      }}>{expenseTypes[s(p.type_key) as keyof typeof expenseTypes]} · {s(p.subtype)||'공통'} · 버전 {s(p.version)} · {(p.data as Row).status==='verified'?'확인 완료':'확인 필요'}</button></li>)}</ul>
      {!policies.length&&<p>등록된 조회 가능 기준이 없습니다. 제한 없음이라는 뜻은 아닙니다.</p>}
      {policy&&<article className="detail"><h3>선택한 기준</h3><dl>{Object.entries(policyData).map(([k,v])=><div key={k}><dt>{policyLabels[k]??k}</dt><dd>{s(v)||'확인 필요'}</dd></div>)}</dl>
        {history.length>0&&<details><summary>기준 변경 이력</summary>{history.map(h=><div key={s(h.id)}>버전 {s(h.version)} · {s(h.reason)}<pre>{JSON.stringify(h.data,null,2)}</pre></div>)}</details>}</article>}
      {manage&&<><button onClick={()=>{setPolicy(null);setHistory([]);}}>새 기준</button>
        <form className="editor" key={s(policy?.id)||'new-policy'} onSubmit={e=>{
          e.preventDefault();const f=formData(e.currentTarget);
          void mutate('expense-policies',{...f,action:'policy',type:policy?.type_key??f.type,subtype:policy?.subtype??f.subtype,version:policy?.version??''});
        }}>
          <label>유형<select aria-label="유형" name="type" defaultValue={s(policy?.type_key)||'office'} disabled={!!policy}>{Object.entries(expenseTypes).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          {!policy&&<Field name="subtype" label="세부 구분 (예: 국내, 업체)" />}
          <label>확인 상태<select aria-label="확인 상태" name="status" defaultValue={s(policyData.status)||'pending'}><option value="pending">확인 필요</option><option value="verified">확인 완료</option></select></label>
          {Object.entries(policyLabels).filter(([k])=>!['status','calendar'].includes(k)).map(([k,label])=><Field key={k} name={k} label={label+(numericFields.has(k)?' (정수)':'')} value={policyData[k]} type={['startsOn','endsOn'].includes(k)?'date':'text'} max={500}/>)}
          <label>기한 일수 기준<select aria-label="기한 일수 기준" name="calendar" defaultValue={s(policyData.calendar)}><option value="">확인 필요</option><option value="calendar">달력일</option><option value="business">영업일</option></select></label>
          <Field name="reason" label="기준 등록·변경 사유" required max={1000}/><button disabled={busy}>기준 버전 저장</button>
        </form></>}
    </>}
  </section>;
}
const policyLabels:Record<string,string>={status:'확인 상태',unit:'계산 단위',rate:'단가 (원)',caseLimit:'건별 한도 (원)',periodLimit:'기간별 한도 (원)',
  limitPeriod:'한도 집계 기간',deadlineEvent:'기한 기준 사건',deadlineDays:'기한 일수',calendar:'일수 기준',
  source:'근거 자료명',sourceVersion:'자료 버전',clause:'근거 항목',startsOn:'적용 시작일',endsOn:'적용 종료일'};
