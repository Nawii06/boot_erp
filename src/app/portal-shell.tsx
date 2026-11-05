'use client';
import { useState, type ReactNode } from 'react';
import { pageLabels, pageGroup, type PortalPage } from '../lib/portal-navigation.ts';

export function Icon({kind='grid'}:{kind?:string}) {
  const shapes:Record<string,ReactNode>={
    grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    home:<><path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z"/></>,
    file:<><path d="M6 3h9l4 4v14H6Z"/><path d="M9 11h7M9 15h7M9 18h4M14 3v5h5"/></>,
    money:<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 10c0 4 16 4 16 0M4 15c0 4 16 4 16 0"/></>,
    search:<><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
    settings:<><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    users:<><circle cx="9" cy="7" r="4"/><path d="M2 22v-4a7 7 0 0 1 14 0v4M17 3a4 4 0 0 1 0 8M18 15a5 5 0 0 1 4 5v2"/></>,
    check:<><rect x="4" y="4" width="16" height="18" rx="2"/><path d="M8 4V2h8v2M8 13l3 3 6-7"/></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[kind]??shapes.grid}</svg>;
}
type Props={children:ReactNode;role?:string;roleLabel?:string;email?:string;page:PortalPage;tabs:PortalPage[];
  onNavigate:(page:PortalPage)=>void;onClose:(page:PortalPage)=>void;onLogout:(all:boolean)=>void};
export default function PortalShell({children,role,roleLabel,email,page,tabs,onNavigate,onClose,onLogout}:Props) {
  const [menuOpen,setMenuOpen]=useState(false);
  const manage=['staff','admin'].includes(role??'');
  const go=(to:PortalPage)=>{onNavigate(to);setMenuOpen(false);};
  const nav=(to:PortalPage,label:string,icon:string,accessible?:string)=><button key={to+label} type="button" aria-label={accessible} aria-current={page===to&&label!=='예산 현황'?'page':undefined} onClick={()=>go(to)}><Icon kind={icon}/><span>{label}</span></button>;
  return <div className={'portal '+(role?'authenticated':'signed-out')}>
    <a className="skip-link" href="#erp-content">본문 바로가기</a>
    <header className="app-header"><div className="brand-group"><a className="brand" href="/" onClick={e=>{if(role){e.preventDefault();go('dashboard');}}}>BOOT ERP</a><span className="brand-subtitle">부트캠프 사업관리</span></div>
      <div className="header-actions"><time suppressHydrationWarning>{new Date().toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'})}</time>{role&&<><span className="role-badge">{roleLabel}</span><details className="user-menu"><summary>사용자 메뉴</summary><div><p>{email}</p><button onClick={()=>onLogout(true)}>전체 기기 로그아웃</button>{manage&&<button onClick={()=>go('security')}>추가 본인 확인</button>}</div></details><button className="logout-button" onClick={()=>onLogout(false)}>로그아웃</button></>}</div>
    </header>
    {role&&<><nav className="top-navigation" aria-label="주 메뉴"><button className="menu-toggle" aria-expanded={menuOpen} aria-controls="erp-sidebar" onClick={()=>setMenuOpen(v=>!v)}>☰ 메뉴</button>{['업무 관리','현황·보고서','설정'].map(label=><button key={label} aria-current={pageGroup(page)===label?'page':undefined} onClick={()=>go(label==='업무 관리'?'work':label==='설정'?(manage?'accounts':'policies'):'dashboard')}>{label}</button>)}</nav>
      <aside id="erp-sidebar" className={'sidebar '+(menuOpen?'is-open':'')} aria-label="업무 메뉴">
        {nav('dashboard','대시보드','home')}
        <div className="sidebar-group"><h2>업무·과제</h2>{nav('work',manage?'전체 업무':'내 업무','file')}{nav('projects','과제·비교과','grid')}</div>
        <div className="sidebar-group"><h2>예산 관리</h2>{nav('dashboard','예산 현황','money','예산 현황')}{nav('budgets','배정·변경','settings','예산배정·변경')}</div>
        <div className="sidebar-group"><h2>지출 관리</h2>{nav('applications',manage?'지출 신청·검토':'지출 신청','file')}{nav('expenses','초안·증빙','file','지출 초안·증빙')}{manage&&nav('applications','검토·보완','search','검토·보완')}{nav('payments','실청구·지급','money')}</div>
        <div className="sidebar-group"><h2>관리</h2>{nav('policies','단가·한도 기준','settings')}{manage&&nav('accounts','계정·권한','users','계정 관리')}</div>
        <div className="sidebar-future"><Icon/><span>Notion 실적 연계</span><small>추후 단계</small></div>
      </aside>
    </>}
    <div className="workspace">
      {role&&<><nav className="workspace-tabs" aria-label="열린 화면">{tabs.map(to=><div key={to} className={page===to?'active':''}><button role="tab" aria-selected={page===to} onClick={()=>go(to)}>{pageLabels[to]}</button>{to!=='dashboard'&&<button className="tab-close" aria-label={pageLabels[to]+' 탭 닫기'} onClick={()=>onClose(to)}>×</button>}</div>)}</nav><div className="breadcrumb">{pageGroup(page)} / {pageLabels[page]}</div></>}
      <main id="erp-content" className="page-content" tabIndex={-1}>{children}</main>
      <footer>ⓘ 내부 승인 · 실청구 · 실제 지급은 구분하여 관리합니다.</footer>
    </div>
  </div>;
}
