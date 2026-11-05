# ERP 대시보드 완성 예상 컨셉

2026-11-06 / Asia/Seoul. 사용자 요청에 따라 built-in ImageGen으로 생성한 가상 화면이다. 실제 실행 화면이나 기능 완료 증거가 아니다. 실제 개인정보·계정·과제·거래를 사용하지 않았다.

후속 지시: 사용자가 이 이미지와 같은 형태로 구현하도록 작업 프롬프트 변경을 요청했다. [UI 구현 명세](erp-ui-spec.md)와 [수정된 작업 프롬프트](../completion-prompts.md)를 적용한다. 아래 생성 프롬프트는 이미지 제작 당시 기록이며 실제 구현 지시는 최신 UI 명세가 기준이다.

이미지: [대시보드 컨셉 PNG](erp-dashboard-concept-2026-11-06.png)

상단 업무 분류·좌측 세부 메뉴·작업 탭·조회 조건·예산 요약/항목표·처리 대기·최근 지출 신청을 배치했다. 실제 지급액은 유효 신청 차감액의 일부라는 가정이며 가용액에서 다시 차감하지 않는다. Notion 실적 연계는 ‘추후 단계’로 표시했다. 이 화면은 담당자 역할의 예시이며 다른 역할은 허용 범위에 맞춰 노출해야 한다.

기준: [통합계획](../completion-plan.md), [참조 ERP 검토](../reference-erp-review.md). 생성 이미지 내 문구·수치·메뉴는 구현 전에 현행 정책과 다시 대조한다.

## 생성 프롬프트

```text
Use case: ui-mockup.
Create one high-fidelity desktop application screenshot concept for a Korean university project-and-budget ERP called "BOOT ERP". This is a future completed product concept, based on the previously analyzed conventional university research-administration ERP structure, redesigned for clarity. Brand is only BOOT ERP, no real university logos. Show a SINGLE flat straight-on full interface, landscape approximately 16:10, crisp high resolution, no monitor/laptop mockup, no perspective, no decorative background. All information is synthetic.
Design direction: practical, polished Korean institutional business software. White header, strong royal blue horizontal application navigation, navy accents, pale cool gray workspace, 220px white left sidebar with grouped menus, fine gray borders, readable Pretendard/Noto Sans Korean typography, restrained corner radii, dense yet comfortably legible tables. Avoid giant rounded marketing cards, gradients, ornamental illustrations or futuristic styling.
Layout:
Top slim branding/user bar with "BOOT ERP", subtitle "부트캠프 사업관리", date "2026.11.06", role badge "담당자", bell, "로그아웃".
Blue horizontal nav: "업무 관리" active, "현황·보고서", "설정".
Left grouped navigation: "대시보드" active; group "업무·과제" with "내·전체 업무", "과제·비교과"; group "예산 관리" with "예산 현황", "배정·변경"; group "지출 관리" with "지출 신청", "검토·보완", "실청구·지급"; group "관리" with "단가·한도 기준", "계정·권한". Bottom of sidebar small muted future item "Notion 실적 연계" with badge "추후 단계", do NOT show connected or synced.
Main area:
A compact page-tab strip "대시보드" active, "예산 현황", "지출 신청". Breadcrumb "업무 관리 / 대시보드". Main title "업무·예산 현황", small clearly visible blue-outlined badge "완성 예상 화면 · 가상 데이터".
Filter strip: "사업연차" dropdown "2026학년도 · 1차년도"; "과제·비교과" dropdown "전체"; period "2026.03.01 ~ 2026.12.31"; blue button "조회".
Four summary cards in one row with exact labels and numbers: "현재예산" "100,000,000원"; "유효 신청 차감액" "40,000,000원"; "가용예산" "60,000,000원"; "실제 지급액" "25,000,000원". Under the actual payment number a small explanation "신청 차감액 중 지급된 금액". Budget available is current budget minus valid submitted expenses; payment is NOT deducted a second time.
Below, a 2:1 split:
LEFT main panel title "예산항목별 현황", secondary text "(단위: 원)", top-right "내역 보기". Table with clear navy-gray header labels "예산항목 / 현재예산 / 신청 차감액 / 가용예산 / 실제 지급액". Four exact synthetic rows:
"연구재료비 | 40,000,000 | 16,000,000 | 24,000,000 | 10,000,000"
"연구활동비 | 30,000,000 | 12,000,000 | 18,000,000 | 8,000,000"
"학생출장비 | 20,000,000 | 8,000,000 | 12,000,000 | 5,000,000"
"회의비 | 10,000,000 | 4,000,000 | 6,000,000 | 2,000,000"
Total footer "합계 | 100,000,000 | 40,000,000 | 60,000,000 | 25,000,000". Right-align monetary figures, blue color for available amounts, thin row rules.
RIGHT panel "처리할 업무", three simple compact status rows "검토 대기 3건", "보완 확인 2건", "지급 확인 1건", followed by two blue-outlined quick action buttons "신청 검토" and "지급 내역 확인". No fake personal identity.
Across bottom wide panel title "최근 지출 신청", right button "+ 지출 신청". Compact table headers "신청번호 / 과제·비교과 / 제목 / 신청금액 / 상태 / 신청일 / 보기". Three fictional rows:
"EXP-026 / 산공과제 A / 연구재료 구입 / 1,200,000원 / 검토 대기 / 2026.11.06 / 상세"
"EXP-025 / 비교과 프로그램 B / 현장학습 출장 / 800,000원 / 보완 요청 / 2026.11.05 / 상세"
"EXP-024 / 산공과제 C / 전문가 자문 / 500,000원 / 내부 승인 / 2026.11.04 / 상세"
Use pill status badges with both text and restrained amber/blue/green hues, no implication that internal approval equals payment.
Bottom very small note "내부 승인 · 실청구 · 실제 지급은 구분하여 관리합니다." and "UI CONCEPT · 예시 화면".
Ensure Korean words look professionally typeset and highly legible, with sufficient space and alignment, no overlapping text. Frame every navigation item and table fully within the image. It should look like a believable completed production ERP screen, not a slide or wireframe.
```
