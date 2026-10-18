# 02단계 7개 순서 구현·검수

2026-10-18 (Asia/Seoul). 사용자의 “7개 순서를 추진” 지시로 `codex/phase-02-auth-foundation`의 `e414714`에서 후속 구현. 기존 변경 없음 확인. 실제 계정/Google 설정 파일은 저장소 밖에서 읽고 공개 출력·커밋에 포함하지 않았다.

## 구현

- Google OIDC 코드 흐름, PKCE, 일회성 state/브라우저 쿠키 연결, nonce·서명·발급자·대상·만료·검증된 이메일 검사. Google 업무 API 권한·refresh token 저장 없음.
- 사전 등록/수기 확인/활성 계정/명시적 최초 또는 복구 연결 허용을 모두 검사. 제공자 연결은 내부 ID와 분리하고 임의 이메일 일치만으로 기존 연결을 병합하지 않는다.
- 서버 세션 해시, 15분/8시간/2세션, 2분 전 경고, 현재/전체 로그아웃, 보안 변경 폐기. TOTP 추가 확인 5분, 재사용 방지·5회 실패/15분 제한, 암호화 저장.
- 관리자/일반 계정 관리 경계, 역할/정지/이메일/복구·수기 확인·감사 조회, 최초 관리자 CLI와 서버 운영자 복구 절차.
- 사업연차·과제/비교과·참여자, 업무 배정/재배정, 변경 전후 이력. 실제 서버 조회 조건을 목록/상세/검색/JSON 내보내기/집계에 공유.
- SQL migration 1개 추가, 총 3개/테이블 18개. 기존 테이블의 새 열과 Drizzle 정의 동기화. 기존 자료 보존. 실제 등록은 개발 DB에 관리자 1개만 추가.

## 검수 증거

| 검수 | 결과 |
|---|---|
| `scripts/app.cmd test` | 8/8 통과: 기존 금액/권한, 비공개 설정, 쿠키/CSRF/암호화, OIDC 서명·발급자·대상·만료·nonce·이메일 |
| `scripts/app.cmd run typecheck` | 통과 |
| `scripts/app.cmd run local -- test:db` | 27/27 통과: 기반 하위 13건 + 02 HTTP/DB 하위 12건 + 부모 2개. A-01~A-12의 서버 경계와 가상 제공자 교체/복구 |
| `NEXT_TELEMETRY_DISABLED=1`의 `scripts/app.cmd run build` | 성공. Google 시작/반환·세션·업무 API 경로 포함 |
| `scripts/app.cmd run local -- test:ui` | 설치된 Edge로 4개 역할, 실제 폼 저장, 연구원 격리, 동일 브라우저 계정 교체, 저장소 캐시 미사용, 2분 경고/연장, 로그아웃/뒤로 가기, 모바일 폭 검수 통과 |
| `scripts/app.cmd run test:http` | 실제 Next 앱 홈/DB, 미인증·위조 세션 401, 미개방 파일 404 통과 |
| `run local -- migrate` / `migrate:test` | 개발/시험 각각 migration 1개 적용 |
| `run init:auth-key` | 저장소 밖 키 준비, 기존 파일 덮어쓰기 금지 |
| `run local -- bootstrap-admin` 2회 | 첫 실행 등록, 재실행 already_registered. 이메일·이름·소유 확인 내용 비출력 |
| 실제 Google 로그인 | 사용자 성공 보고 + DB의 활성 관리자/Google 연결/세션 생성 true 확인 |
| 실제 ERP 인증 앱 확인 | 사용자 첫 성공 보고와 DB 확인 결과를 대조했으나 OTP confirmed/step_up은 false. Google 추가 인증과 ERP 인증 앱 등록을 구분해 재시험 안내. 최종 결과는 후속 갱신 |
| 공개 범위 검사 | 공개 후보/브라우저 산출물 114개와 홈 응답에 실제 관리자 이메일·Google ID/Secret·서버 암호화 키 일치 0 |
| 문서 검사 | Markdown 46개, 상대 링크 195개, 누락 대상 0. `git diff --check` 통과 |

첫 DB 병렬 시험은 node-pg-migrate의 공용 advisory lock 충돌로 실패했다. 마이그레이션 보호는 유지하고 시험 파일 실행을 순차화한 뒤 통과했다. 첫 브라우저 검수는 Next.js의 숨겨진 route announcer까지 경고 요소로 세어 실패했다. ERP 경고 요소로 검수 대상을 한정한 후 통과했다. 실패 이력은 삭제하지 않는다.

최초 일반 권한의 npm metadata 조회는 EACCES로 실패했다. 허용된 네트워크 권한으로 공식 registry 조회·고정 버전 설치 후 성공했다. 최종 검토에서 복수 audience 토큰의 azp 검사를 보강하고, 동일 브라우저의 계정 교체 감지 시 기존 화면 상태를 먼저 비우도록 했다. 이후 단위·타입·빌드·브라우저·Next HTTP 검수를 다시 통과했다. 실제 시험 앱은 최종 빌드로 재시작했다.

## 의존성 근거

Node 24 환경에서 jose 6.2.12, otpauth 9.5.2, 검수용 @playwright/test 1.64.1 고정 및 lockfile 갱신. 설치 후 npm audit 0건.

- [Google OIDC 공식 문서](https://developers.google.com/identity/openid-connect/openid-connect): 코드 흐름, ID token·nonce 검증.
- [jose 공식 저장소](https://github.com/panva/jose): jwtVerify와 고정 Google JWKS 사용.
- [OTPAuth 공식 저장소](https://github.com/hectorm/otpauth): TOTP 생성·검증. 별도 암호화·시도 제한·재사용 방지는 앱/DB에서 구현.
- [Playwright 브라우저 안내](https://playwright.dev/docs/browsers): 설치된 Edge의 별도 임시 프로필로 검수.

## 후속·한계

사용자 실제 시험을 위해 localhost:3000 앱과 전용 로컬 DB를 실행 상태로 유지한다. 시험 스키마와 별도 브라우저는 정리했다. 실제 계정의 이메일·이름·토큰·키·화면은 공개 자료에 포함하지 않는다. 운영 배포·운영 복구·실제 대학 SSO·후속 증빙/청구/지급 경로는 이번 검수 대상이 아니다. 03은 자동 시작하지 않는다. 마지막 원격 SHA는 작업 보고에 명시한다.
