'use client';
import { useCallback,useEffect,useState } from 'react';
import { expenseTypes } from '../lib/expense.ts';
import { detailFields,documentLabels } from '../lib/application.ts';
import { formSaved,requestFormLeave } from './form-state.ts';

type Row=Record<string,any>;
const s=(v:unknown)=>String(v??'');
const states:Record<string,string>={draft:'초안',submitted:'신청',reviewing:'검토 중',supplement:'보완 요청',approved:'내부 승인'};
async function api(path:string,data?:Row){const response=await fetch('/api/erp/'+path,{method:data?'POST':'GET',cache:'no-store',credentials:'same-origin',
  headers:data?{'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined});
  const out=await response.json();if(!response.ok)throw new Error(out.error?.code??'UNAVAILABLE');return out;}
const fmt=(n:unknown)=>n===null||n===undefined?'미입력':BigInt(s(n)).toLocaleString('ko-KR');

export default function ApplicationPanel({role,fail,initialId}:{role:string;fail:(e:unknown)=>void;initialId?:string}){
  const [rows,setRows]=useState<Row[]>([]),[work,setWork]=useState<Row[]>([]),[policies,setPolicies]=useState<Row[]>([]),[lines,setLines]=useState<Row[]>([]);
  const [detail,setDetail]=useState<Row|null>(null),[type,setType]=useState('office'),[workId,setWorkId]=useState(''),[query,setQuery]=useState('');
  const [tab,setTab]=useState('basic'),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [items,setItems]=useState<Row[]>([]);
  const manage=role==='staff'||role==='admin',write=role!=='principal_investigator',item=detail?.item,data=detail?.data??{};
  const selectedWork=work.find(w=>w.id===workId),projectId=item?.projectId??selectedWork?.project_id;
  const refresh=useCallback(async()=>{const [r,w,p]=await Promise.all([api('applications?q='+encodeURIComponent(query)),api('work'),api('expense-policies')]);setRows(r);setWork(w);setPolicies(p);},[query]);
  useEffect(()=>{void refresh().catch(fail);},[refresh,fail]);
  useEffect(()=>{setItems(detail?.data?.items??[]);},[detail]);
  useEffect(()=>{let live=true;if(initialId)void api('applications/'+initialId).then(result=>{if(live){setDetail(result);setType(result.data.type);setWorkId(result.item.workId);}}).catch(e=>{if(live)fail(e);});return()=>{live=false;};},[initialId,fail]);
  useEffect(()=>{let live=true;setLines([]);if(projectId)void api('budgets?project='+projectId).then(v=>{if(live)setLines(v);}).catch(fail);return()=>{live=false;};},[projectId,fail]);
  async function open(id:string){const result=await api('applications/'+id);setDetail(result);setType(result.data.type);setWorkId(result.item.workId);}
  function choose(id:string){if(requestFormLeave())void open(id).catch(fail);}
  function changeTab(next:string){if(next===tab||requestFormLeave())setTab(next);}
  async function mutate(action:string,extra:Row={},form?:HTMLFormElement){setBusy(true);setNotice('');try{
    const out=await api('applications',{action,requestId:crypto.randomUUID(),reason,...(item?{draftId:item.draftId,version:item.version,draftVersion:item.draftVersion}:{}),...extra});
    if(form)formSaved(form);await refresh();await open(out.draftId??item.draftId);setNotice('처리했습니다.');setReason('');
  }catch(e){fail(e);}finally{setBusy(false);}}
  function reset(){if(!requestFormLeave())return;setDetail(null);setItems([]);setWorkId('');setType('office');setTab('basic');setNotice('');setReason('');}
  const canEdit=write&&(!item||['draft','supplement'].includes(item.state));
  return <section className="applications-panel"><div className="panel-heading"><div><p className="eyebrow">지출 관리</p><h1>지출 신청·증빙</h1></div>{write&&<button onClick={reset}>새 초안 작성</button>}</div>
    <p>초안은 예산을 차감하지 않습니다. 신청 시 차감하며 내부 승인과 실제 지급은 각각 기록합니다. 기준 미설정·미확인·초과 건은 제출과 승인이 제한됩니다.</p>
    <form className="search" onSubmit={e=>{e.preventDefault();void refresh().catch(fail);}}><label>제목 검색<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label><button>조회</button></form>
    <p role="status">{notice}</p><div className="budget-table"><table><thead><tr><th>과제·비교과</th><th>제목</th><th>유형</th><th>금액</th><th>상태</th><th>상세</th></tr></thead><tbody>{rows.map(row=><tr key={row.draftId}><td>{row.projectName}</td><td>{row.title||'제목 미입력'}</td><td>{expenseTypes[row.type as keyof typeof expenseTypes]}</td><td>{fmt(row.amount)}</td><td>{states[row.state]??row.state}</td><td><button onClick={()=>choose(row.draftId)}>상세 보기</button></td></tr>)}</tbody></table></div>{!rows.length&&<p>조회 가능한 신청·초안이 없습니다.</p>}
    {(item||write)&&<article className="detail"><h2>{item?`${data.title||'제목 미입력'} · ${states[item.state]??item.state}`:'새 초안'}</h2>
      <nav aria-label="신청 상세"><button aria-current={tab==='basic'?'page':undefined} onClick={()=>changeTab('basic')}>기본정보</button><button disabled={!item} aria-current={tab==='files'?'page':undefined} onClick={()=>changeTab('files')}>첨부·검토</button><button disabled={!item} aria-current={tab==='history'?'page':undefined} onClick={()=>changeTab('history')}>제출본·이력</button></nav>
      {tab==='basic'&&<>{!canEdit?<dl><dt>목적·내용</dt><dd>{data.purpose}</dd><dt>사용일</dt><dd>{data.useDate}</dd><dt>금액</dt><dd>{fmt(data.amount)}원</dd><dt>산출근거</dt><dd>{data.calculation}</dd>{Object.entries(data.details??{}).filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{detailFields[data.type as keyof typeof detailFields]?.find(([key])=>key===k)?.[1]??({quantity:'수량',days:'일수',people:'인원',unitPrice:'단가'} as Row)[k]??k}</dt><dd>{s(v)}</dd></div>)}</dl>:<form className="editor" key={s(item?.draftId)+':'+s(item?.draftVersion)+':'+type} onSubmit={e=>{
        e.preventDefault();const form=e.currentTarget,f=new FormData(form),values=Object.fromEntries(f),details:Row={};for(const [key,value]of Object.entries(values))if(key.startsWith('detail.'))details[key.slice(7)]=value;
        void mutate('save',{...values,...(!item?{projectId,workId}:{}),type,details,documents:data.documents??{},items},form);
      }}>
        <label>배정 업무<select aria-label="배정 업무" value={workId} disabled={!!item} onChange={e=>setWorkId(e.target.value)} required><option value="">선택</option>{work.map(w=><option key={w.id} value={w.id}>{w.project_name} · {w.title}</option>)}</select></label>
        <label>유형<select aria-label="유형" value={type} disabled={item?.state==='supplement'} onChange={e=>setType(e.target.value)}>{Object.entries(expenseTypes).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
        <label>제목<input name="title" defaultValue={data.title} maxLength={200}/></label>
        <label>예산항목<select aria-label="예산항목" name="lineId" defaultValue={detail?.lineId??''} disabled={!!item?.id}><option value="">미선택</option>{lines.map(line=><option key={line.id} value={line.id}>{line.internal_label} · 가용 {fmt(line.available_amount)}원</option>)}</select>{!!item?.id&&<input type="hidden" name="lineId" value={detail?.lineId??''}/>}</label>
        <label>날짜 구분<select aria-label="날짜 구분" name="dateKind" defaultValue={data.dateKind??'planned'}><option value="planned">예정</option><option value="actual">실제</option></select></label>
        <label>사용일<input name="useDate" type="date" defaultValue={data.useDate??''}/></label><label>금액 (원)<input name="amount" inputMode="numeric" defaultValue={data.amount??''} readOnly={item?.state==='supplement'}/></label>
        <label>목적·내용<textarea name="purpose" defaultValue={data.purpose} maxLength={5000}/></label><label>금액 산출근거<textarea name="calculation" defaultValue={data.calculation} maxLength={2000}/></label>
        {detailFields[type as keyof typeof detailFields].map(([key,label])=><label key={key}>{label}<input name={'detail.'+key} defaultValue={data.details?.[key]??''} type={['periodStart','periodEnd'].includes(key)?'date':'text'} maxLength={1000}/></label>)}
        {[['quantity','수량'],['days','일수'],['people','인원'],['hours','시간'],['unitPrice','단가 (원)']].map(([key,label])=><label key={key}>{label}<input name={'detail.'+key} inputMode="numeric" defaultValue={data.details?.[key]??(key==='unitPrice'?'':'1')} readOnly={item?.state==='supplement'}/></label>)}
        <fieldset><legend>같은 예산항목의 산출내역</legend><p>여러 품목을 기재하면 수량×단가 합계가 신청금액과 같아야 합니다. 다른 예산항목을 함께 차감하지 않습니다.</p>{items.map((row,index)=><div key={index} className="application-cost-row">{[['label','품목·내역'],['quantity','수량'],['unitPrice','단가 (원)']].map(([key,label])=><label key={key}>{label}<input value={s(row[key])} readOnly={item?.state==='supplement'} maxLength={key==='label'?200:30} onChange={e=>setItems(old=>old.map((v,i)=>i===index?{...v,[key]:e.target.value}:v))}/></label>)}{item?.state!=='supplement'&&<button type="button" onClick={()=>setItems(old=>old.filter((_,i)=>i!==index))}>내역 제거</button>}</div>)}{item?.state!=='supplement'&&<button type="button" disabled={items.length>=50} onClick={()=>setItems(old=>[...old,{label:'',quantity:'1',unitPrice:''}])}>산출내역 추가</button>}</fieldset>
        <label>조건부 자료·적용 사유<textarea name="detail.conditionalEvidence" defaultValue={data.details?.conditionalEvidence??''} maxLength={2000}/></label>
        <label>적용 기준<select aria-label="적용 기준" name="policyVersionId" defaultValue={detail?.policyVersionId??''} disabled={item?.state==='supplement'}><option value="">미설정·제출 불가</option>{policies.filter(p=>p.type_key===type).map(p=><option key={p.id} value={p.id}>{p.subtype||'공통'} · 버전 {p.version} · {p.data.status==='verified'?'확인 완료':'확인 필요'}</option>)}</select>{item?.state==='supplement'&&<input type="hidden" name="policyVersionId" value={detail?.policyVersionId??''}/>}</label>
        <p>제출 시 신청일에 적용되는 기준을 확정해 보존합니다. 영업일은 주말과 기준에 명시한 휴일만 제외하며 공휴일을 임의로 추정하지 않습니다.</p>
        <label>저장 사유<input name="reason" required maxLength={1000}/></label><button disabled={busy||!workId}>초안·보완 저장</button>
      </form>}</>}
      {tab==='files'&&item&&<><h3>현재 첨부와 서류 역할</h3><p>같은 파일을 여러 서류 역할에 연결할 수 있습니다. 교체 후에는 새 파일의 역할을 다시 확인해 저장하세요.</p>
        <form className="editor" key={'docs'+item.draftVersion} onSubmit={e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),documents:Row={};for(const file of detail.files)documents[file.id]=f.getAll('document.'+file.id);
          void mutate('save',{...data,lineId:detail.lineId,policyVersionId:detail.policyVersionId,documents,reason:f.get('reason')},form);}}>
          {detail.files.map((file:Row)=><fieldset key={file.id}><legend><a href={'/api/erp/expense-files/'+file.id}>{file.filename}</a> · {file.label} · 버전 {file.version}</legend>{Object.entries(documentLabels).map(([key,label])=><label key={key}><input type="checkbox" name={'document.'+file.id} value={key} disabled={!canEdit} defaultChecked={data.documents?.[file.id]?.includes(key)}/>{label}</label>)}</fieldset>)}
          {!detail.files.length&&<p>등록된 첨부가 없습니다.</p>}{canEdit&&<><label>분류 저장 사유<input name="reason" required maxLength={1000}/></label><button disabled={busy}>서류 역할 저장</button></>}
        </form>
        {canEdit&&<form className="editor" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),file=f.get('upload') as File;if(!file?.size||file.size>5242880){setNotice('파일은 1byte 이상 5MiB 이하입니다.');return;}setBusy(true);try{
          const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
          await api('expense-files',{action:'attach',requestId:crypto.randomUUID(),id:item.draftId,version:item.draftVersion,reason:f.get('reason'),slotId:f.get('slotId')||undefined,file:{name:file.name,label:f.get('label'),content:btoa(raw)}});formSaved(form);await open(item.draftId);setNotice('첨부했습니다. 서류 역할을 확인해 저장하세요.');
        }catch(err){fail(err);}finally{setBusy(false);}}}>
          <label>추가·교체<select name="slotId"><option value="">새 첨부</option>{detail.files.map((file:Row)=><option key={file.slot_id} value={file.slot_id}>{file.label} 교체</option>)}</select></label><label>자료 설명<input name="label" required maxLength={200}/></label>
          <label>파일<input name="upload" type="file" accept=".pdf,.jpg,.jpeg,.png,.hwp,.hwpx,.doc,.docx,.xls,.xlsx" required/></label><label>첨부 사유<input name="reason" required maxLength={1000}/></label><button disabled={busy}>비공개 첨부 저장</button>
        </form>}
        <h3>서류별 검토 의견</h3><ul>{detail.notes.map((note:Row)=><li key={note.id}>{documentLabels[note.document_kind]??note.document_kind} · {{missing:'보완 필요',accepted:'확인',note:'의견'}[note.outcome as 'note']} · {note.note}</li>)}</ul>
        {manage&&['reviewing','supplement'].includes(item.state)&&<form className="editor" onSubmit={e=>{e.preventDefault();const form=e.currentTarget,f=Object.fromEntries(new FormData(form));void mutate('review-note',f,form);}}>
          <label>서류 구분<select name="documentKind">{Object.entries(documentLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>처리<select name="outcome"><option value="note">의견</option><option value="missing">보완 필요</option><option value="accepted">확인</option></select></label><label>의견<textarea name="note" required maxLength={2000}/></label><label>검토 사유<input name="reason" required maxLength={1000}/></label><button disabled={busy}>의견 기록</button>
        </form>}
      </>}
      {tab==='history'&&item&&<><h3>제출본·기준·첨부 보존</h3>{detail.submissions.map((submission:Row)=><details key={submission.id}><summary>제출본 {BigInt(submission.version).toString()} · 신청일 기준 {s(submission.applicable_on).slice(0,10)}</summary><p>{submission.data.title} · {fmt(submission.data.amount)}원</p><p>기준: {submission.policy_snapshot.source} / {submission.policy_snapshot.sourceVersion}</p><ul>{submission.files_snapshot.map((file:Row)=><li key={file.id}><a href={'/api/erp/expense-files/'+file.id}>{file.filename}</a> · 버전 {file.version} · {file.documentKinds.map((kind:string)=>documentLabels[kind]).join(', ')}</li>)}</ul></details>)}
        <h3>처리 이력</h3><ul>{detail.history.map((h:Row,i:number)=><li key={i}>{new Date(h.created_at).toLocaleString('ko-KR')} · {h.action} · {h.reason}</li>)}</ul><h3>초안 수정 이력</h3><ul>{detail.draftHistory.map((h:Row)=><li key={h.id}>버전 {h.version} · {h.data.title||'제목 미입력'} · {h.reason}</li>)}</ul>
      </>}
      {item&&write&&<div className="application-actions"><label>처리 사유<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/></label>
        {item.state==='draft'&&<button disabled={busy||!reason} onClick={()=>void mutate('submit')}>신청 제출</button>}
        {item.state==='submitted'&&!manage&&<button disabled={busy||!reason} onClick={()=>void mutate('withdraw')}>신청 회수</button>}
        {item.state==='supplement'&&<button disabled={busy||!reason} onClick={()=>void mutate('resubmit')}>보완 제출</button>}
        {manage&&item.state==='submitted'&&<button disabled={busy||!reason} onClick={()=>void mutate('start')}>처리 시작</button>}
        {manage&&item.state==='reviewing'&&<><button disabled={busy||!reason} onClick={()=>void mutate('supplement')}>보완 요청</button><button disabled={busy||!reason} onClick={()=>void mutate('approve')}>내부 승인</button></>}
        {manage&&['submitted','reviewing','supplement'].includes(item.state)&&<button disabled={busy||!reason} onClick={()=>void mutate('reject')}>반려·복원</button>}
        {manage&&item.state!=='draft'&&<button disabled={busy||!reason} onClick={()=>void mutate('revise')}>취소·복원 후 수정</button>}
      </div>}
    </article>}
  </section>;
}
