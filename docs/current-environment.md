# 현재 Windows 환경 인수

2026-11-05 최초 확인 / 2026-11-06 후속 갱신 / Asia/Seoul. 작업 위치: `C:\work\boot_erp`.

2026-11-06 후속: PostgreSQL18.6-5 전용 도구와 신규 localhost:55432 클러스터·독립 dev/test DB·제한 app/owner 역할을 준비했다. 접속 파일은 저장소 밖 비공개 폴더에 두었으며 7 migration/업무표39+이력표1 적용, 최종 통합 DB82건 통과. 실제 자료/관리자 계정은 생성하지 않았다. [환경 실행 근거](history/2026-11-06-p0-environment.md), [최신 진행표](execution-progress.md). 기존 Google JSON과 암호화 키는 없으므로 실제 로그인 인수는 미완료다. 아래 초기 점검의 DB 미준비 기록은 당시 상태다.

## 커밋 확인

원격 main의 `32878717dae0dab1d9a81e9efeead989533f626e`를 빈 작업 폴더에 복제했다. 최신 두 커밋 `3287871`, `6c95e5f`는 main 통합·인수인계 문서 변경이다. 최근 기능 구현은 `379b525`의 04 공통 초안·첨부·기준 설정이다. 00~03 완료, 04 일부 구현이라는 기존 범위를 유지한다. 이번 확인은 커밋 이력·변경 요약과 현재 코드 검증이며 전체 코드 감사는 아니다.

## 이 PC에서 확인한 결과

- 최초 시스템 Node 24.16.0 / npm 11.13.0은 저장소 지정 버전보다 낮았다. 이후 사용자 요청으로 공식 Node 24.21.0 Windows x64 ZIP을 프로젝트 전용 `%LOCALAPPDATA%\boot_erp\tools`에 설치했다. 동봉 npm은 지정 버전 11.19.0이다. `scripts/app.cmd`가 이 버전을 자동 선택한다. 일반 터미널의 전역 Node/npm은 기존 버전을 유지한다.
- 공식 SHASUMS256.txt와 ZIP SHA256 `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` 일치를 확인했다. npm 11.19.0의 Node 요구 `^20.17.0 || >=22.9.0` 및 설치된 Next/마이그레이션/Playwright 패키지의 Node 요구 범위에 Node 24.21.0이 포함된다.
- 지정 버전에서 `scripts/app.cmd run typecheck`, `scripts/app.cmd test`(8건), `scripts/app.cmd run build`를 재실행해 모두 통과했다.
- `npm.cmd ci --ignore-scripts --no-fund --no-audit`: 72개 패키지 설치 성공.
- `npm.cmd run typecheck`: 성공.
- `npm.cmd test`: 8건 성공.
- `npm.cmd run build`: 성공.
- 최초 샌드박스 내 테스트·빌드는 자식 프로세스 생성 EPERM으로 실패했다. 승인 실행 환경에서 재실행해 통과했다.
- 최초에는 기존 PC의 전용 Node, PostgreSQL 설치 및 비공개 DB 연결 파일이 발견되지 않았다. 전용 Node는 위와 같이 설치했으며, DB 검수·마이그레이션·seed·실제 Google 로그인·HTTP 통합 검수는 미실행이다.

## 실행과 비공개 설정

```powershell
.\scripts\app.cmd run doctor
.\scripts\app.cmd run typecheck
.\scripts\app.cmd test
.\scripts\app.cmd run build
```

`doctor`는 파일 존재와 Node 버전을 검사한다. 누락 또는 버전 차이는 종료 코드 1이며 인증정보·접속 문자열을 출력하지 않는다. DB 접속이나 파일 내용의 유효성을 검사하는 명령은 아니다.

기존 기본 경로 `%LOCALAPPDATA%\boot_erp`는 그대로 지원한다. 다른 비공개 위치를 사용할 경우 저장소 밖 경로를 지정한다.

```powershell
$env:BOOT_ERP_LOCAL_ROOT = 'C:\boot_erp_private'
# 이 폴더 아래 postgres\connections.json 및 auth\encryption.key 사용
$env:BOOT_ERP_GOOGLE_OAUTH_FILE = 'C:\boot_erp_private\google-oauth.json'
.\scripts\app.cmd run doctor
.\scripts\app.cmd run local -- dev
```

새 PC의 DB는 [기반 안내](foundation.md)의 독립 개발/시험 DB와 owner/app 역할을 먼저 준비한다. connections.json은 dev, dev_migration, test, test_migration 키마다 user/password/host/port/database 필드를 가진다. localhost:55432, boot_erp_dev/test 및 해당 app/owner 계정 제한은 유지한다. 실제 비밀번호는 저장소에 넣지 않는다.

Google 설정과 최초 관리자 준비는 [Google 연결](google-login-setup.md), [02 안내](phase-02-guide.md)를 따른다. `init:auth-key`도 BOOT_ERP_LOCAL_ROOT를 사용하며 기존 키를 보존한다. 비공개 파일 복사 또는 신규 생성 전, 기존 인증 데이터와 키의 연속성을 확인한다. 새 키를 기존 DB에 임의 적용하지 않는다.

DB와 인증 설정을 준비하기 전에도 타입 검사·단위 테스트·빌드는 가능하다. DB와 로그인까지 동작하는 개발 환경 인수는 아직 완료하지 않았다.
