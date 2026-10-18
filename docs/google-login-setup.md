# Google 로그인 로컬 연결 준비

2026-10-18 기준. 사용자 보고로 Google Auth Platform 기본 설정, 외부/테스트 상태, 시험 사용자 등록, 웹 애플리케이션 클라이언트 생성, 인증정보 JSON 비공개 보관을 완료했다. 현재 PC에서 우선 시험하며 최초 관리자와 시험 계정도 선정했다. 제공된 경로의 JSON을 읽어 웹 클라이언트 형식·Client ID 형식·Secret 존재와 로컬 원본 주소를 확인했다. 실제 Console 설정·키 유효성·로그인 연결을 검증한 것은 아니다.

## Google에 추가할 반환 주소

이번 로컬 로그인 구현의 반환 경로는 다음으로 정한다.

```text
http://localhost:3000/api/auth/google/callback
```

Google Cloud Console에서 해당 프로젝트의 **Google Auth Platform → 클라이언트 → 만든 웹 애플리케이션 클라이언트 → 승인된 리디렉션 URI → URI 추가**에 위 주소를 등록하고 저장한다. 기존의 다른 반환 주소를 삭제하지 않는다. 이 주소는 로그인 후 Google이 ERP로 사용자를 돌려보내는 곳이다. JavaScript 원본 입력란과는 다르다.

브라우저에서 시험할 앱 주소는 `http://localhost:3000`이다. 포트·호스트·경로가 바뀌면 앱 설정과 Google 등록값을 함께 맞춘다. `localhost`와 `127.0.0.1`을 혼용하지 않는다. 실제 반환 처리는 아직 구현 전이므로 지금 이 주소를 열어도 로그인이 완료되지 않는다. 경로 예약과 실제 구현·검수는 별개다.

## 비공개 인증정보 연결

사용자는 보관한 JSON의 전체 파일 경로만 전달한다. 내용·Client Secret·실제 계정 이메일을 공개 문서/커밋에 넣지 않는다. 파일은 저장소 밖에 유지한다. 파일명 자체에 Client ID가 포함될 수 있으므로 실제 경로도 공개 작업기록에 복사하지 않는다.

파일을 읽을 때 웹 클라이언트 형식(`web`), Client ID/Secret 존재, 등록된 반환 주소를 검사하되 값은 도구 출력·로그에 표시하지 않는다. JSON을 생성한 후 Console에 반환 주소를 추가했다면 기존 JSON의 주소 목록이 오래됐을 수 있으므로 이를 구분한다. Secret을 다시 받기 위해 불필요하게 기존 클라이언트나 키를 교체하지 않는다.

`scripts/google-config.mjs`가 저장소 밖 JSON을 읽고 검증한다. `scripts/local.mjs`는 `BOOT_ERP_GOOGLE_OAUTH_FILE`이 설정되면 dev/start 자식 프로세스에만 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_ORIGIN`을 공급한다. DB 마이그레이션·seed·검수에는 Google 인증정보를 전달하지 않는다. `.env.example`은 가짜 파일 경로 안내이며 실행기는 .env를 자동으로 읽지 않는다. 아래 예시 경로를 본인의 비공개 파일 경로로 바꿔 현재 PowerShell에 설정한다.

```powershell
$env:BOOT_ERP_GOOGLE_OAUTH_FILE = 'C:\boot_erp_private\google-oauth.example.json'
.\scripts\app.cmd run check:google-config
.\scripts\app.cmd run local -- dev
```

JSON 검사 결과의 `redirectListedInDownload: false`는 다운로드 당시 목록에 주소가 없다는 뜻이며 Console의 현재 등록 상태를 조회한 결과가 아니다. Secret 재발급 사유가 아니다. 실제 로그인 구현 후 `http://localhost:3000`에서 연결을 검수한다. 임의로 포트를 바꾸면 등록한 반환 주소와 달라지므로 Google 로그인 시험에는 3000을 사용한다. 브라우저용 환경변수에 Secret을 넣지 않는다. 운영용 비밀정보 관리·도메인은 별도 배포 준비에서 정한다.

## 실제 연결까지 남은 순서

1. 완료: 사용자에게 받은 JSON 경로로 비밀값 비출력 로딩 검사.
2. 사용자 보고로 완료: 위 반환 주소를 Google에 등록. 실제 연결 검수는 별도.
3. 데이터 기반 완료: 02 계정·인증 연결·수기 확인·세션·감사 테이블 5개. 다음은 로그인/반환 처리와 실제 서비스 구현.
4. 별도 비공개 절차로 선정된 최초 관리자 계정을 등록한다. Google 시험 사용자 등록만으로 ERP 관리자 권한을 부여하지 않는다.
5. 실제 Google 로그인과 사전 등록·정지·권한·세션 검수를 수행한다. 로그인 성공과 A-01~A-12 전체 완료를 구분한다.

현재 JSON 로딩·앱 프로세스 설정 공급과 DB 기반 검수는 완료했다. 사용자가 반환 주소 등록 완료를 보고했으므로 재등록을 요구하지 않는다. 반환 경로 구현·관리자 등록·실제 Google 로그인 시험은 미수행이다. 확정 정책은 [인증 정책](auth-policy.md), 구현 범위는 [인증 기반](auth-foundation.md), 전체 남은 작업은 [02 작업서](stages/02-access-projects.md)를 따른다.
