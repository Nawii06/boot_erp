'use client';
import { useEffect, useState } from 'react';
import type { DashboardResult } from '../lib/dashboard.ts';
import type { PortalPage } from '../lib/portal-navigation.ts';
import { Icon } from './portal-shell.tsx';

const money=(value:string|null|undefined)=>value===null||value===undefined?'미제공':BigInt(value).toLocaleString('ko-KR');
const states:Record<string,string>={draft:'초안',submitted:'검토 대기',reviewing:'검토 중',supplement:'보완 요청',approved:'내부 승인',withdrawn:'회수',rejected:'반려',cancelled:'취소',revision:'정정 준비'};
type Props={fail:(e:unknown)=>void;navigate:(page:PortalPage)=>void;openDraft:(id:string)=>void;refreshKey:number};
export default function DashboardPanel({fail,navigate,openDraft,refreshKey}:Props) {
  const [filters,setFilters]=useState({year:'2026',projectId:'',from:'2026-03-01',to:'2026-12-31'});
  const [query,setQuery]=useState(new URLSearchParams(filters).toString());
  const [result,setResult]=useState<DashboardResult|null>(null),[loading,setLoading]=useState(true),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setResult(null);setLoading(true);setFailed(false);
    void fetch('/api/erp/dashboard?'+query,{cache:'no-store',signal:controller.signal}).then(async response=>{
      const data=await response.json();if(!response.ok)throw new Error(data.error?.code??'UNAVAILABLE');
      if(!controller.signal.aborted)setResult(data);
    }).catch(error=>{if(!controller.signal.aborted){setFailed(true);fail(error);}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[query,refreshKey,fail]);
  const cards=[['현재예산',result?.totals.current,'money'],['유효 신청 차감액',result?.totals.committed,'check'],['가용예산',result?.totals.available,'grid'],['실제 지급액',result?.totals.paid,'money']] as const;
  return <section className="dashboard" aria-busy={loading}>
    <div className="page-title"><h1>업무·예산 현황</h1><span className="subtle-badge">권한 범위 내 조회</span></div>
    <form className="dashboard-filters search" onSubmit={event=>{event.preventDefault();setQuery(new URLSearchParams(filters).toString());}}>
      <label>사업연차<select value={filters.year} onChange={e=>setFilters({...filters,year:e.target.value})}><option value="2026">2026학년도 · 1차년도</option><option value="">전체 학년도</option></select></label>
      <label>과제·비교과<select value={filters.projectId} onChange={e=>setFilters({...filters,projectId:e.target.value})}><option value="">전체</option>{result?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <fieldset><legend>기간</legend><label className="sr-only" htmlFor="dashboard-from">초안 생성 시작일</label><input id="dashboard-from" type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/><span>~</span><label className="sr-only" htmlFor="dashboard-to">초안 생성 종료일</label><input id="dashboard-to" type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/></fieldset>
      <button className="primary" disabled={loading}>조회</button>
    </form>
    <p className="snapshot-note">예산은 현재 잔액, 지급·환입은 각 발생일의 기간 실적입니다. 최근 신청은 초안 작성일(KST) 기준입니다.{result&&<> 기준시각: {new Date(result.asOf).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}</>}</p>
    {failed&&<p className="inline-error" role="alert">현황을 조회하지 못했습니다. 조회를 다시 실행해 주세요.</p>}
    <div className="summary-cards">{cards.map(([label,value,icon],index)=><article key={label} className={index===2?'available-card':''}><span className="card-icon"><Icon kind={icon}/></span><div><h2>{label}</h2><strong>{loading?'조회 중':result?money(value):'조회 안 됨'}{value!==null&&value!==undefined&&<small>원</small>}</strong>{index===3&&<p>기간 지급 총액 · 공제 포함</p>}</div></article>)}</div>
    <div className="dashboard-middle">
      <section className="data-panel"><div className="panel-heading"><h2>예산항목별 현황 <small>(단위: 원)</small></h2><button onClick={()=>navigate('budgets')}>내역 보기 ›</button></div>
        <div className="table-scroll"><table><thead><tr>{['예산항목','현재예산','신청 차감액','가용예산','실제 지급액'].map(h=><th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{result?.lines.map(line=><tr key={line.id}><th scope="row"><span>{line.label}</span><small className="cell-caption">{line.projectName}</small></th><td>{money(line.current)}</td><td>{money(line.committed)}</td><td className="available">{money(line.available)}</td><td>{money(line.paid)}</td></tr>)}{!result?.lines.length&&<tr><td colSpan={5} className="empty-state">{loading?'예산을 조회하고 있습니다.':failed?'조회 실패 — 다시 조회해 주세요.':'조회 범위에 등록된 예산항목이 없습니다.'}</td></tr>}</tbody>{result&&<tfoot><tr><th scope="row">합계</th><td>{money(result.totals.current)}</td><td>{money(result.totals.committed)}</td><td className="available">{money(result.totals.available)}</td><td>{money(result.totals.paid)}</td></tr></tfoot>}</table></div>
        {result&&<a className="table-export" href={'/api/erp/dashboard?format=csv&'+query}>현재 조회 내역 CSV</a>}
      </section>
      <section className="data-panel task-panel"><div className="panel-heading"><h2>처리할 업무</h2></div><ul>{([['검토 대기','review'],['보완 확인','supplement'],['지급 확인','payment']] as const).map(([label,key])=><li key={key}><span>{label}</span><strong>{loading?'조회 중':!result?'미조회':result.processing[key]===null?'담당자 전용':result.processing[key]+'건'}</strong></li>)}</ul>{result&&['staff','admin'].includes(result.scope.role)&&<div className="quick-actions"><button onClick={()=>navigate('applications')}>신청 검토</button><button onClick={()=>navigate('payments')}>지급 내역 확인</button></div>}<p>현재 처리상태 기준이며 기간 필터와 구분합니다.</p></section>
    </div>
    <section className="data-panel recent-panel"><div className="panel-heading"><h2>최근 지출 신청</h2>{result?.scope.role!=='principal_investigator'&&<button className="primary" onClick={()=>navigate('applications')}>＋ 지출 신청</button>}</div><div className="table-scroll"><table><thead><tr>{['신청번호','과제·비교과','제목','신청금액','상태','작성일','보기'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{result?.recent.map(d=><tr key={d.id}><td><abbr title={d.applicationId??d.id}>{d.number}</abbr></td><td>{d.projectName}</td><td>{d.title||'제목 없는 초안'}</td><td>{d.amount===null?'미입력':money(d.amount)+'원'}</td><td><span className={'state-badge '+d.state}>{states[d.state]??d.state}</span></td><td>{new Date(d.createdAt).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'})}</td><td><button onClick={()=>openDraft(d.id)}>상세</button></td></tr>)}{!result?.recent.length&&<tr><td colSpan={7} className="empty-state">{loading?'신청을 조회하고 있습니다.':failed?'조회할 수 없습니다.':'조회 범위에 작성된 신청·초안이 없습니다.'}</td></tr>}</tbody></table></div></section>
    {result&&<p className="snapshot-note">기간 지급 총액 {money(result.totals.paid)}원 · 환입 {money(result.totals.refunded)}원 · 순집행 {money(result.totals.netExecution)}원. {result.scope.paymentScope==='assigned_work'?'지급 실적은 본인 배정 업무 범위입니다. 과제 공통 예산과 범위가 다를 수 있습니다.':'지급 실적은 선택한 과제 범위입니다.'}</p>}
  </section>;
}
