# Google 없는 임시 접속 구현·실행 기록

2026-11-06 / Asia/Seoul. 사용자 ‘구글 인증이 없이 임시적으로 접속할 수 있도록’ 요청을 PREVIEW-01~03/R-48로 적용했다. 기반 코드는 `c1e2bd427458ae4172fedc95f84ab551693c31ec`이며 기존 변경을 보존했다. 실제 Google 인증/운영 검수 완료나 실제 자료 입력 지시로 확대하지 않는다.

## 구현

- `/api/auth/preview`는 기본404다. 명시 flag·localhost:3000·test app 역할/DB·단일 `boot_preview_<UUID>` search_path·8시간 이내 만료·고정4역할 mapping을 검사한다. public/개발/운영 DB, 추가 옵션, 임의 계정/역할·Origin/Host를 거부한다.
- 실제 DB의 계정·가상 이메일·가상 소유 확인/역할·active와 실제 연결 스키마를 확인한 뒤 기존 `issueSession`으로 HttpOnly 세션을 발급한다. provider는 `local-preview`로 구분하고 세션 만료를 임시 환경 종료시각 이내로 줄인다. 같은 브라우저의 이전 preview 세션만 취소하며 기존 세션 제한은 유지한다.
- `runtimePool`은 preview 설정 오류/만료·모드 해제 뒤 잔류 preview DB 설정을 차단한다. 일반 local 실행기는 preview 환경변수를 제거해 Google 경로를 유지한다.
- UI는 임시 접속/역할 선택·가상자료 안내·종료시각을 표시한다. 기본 담당자이며 로그아웃 뒤 다른 역할을 선택한다. 정상 모드의 Google 화면은 유지한다.
- 실행기는 새 가상 스키마만 생성/마이그레이션하고4역할·3계층 예산·신청/첨부/실청구/지급을 준비한다. 초기 현재예산100,000,000/차감40,000,000/가용60,000,000/지급25,000,000원은 실제 가상 DB 기록이다.
- 웹 자식은 OS 필수 환경과 제한 DB·임시 키만 받는다. owner/Google/PG/NODE_OPTIONS를 상속하지 않고 Next 자동 dotenv 파일이 있으면 실행을 거부한다. 기존 인증 키 파일을 생성/대체하지 않는다.
- 8시간 만료 또는 `preview:stop` 요청 시 실제 시작한 웹 자식만 정지하고, 소유자·nonce·schema·created 상태를 확인한 자기 스키마/표식만 정리한다. 중지 CLI는 임의 PID를 죽이거나 DB에 접속하지 않는다. 실패 시 정리 근거를 보존한다.

## 명령·실제 결과

지정 Node24.21.0/npm11.19.0을 사용했다. 연결값/세션 토큰은 출력하지 않았으며 raw 로그·실행표식은 gitignore된 로컬 검수 폴더에만 둔다.

| 명령/관찰 | KST 실행 | 결과 |
|---|---|---|
| `run typecheck`, 스크립트 문법·공백 | 11-06 | exit0 |
| `test` | 11-06 | exit0, 기존 단위/Google/OIDC 및 preview config **9/9** |
| `run local -- test:preview` 최초 | 11-06 | exit1, **4 pass/4 fail**. loopback DB 주소 비교에서 정상 발급이503 |
| 같은 targeted 검사 보강 후 | 11-06 | exit0, **8/8**, 4역할·HttpOnly·상한 만료·CSRF/Host/계정 위장·off/expired/public 거부·기존 세션 차단 |
| `run preview -- --fixture-check` | 10:41:21~26 | exit0,7 migration/40표·정확한 가상 합계 및 자기 스키마 정리 |
| 역할/권한/환경/정리 probe | 10:43:00~12 | exit0,4역할 조회·PI 쓰기/연구원 지급 거부·DDL/history 권한 거부·owner/Google 비밀값9개 미상속·잘못된 소유 표식 보존·dev/test public80표 행 해시 불변 |
| 3계층 분류 보강 fixture | 10:43:39~44 | exit0,4개 leaf level3·3계층 snapshot |
| dotenv 존재 차단 검사/최종 fixture | 10:44:37~45 | exit0,4개 실제 dotenv 이름 거부·example 허용·최종 가상 fixture 정리 |
| `run build` | 11-06 | exit0, 새 preview route 포함 프로덕션 빌드 |
| 실제 첫 서버 | 10:46 이후 | GET preview metadata200·DB health200 |
| `run test:preview-ui` | 11-06 | exit0,네 역할의 실제 버튼→세션→대시보드/가상 금액·역할 메뉴·375px·로그아웃401·localStorage 미사용 |
| `run preview:stop` 및 상태 관찰 | 10:48 이전~10:48:52 | exit0, stop-requested 뒤 preview-stopped·자기 실행표식 제거. 요청 반환과 실제 정리를 구분해 확인 |
| `run local -- test:db` | 11-06, 약50초 | exit0, 기존 회귀 포함 **89/89**, 미실행0 |
| 최종 재실행 | 10:49:36 이후 | preview200·health200, 새 가상 환경을 접속용으로 유지. 종료예정2026-11-06 18:49:36 KST |

초기503은 `inet_server_addr()::text`가 `127.0.0.1/32`를 반환한 데서 발생했다. `host(inet_server_addr())`로 IP를 정규화해 loopback 검사를 유지한 뒤 통과했다. 분류 leaf 누락과 Next dotenv 재주입 가능성은 소스 감사에서 찾아 보강했다. 실패를 통과 기록으로 바꾸지 않았다.

수동 stop의 실제 자식 종료·소유 스키마/표식 정리는 확인했다. 8시간 경과를 기다린 wall-clock 시험은 수행하지 않았으며 만료 config/API 차단 검수와 실행기 종료 루프 구현으로 구분한다. 비정상 강제 종료/PC 재부팅 때는 안내된 잔류 정리 절차가 필요할 수 있다.

## 상태와 사용

[사용 안내](../local-preview.md). 현재 접속 주소는 `http://localhost:3000`, 로그인 화면의 **임시 접속**을 누른다. 가상자료만 사용하며 현재 서버는 사용자의 미리보기를 위해 실행 상태로 둔다. 최초 미리보기 가상 데이터는 stop 때 정리됐고 최종 재시작의 가상 데이터는 종료 때 정리된다.

일반 Google 인증·원래 키 복구·운영 규모/보존/검역·RPO/RTO 검증의 미충족은 그대로다. G1 미완료 및 P8/P9 미착수를 유지한다. Notion과 외부 ERP 전송을 수행하지 않았다.
