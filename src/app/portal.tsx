'use client';
import { useCallback,useEffect,useRef,useState,type FormEvent } from 'react';

type Row=Record<string,unknown>;
type Session={id:string;email:string;role:string;expiresAt:string;idleExpiresAt:string;stepUpUntil:string|null;otpReady:boolean;serverTime:string};
const names:Record<string,string>={researcher:'연구원',principal_investigator:'과제책임자',staff:'담당자',admin:'관리자'};
const s=(value:unknown)=>value===null||value===undefined?'':String(value);
const when=(value:unknown)=>value?new Date(s(value)).toLocaleString('ko-KR'):'';
const errors:Record<string,string>={UNAUTHENTICATED:'로그인이 만료되었거나 계정 확인이 필요합니다.',FORBIDDEN:'권한 또는 추가 본인 확인을 확인해 주세요.',CONFLICT:'다른 변경이 있거나 현재 상태에서는 처리할 수 없습니다. 새로고침 후 확인해 주세요.',INVALID_INPUT:'필수 항목과 입력값을 확인해 주세요.',UNAVAILABLE:'서버 연결을 확인한 뒤 다시 시도해 주세요.'};
async function api(path:string,input?:Row){
  const r=await fetch(path,{cache:'no-store',credentials:'same-origin',...(input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{})});
  const data=await r.json();if(!r.ok)throw new Error(data?.error?.code??'UNAVAILABLE');return data;
}
type Field={name:string;label:string;value?:unknown;type?:string;options?:[string,string][];optional?:boolean};
function Editor({fields,submit,label='저장'}:{fields:Field[];submit:(data:Row)=>Promise<void>;label?:string}){
  const[busy,setBusy]=useState(false);
  async function send(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget;setBusy(true);try{await submit(Object.fromEntries(new FormData(form)));}finally{setBusy(false);}}
  return <form onSubmit={send} className="editor">{fields.map(f=><label key={f.name}>{f.label}{f.options?<select name={f.name} defaultValue={s(f.value)} required={!f.optional}>{f.optional&&<option value="">미배정</option>}{f.options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>:f.type==='textarea'?<textarea name={f.name} defaultValue={s(f.value)} maxLength={f.name==='description'?5000:1000} required={!f.optional}/>:<input name={f.name} type={f.type??'text'} defaultValue={s(f.value)} maxLength={f.name==='reason'?1000:254} required={!f.optional} autoComplete="off"/>}</label>)}<button disabled={busy}>{busy?'처리 중…':label}</button></form>;
}
const reason:Field={name:'reason',label:'등록·변경 사유',type:'textarea'};
export default function Portal(){
  const[user,setUser]=useState<Session|null>(null),[checking,setChecking]=useState(true),[tab,setTab]=useState('work'),[notice,setNotice]=useState('');
  const[projects,setProjects]=useState<Row[]>([]),[work,setWork]=useState<Row[]>([]),[accounts,setAccounts]=useState<Row[]>([]);
  const[detail,setDetail]=useState<Row|null>(null),[selected,setSelected]=useState<Row|null>(null),[query,setQuery]=useState(''),[otpSecret,setOtpSecret]=useState('');
  const[now,setNow]=useState(Date.now()),currentId=useRef(''),offset=useRef(0),lastTouch=useRef(0);
  const manage=!!user&&['staff','admin'].includes(user.role);
  const clear=useCallback(()=>{setUser(null);setProjects([]);setWork([]);setAccounts([]);setDetail(null);setSelected(null);setOtpSecret('');currentId.current='';},[]);
  const fail=useCallback((e:unknown)=>{const code=e instanceof Error?e.message:'UNAVAILABLE';setNotice(errors[code]??errors.UNAVAILABLE);if(code==='UNAUTHENTICATED')clear();},[clear]);
  const session=useCallback(async()=>{try{const a:Session=await api('/api/session');if(currentId.current&&currentId.current!==a.id){clear();location.reload();return;}currentId.current=a.id;offset.current=new Date(a.serverTime).getTime()-Date.now();setUser(a);}catch(e){clear();if(e instanceof Error&&e.message!=='UNAUTHENTICATED')fail(e);}finally{setChecking(false);}},[clear,fail]);
  const refresh=useCallback(async()=>{if(!currentId.current)return;try{
    const[p,w]=await Promise.all([api('/api/erp/projects'),api('/api/erp/work?q='+encodeURIComponent(query))]);setProjects(p);setWork(w);
    if(manage)setAccounts(await api('/api/erp/accounts'));
  }catch(e){fail(e);}},[query,manage,fail]);
  useEffect(()=>{void session();if(new URLSearchParams(location.search).get('login')==='failed'){setNotice('Google 로그인에 실패했습니다. 사전 등록·소유 확인·계정 활성 상태와 동시 접속 수를 확인해 주세요.');history.replaceState(null,'','/');}
    const timer=setInterval(()=>{setNow(Date.now());if(document.visibilityState==='visible')void session();},15000);
    const visibility=()=>{if(document.visibilityState==='hidden'){setChecking(true);setOtpSecret('');}else void session();};
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)location.reload();};
    const activity=(event:Event)=>{if(!event.isTrusted||!currentId.current||Date.now()-lastTouch.current<60000)return;lastTouch.current=Date.now();void api('/api/erp/activity',{}).then(session).catch(fail);};
    document.addEventListener('visibilitychange',visibility);window.addEventListener('pageshow',pageshow);window.addEventListener('pointerdown',activity);window.addEventListener('keydown',activity);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pageshow',pageshow);window.removeEventListener('pointerdown',activity);window.removeEventListener('keydown',activity);};
  },[session,fail]);
  useEffect(()=>{void refresh();},[user?.id,refresh]);
  useEffect(()=>{setDetail(null);setSelected(null);setOtpSecret('');},[tab]);
  async function change(path:string,data:Row){try{await api('/api/erp/'+path,{...data,requestId:crypto.randomUUID()});setNotice('처리했습니다.');setSelected(null);setDetail(null);await session();await refresh();}catch(e){fail(e);}}
  async function login(){try{const r=await api('/api/auth/google/start',{});clear();location.assign(r.url);}catch(e){fail(e);}}
  async function signout(all:boolean){try{await api('/api/erp/logout',{all});clear();location.replace('/');}catch(e){fail(e);}}
  async function open(kind:string,row:Row){try{setSelected(row);setDetail(await api('/api/erp/'+kind+'/'+s(row.id)));}catch(e){fail(e);}}
  const idle=user?Math.min(new Date(user.idleExpiresAt).getTime(),new Date(user.expiresAt).getTime())-(now+offset.current):0;
  const recent=!!user?.stepUpUntil&&new Date(user.stepUpUntil).getTime()>now+offset.current;
  const accountOptions=accounts.filter(a=>a.role==='researcher'&&a.active).map(a=>[s(a.id),s(a.display_name)+' · '+s(a.email)] as [string,string]);
  const projectFields:Field[]=[{name:'name',label:'과제·비교과 이름',value:selected?.name},{name:'kind',label:'유형',value:selected?.kind,options:[['research','과제'],['program','비교과']]},{name:'year',label:'사업연차 기준연도',type:'number',value:selected?.business_year??new Date().getFullYear()},reason];
  const workFields:Field[]=[{name:'title',label:'업무 이름',value:selected?.title},{name:'description',label:'업무 내용',type:'textarea',optional:true,value:selected?.description},{name:'assignedTo',label:'담당 연구원 (먼저 과제 참여자로 등록)',options:accountOptions,optional:true,value:selected?.assigned_to},reason];
  const historyRows=Array.isArray(detail?.history)?detail.history as Row[]:[];
  return <main className="portal"><header><a className="brand" href="/">BOOT ERP</a><span className="badge">로컬 시험</span>{user&&<span>{names[user.role]} · {user.email}</span>}</header>
    <div role="status" aria-live="polite" className="message">{notice}</div>
    {checking?<p>로그인 상태 확인 중…</p>:!user?<section className="intro"><p className="eyebrow">과제 · 비교과 업무 관리</p><h1>배정된 업무를<br/>한곳에서 확인하세요.</h1><p>사전 등록하고 이메일 소유 확인을 마친 계정만 이용할 수 있습니다.</p><button onClick={()=>void login()}>Google 계정으로 로그인</button><p>Google 계정 분실은 Google 복구 절차를 이용하고, ERP 계정 연결 문제는 담당자에게 문의하세요.</p></section>:<>
      <div className="toolbar"><button onClick={()=>void refresh()}>새로고침</button><button onClick={()=>void signout(false)}>로그아웃</button><button onClick={()=>void signout(true)}>전체 기기 로그아웃</button></div>
      {idle<=120000&&<div className="warning" role="alert">{idle<=0?'로그인 시간이 만료되었습니다.':'2분 이내에 로그인이 만료됩니다.'} <button onClick={()=>void api('/api/erp/activity',{}).then(session).catch(fail)}>계속 사용</button><span>최대 8시간은 연장되지 않습니다.</span></div>}
      <nav aria-label="업무 메뉴">{[['work','내 업무'],['projects','과제·비교과'],...(manage?[['accounts','계정 관리'],['security','추가 본인 확인']]:[])].map(([v,l])=><button key={v} aria-current={tab===v?'page':undefined} onClick={()=>setTab(v)}>{l}</button>)}</nav>
      {tab==='work'&&<section><h1>{manage?'전체 업무':'배정 업무'}</h1><form onSubmit={e=>{e.preventDefault();void refresh();}} className="search"><label>업무 검색<input value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label><button>검색</button><a href={'/api/erp/export?q='+encodeURIComponent(query)}>조회 업무 내려받기</a></form><p>조회 가능한 업무 {work.length}건 (최대 1,000건)</p>
        <ul className="items">{work.map(w=><li key={s(w.id)}><button onClick={()=>void open('work',w)}>{s(w.title)}</button><span>{s(w.project_name)}</span></li>)}</ul>{!work.length&&<p>표시할 업무가 없습니다. 배정 여부를 담당자에게 확인하세요.</p>}
        {detail&&selected&&<article className="detail"><h2>{s(selected.title)}</h2><p className="prewrap">{s(selected.description)}</p><h3>업무·인수인계 이력</h3><ul>{historyRows.map(h=><li key={s(h.id)}>{when(h.created_at)} · {s(h.reason)}{(h.after_state as Row)?.title?' · '+s((h.after_state as Row).title):''}</li>)}</ul>{manage&&<Editor key={s(selected.id)+s(selected.version)} fields={workFields} label="업무 수정·재배정" submit={data=>change('work',{...data,id:selected.id,version:selected.version,action:'update'})}/>}</article>}
        {manage&&!selected&&<details><summary>업무 등록</summary><Editor fields={[{name:'projectId',label:'과제·비교과',options:projects.map(p=>[s(p.id),s(p.name)])},...workFields]} submit={data=>change('work',{...data,action:'create'})}/></details>}
      </section>}
      {tab==='projects'&&<section><h1>과제·비교과</h1><ul className="items">{projects.map(p=><li key={s(p.id)}><button onClick={()=>void open('projects',p)}>{s(p.name)}</button><span>{p.kind==='program'?'비교과':'과제'} · {s(p.business_year)||'연차 미지정'}</span></li>)}</ul>{!projects.length&&<p>조회 가능한 과제·비교과가 없습니다.</p>}
        {selected&&detail&&<article className="detail"><h2>{s(selected.name)}</h2><h3>참여자</h3><ul>{((detail.participants??[]) as Row[]).map(m=><li key={s(m.id)}>{s(m.display_name)||'이름 미등록'} · {names[s(m.role)]} · {m.active?'배정':'해제'}</li>)}</ul>{manage&&<><Editor key={s(selected.id)+s(selected.version)} fields={projectFields} submit={data=>change('projects',{...data,id:selected.id,version:selected.version,action:'update'})}/><h3>참여자 배정·해제</h3><Editor fields={[{name:'userId',label:'계정',options:accounts.map(a=>[s(a.id),s(a.display_name)+' · '+names[s(a.role)]])},{name:'active',label:'배정 상태',options:[['true','배정'],['false','해제']]},reason]} submit={data=>change('projects',{...data,id:selected.id,version:selected.version,action:'member',active:data.active==='true'})}/></>}<h3>변경 이력</h3><ul>{historyRows.map(h=><li key={s(h.id)}>{when(h.created_at)} · {s(h.reason)}</li>)}</ul></article>}
        {manage&&!selected&&<details><summary>과제·비교과 등록</summary><Editor fields={[{name:'code',label:'관리 코드'},...projectFields]} submit={data=>change('projects',{...data,action:'create'})}/></details>}
      </section>}
      {tab==='security'&&manage&&<section><h1>추가 본인 확인</h1><p>계정 관리 전 인증 앱의 6자리 코드를 입력하세요. 확인은 5분 동안 유효합니다.</p><p>{recent?'추가 확인이 유효합니다.':'추가 확인이 필요합니다.'}</p>{!user.otpReady&&<><p>최초 등록은 Google 로그인 후 5분 이내에 가능합니다. 인증 앱의 ‘설정 키 직접 입력’을 사용하세요.</p><button onClick={()=>void api('/api/erp/otp-enroll',{}).then(r=>setOtpSecret(r.secret)).catch(fail)}>인증 앱 등록 키 보기</button>{otpSecret&&<div className="secret">등록 키: <code>{otpSecret}</code><p>계정: BOOT ERP / 시간 기반 / 6자리. 이 키를 다른 사람에게 공유하지 마세요.</p></div>}</>}<Editor fields={[{name:'code',label:'인증 앱 코드',type:'password'}]} label="코드 확인" submit={async data=>{try{await api('/api/erp/otp-verify',data);setOtpSecret('');setNotice('추가 본인 확인을 완료했습니다.');await session();}catch(e){fail(e);}}}/><p>인증 앱을 분실했다면 담당자에게 계정 복구를 요청하세요. 관리자 계정은 다른 관리자 또는 서버 운영자의 별도 복구 절차가 필요합니다.</p></section>}
      {tab==='accounts'&&manage&&<section><h1>계정 관리</h1><p>등록 → 이메일 소유 확인 → 계정 활성화 순서로 진행하세요. 계정 변경에는 추가 본인 확인이 필요합니다.</p>{!recent&&<button onClick={()=>setTab('security')}>추가 본인 확인하기</button>}<ul className="items">{accounts.map(a=><li key={s(a.id)}><button disabled={a.role==='admin'&&user.role!=='admin'} onClick={()=>void open('accounts',a)}>{s(a.display_name)} · {s(a.email)}</button><span>{names[s(a.role)]} · {a.active?'활성':'정지'} · {a.ownership==='verified'?'소유 확인 완료':a.ownership==='rejected'?'소유 확인 실패':'소유 확인 대기'}</span></li>)}</ul>
        {recent&&selected&&<article className="detail"><h2>{s(selected.display_name)} 계정 관리</h2><p>변경하면 해당 계정의 기존 로그인은 종료됩니다. 이메일 변경·복구 후에는 소유 확인과 활성화를 다시 진행합니다.</p><Editor key={s(selected.id)+s(selected.auth_version)} fields={[{name:'action',label:'처리',options:[['verify','이메일 소유 확인'],['status','활성·정지'],['role','역할 변경'],['email','이메일 변경'],['recover','인증 연결·인증 앱 복구']]},{name:'outcome',label:'소유 확인 결과',options:[['verified','확인 완료'],['rejected','확인 실패']]},{name:'method',label:'소유 확인 방법 (소유 확인 처리 시 필수)',optional:true},{name:'active',label:'활성 상태',options:[['true','활성'],['false','정지']]},{name:'role',label:'역할',value:selected.role,options:Object.entries(names).filter(([v])=>user.role==='admin'||v!=='admin')},{name:'email',label:'변경할 이메일',type:'email',value:selected.email},reason]} submit={data=>change('accounts',{...data,id:selected.id,version:selected.auth_version,active:data.active==='true'})}/></article>}
        {recent&&!selected&&<details><summary>계정 사전 등록</summary><Editor fields={[{name:'name',label:'이름'},{name:'email',label:'Google 계정 이메일',type:'email'},{name:'role',label:'역할',options:Object.entries(names).filter(([v])=>user.role==='admin'||v!=='admin')},reason]} submit={data=>change('accounts',{...data,action:'create'})}/></details>}
      </section>}
      {tab==='accounts'&&selected&&detail&&<article className="detail"><h2>계정 변경 이력</h2><ul>{historyRows.map(h=><li key={s(h.id)}>{when(h.created_at)} · {s(h.reason)}</li>)}</ul><h3>이메일 소유 확인 이력</h3><ul>{((detail.ownership??[]) as Row[]).map((p,i)=><li key={i}>{when(p.checked_at)} · {s(p.email)} · {p.outcome==='verified'?'확인 완료':'확인 실패'} · {s(p.method)}</li>)}</ul></article>}{selected&&<button onClick={()=>{setSelected(null);setDetail(null);}}>선택 닫기</button>}
    </>}<footer>02단계 계정·업무 배정 시험 · 예산 예약·청구·지급 기능은 후속 단계에서 제공됩니다.</footer></main>;
}
