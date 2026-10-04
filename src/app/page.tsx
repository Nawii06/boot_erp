export default function Home() {
  return <main>
    <header><span className="brand">BOOT ERP</span><span className="badge">개발 환경</span></header>
    <section className="intro">
      <p className="eyebrow">과제 · 비교과 업무 관리</p>
      <h1>업무를 연결하는<br />첫 기반을 준비했습니다.</h1>
      <p className="lead">현재 개발 기반을 확인하는 화면입니다.<br />업무 서비스는 계정과 접근권한 설정 후 제공됩니다.</p>
    </section>
    <section className="notice" aria-labelledby="access-title">
      <span className="step">01</span><div><h2 id="access-title">로그인 준비 중</h2>
      <p>기관의 로그인 방식과 계정 관리 기준을 확인하고 있습니다.<br />현재는 업무 데이터 조회, 청구 입력과 파일 업로드를 사용할 수 없습니다.</p></div>
    </section>
    <section className="scope" aria-label="업무 역할">
      <article><h2>연구원</h2><p>배정된 업무의 신청과 청구</p></article>
      <article><h2>과제책임자</h2><p>배정된 업무 현황 조회</p></article>
      <article><h2>담당자</h2><p>전체 업무와 처리 결과 관리</p></article>
      <article><h2>관리자</h2><p>계정·권한과 시스템 관리</p></article>
    </section>
    <footer>실제 개인정보·청구내역·증빙을 입력하지 마세요.</footer>
  </main>;
}
