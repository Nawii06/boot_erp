# P0 새 PC 환경 진단·격리 DB 준비

2026-11-06 / Asia/Seoul. 마지막 확인 00:49:46 KST. [P0 프롬프트](../completion-prompts.md)와 [실행 규약](../execution-checks.md)에 따른 환경 작업이다. UI/업무 기능 전체 완료나 실제 Google 로그인 검증을 의미하지 않는다.

## 1. 기준과 보존 범위

- 저장소 HEAD: `32878717dae0dab1d9a81e9efeead989533f626e`. 기존 미커밋 코드·문서와 다른 담당자의 UI 작업을 보존했다.
- 저장소 내 작성 파일은 이 기록뿐이다. 빌드·웹 서버 시작·seed·실자료 입력·Notion 변경은 수행하지 않았다.
- 기존 PostgreSQL 5432 서비스·자료·설정은 건드리지 않았다. 새 DB는 별도 `127.0.0.1:55432`에만 준비했으며 Windows 서비스나 자동 시작을 등록하지 않았다.
- 기존 OAuth 파일·암호화 키·계정의 연속성을 추정하지 않았다. Google 자격증명과 인증 암호화 키는 생성·교체하지 않았다.

## 2. 최초 진단

| 항목 | 확인 결과 |
|---|---|
| 프로젝트 전용 Node/npm | 24.21.0 / 11.19.0, 저장소 지정 버전 일치 |
| Node 설치 ZIP | 보관된 공식 체크섬 파일과 SHA256 재대조 일치 |
| 앱 의존성 | 설치됨 |
| 비공개 root override | BOOT_ERP_LOCAL_ROOT 미설정, 기본 `%LOCALAPPDATA%\boot_erp` 사용 |
| 기존 전용 DB root/data | 없음 |
| connections.json | 없음 |
| 인증 encryption.key | 없음 |
| Google OAuth 파일 지정 | BOOT_ERP_GOOGLE_OAUTH_FILE 미설정 |
| DB URL 환경변수 | DATABASE_URL / MIGRATION_DATABASE_URL / TEST_DATABASE_URL 미설정 |
| PostgreSQL 바이너리 | 기본 PostgreSQL 경로·PATH·프로젝트 도구 경로에서 발견되지 않음 |
| Docker | PATH에서 발견되지 않음 |
| 전용 55432 | TCP 연결 거부, listener 없음 |

이 진단은 승인된 기본/설정 경로와 알려진 도구 위치의 확인이다. PC 전체의 모든 파일·원격 자료가 없다는 뜻은 아니다. 기존 비공개 원본을 찾기 위해 사용자 폴더 전체를 검색하거나 비밀값을 출력하지 않았다.

## 3. 공식 portable 배포 검증·설치

[PostgreSQL Windows 공식 안내](https://www.postgresql.org/download/windows/)에서 EDB가 제공하는 설치 없는 ZIP 배포 경로를 확인했다. [EDB binaries 목록](https://www.enterprisedb.com/download-postgresql-binaries)의 18.6을 기준으로 Windows x64 revision 5 archive를 사용했다.

- 파일: `postgresql-18.6-5-windows-x64-binaries.zip`, 384,620,317 bytes.
- 공급자 URL: `https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip`.
- SHA256: `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2`.
- EDB 서버의 [SHA256 sidecar](https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip.sha256)와 [공급자 저장소의 확인 답변](https://github.com/EnterpriseDB/edb-installers/issues/746)을 대조하고 내려받은 archive 해시가 같은지 검증했다. 다른 revision/installer의 해시를 대체 사용하지 않았다.
- 도구 위치: `%LOCALAPPDATA%\boot_erp\tools\postgresql-18.6-5\pgsql`. 새 경로에 서버 실행에 필요한 bin/lib/share를 추출했다. archive 항목의 최종 경로가 대상 아래에 있는지 검사했다.
- 실제 `postgres.exe --version`, `initdb.exe --version` 결과 모두 PostgreSQL 18.6이다.

영구 PATH·PowerShell 정책·Windows 서비스는 변경하지 않았다. 기존 `scripts/toolchain.cmd`의 `C:\Program Files\PostgreSQL\18\bin` 참조도 이 작업에서 수정하지 않았다. 새 DB 시작/정지에는 위 portable 경로의 pg_ctl을 사용해야 한다.

## 4. 새 격리 클러스터와 계정

초기화 직전에 전용 DB root 부재와 55432 listener 부재를 다시 검사했다. 그 뒤 새 `%LOCALAPPDATA%\boot_erp\postgres`만 만들었다.

- root ACL 상속을 끊고 현재 Windows 사용자와 SYSTEM만 허용했다. data·connections.json·admin.pgpass에도 이 권한만 적용됨을 확인했다.
- initdb: UTF8, C locale, SCRAM-SHA-256. 관리 계정은 새 전용 클러스터에만 사용한다.
- 서버 설정: listen_addresses `127.0.0.1`, port `55432`, timezone `UTC`, password_encryption `scram-sha-256`.
- 관리 및 4개 owner/app 역할의 비밀번호는 각각 무작위로 생성했다. 비밀값을 SQL 파일·명령행·대화·저장소에 출력하지 않았다.
- 관리자 접속정보는 private admin.pgpass, 앱/마이그레이션 접속정보는 private connections.json에만 저장했다. 파일 생성은 기존 파일이 있으면 중단하도록 했다. 임시 initdb 비밀번호 파일은 성공 후 제거했다.
- 개발/시험 DB는 `boot_erp_dev` / `boot_erp_test`, 각각 독립 owner/app 역할을 사용한다. app의 public CREATE와 다른 DB CONNECT는 거부되며 4개 역할은 SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS가 없다.
- 기본 권한은 [새 PC 안내](../foundation.md)의 owner/app 분리와 default privileges 구성을 따랐다. 웹 프로세스에 owner/test/admin 접속정보를 함께 주입하지 않는다.

역할 생성의 첫 실행은 Windows의 Node `-e` 인자 인용 문제로 JavaScript 파싱 단계에서 종료됐다. SQL이나 연결파일 생성 전 실패였다. 같은 내용을 stdin으로 공급하여 재실행했고 비밀값을 출력하지 않은 채 성공했다.

## 5. 마이그레이션과 실제 DB 상태

현재 저장소의 마이그레이션 5개를 새 개발/시험 DB에 각각 적용했다. 기존 DB의 down·초기화·자료 삭제는 하지 않았다.

| 대상 | 서버/포트/시간대 | migration | public base table | users/projects/drafts | app DDL/교차 DB |
|---|---|---:|---:|---|---|
| 개발 | 18.6 / 55432 / UTC | 5 | 31 | 0 / 0 / 0 | 모두 거부 |
| 시험 | 18.6 / 55432 / UTC | 5 | 31 | 0 / 0 / 0 | 모두 거부 |

31개는 업무 테이블 30개와 migration_history 1개다. DB/HTTP 핸들러 검수는 시험 DB의 임시 고유 스키마에 가상자료로 수행했다. 검수 뒤 개발/시험 DB의 `foundation_test_*` 스키마가 각각 0개임을 확인했다. 영구 개발/시험 public 스키마에 사용자·과제·지출 초안을 입력하거나 seed하지 않았다.

## 6. 실행 증거

| 명령/관찰 | 시작~종료 KST | 종료/결과 | 범위 |
|---|---|---|---|
| `.\scripts\app.cmd run doctor` 최초 | 00:42 최초 진단, 개별 초 미수집 | 1 | Node/deps 정상, DB/키/Google 누락 |
| `.\scripts\app.cmd run typecheck` | 00:42:06~00:42:13 | 0 | TypeScript 통과 |
| `.\scripts\app.cmd test` sandbox | 00:42:32~00:42:32 | 1 | 자식 프로세스 spawn EPERM, 3개 파일 실행 실패 |
| `.\scripts\app.cmd test` 승인 재실행 | 00:42:45~00:42:47 | 0, 8/8 | 단위·Google 설정·OIDC 통과 |
| portable 검증/추출·initdb·계정/DB 생성 | 개별 시작/종료시각 미수집 | 최종 각 명령 0 | 공급자 SHA256·18.6·restricted ACL·새 DB 준비 확인 |
| `.\scripts\app.cmd run local -- migrate` | 00:47:51~00:47:52 | 0, 5개 적용 | 새 개발 DB |
| `.\scripts\app.cmd run local -- migrate:test` | 00:47:52~00:47:53 | 0, 5개 적용 | 새 시험 DB |
| `.\scripts\app.cmd run local -- test:db` | 00:48:06~00:48:15 | 0, 51/51 | 부모 4건 포함, 01~03 회귀·04 제한 범위 |
| DB 역할/상태·파일 ACL·임시 스키마 확인 | 최종 00:49:46 | 0 | 전용 localhost·최소권한·빈 public 업무자료·검수 정리 |
| `.\scripts\app.cmd run doctor` 최종 | DB 준비 뒤, 개별 초 미수집 | 1 | DB 연결파일 정상, 인증키/Google 미준비 |

EPERM은 샌드박스 실행 제한으로 분류하고 승인 재실행으로 확인했다. 초기 실패나 설정 누락을 통과로 기록하지 않는다. 설치 과정 일부 명령의 정확한 시각은 수집하지 못했으므로 임의로 채우지 않았다.

검수 코드 식별은 위 HEAD와 다음 실행 당시 blob 해시를 함께 사용한다. UI가 이후 변경되더라도 이 검사를 모든 UI 검수의 증거로 확대하지 않는다.

| 파일 | 실행 당시 Git blob |
|---|---|
| package.json | `8957c716a63b7e92d5dffa95e877d05ddb0ea781` |
| package-lock.json | `49adef5b8f72ac27fa468b0fa7f9e091f796087a` |
| scripts/app.cmd | `b64d360056bb155f9d18c991a42e549081829a92` |
| scripts/local.mjs | `2c5ce3a4893217d1c40601eb02dfb98020f53160` |
| tests/unit.test.ts | `30d809b6100404d913be8db656e9de8d6e5f0722` |
| tests/google-config.test.mjs | `cf5aad57f9d4768d500971c5d7de610fe8a2770f` |
| tests/oidc.test.ts | `a44c1f73532261f9dc01606cdae6ffd12a4c619d` |

## 7. 잔여 차단과 다음 작업

P0 전체는 아직 통과가 아니다. 기존 Google OAuth 파일 및 인증 암호화 키의 연속성이 확인되지 않아 실제 로그인·세션 대표 경로 검수는 `not_run/blocked`다. 생성한 빈 DB를 기존 실제 인증/업무 DB 복원으로 오인하지 않는다. 기존 데이터·키를 인수할지, 새 로컬 인증 환경을 준비할지는 사용자/담당자의 명시적 범위 확인이 필요하다.

독립적인 P1 정책 정리·P2 UI 구현과 가상 DB/핸들러 검수는 진행할 수 있다. 실제 Google 로그인·자료 복원·실자료 입력·운영 배포·Notion 연계의 조건을 낮추지 않는다. 새 전용 DB는 실행 중이며 관리자 비공개 파일은 웹 프로세스에 사용하지 않는다.

프로젝트 전용 DB 상태 확인/종료가 필요한 경우 동일 사용자 환경에서 다음 명령을 사용한다. 실행 중인지 먼저 확인하고 기존 자료 폴더를 삭제하거나 다시 initdb하지 않는다.

```powershell
$taskDbRoot = Join-Path $env:LOCALAPPDATA 'boot_erp\postgres'
$taskPgBin = Join-Path $env:LOCALAPPDATA 'boot_erp\tools\postgresql-18.6-5\pgsql\bin'
& (Join-Path $taskPgBin 'pg_ctl.exe') status -D (Join-Path $taskDbRoot 'data')
# 개발/시험 작업이 모두 끝난 뒤 필요한 경우에만 종료
& (Join-Path $taskPgBin 'pg_ctl.exe') stop -D (Join-Path $taskDbRoot 'data') -m fast -w
```
