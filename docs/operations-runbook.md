# 운영 준비와 로컬 백업·격리 복원 검수

2026-11-06 / Asia/Seoul. P7의 운영 준비 도구 안내다. 현재 도구는 새 전용 localhost 개발/시험 클러스터를 대상으로 한다. 운영 서버 배포·운영 복구·실제 데이터 입력을 수행하는 명령이 아니다.

## 현재 준비 범위와 G1 한계

- 전용 Node 24.21.0/npm 11.19.0, PostgreSQL 18.6/127.0.0.1:55432 환경을 사용한다. [P0 환경 기록](history/2026-11-06-p0-environment.md)을 따른다.
- 배포 대상·운영 접근 범위·TLS·운영 비밀정보 주입·장애 담당자는 아직 확정되지 않았다.
- 운영 자료량·파일량·보존기간·검역, RPO(허용 손실시간)·RTO(목표 복구시간), 별도 백업 보관소·보관주기도 미확정이다.
- 현재 비공개 Google OAuth 파일과 기존 인증 암호화 키가 준비되지 않았다. 실제 로그인 및 암호화된 인증자료 복구는 검증하지 않았다. 기존 키를 새로 생성하거나 바꾸는 것으로 해결하지 않는다.
- 이 도구의 로컬 복원 성공은 운영 인수 완료가 아니다. 위 운영/인증/복구 조건과 [F0 최종 필수](execution-checks.md)가 남아 있으면 G1 전체 완료를 선언하지 않는다.
- 실제 자료 입력은 G1 이후 지정된 P8 범위에서, Notion 연계는 G2 이후 P9에서 수행한다.

## 환경별 설정 경계

| 환경 | 설정·검증 | 현재 결과 |
|---|---|---|
| 로컬 개발 | `local -- dev/start`, private connections의 제한 dev app 역할, owner URL은 migrate 프로세스에만, localhost:3000 OAuth | DB/빌드 검증, 실제 OAuth 파일/원래 키 미준비 |
| 격리 시험 | test app/owner 분리, UUID 시험 스키마, 가상 계정·기준·증빙, production build의 빈 3000 포트 | DB/HTTP/4역할·3뷰포트/E2E 검수, 생성한 시험 객체만 정리 |
| 향후 운영 | `.env.example`의 HTTPS 항목을 기관의 비공개 주입 설정으로 확정, 제한 DB 역할, 웹 프로세스에서 owner/migration/test URL 제외, Google callback은 확정 origin과 일치 | 대상 미정. 기관 TLS/방화벽/인증·보존/검역/성능/백업목표·배포/롤백 미실행 |

웹 인증 코드는 HTTPS origin에서 Secure cookie와 같은 origin의 callback/CSRF를 검사한다. 로컬 credentials helper와 백업/seed/recovery 도구는 로컬 제한을 유지한다. 운영 대상이 정해졌다는 이유만으로 로컬 도구의 보호 조건을 지우거나 실제 DB에 seed/down을 실행하지 않는다. 운영별 비밀정보/DB 권한/TLS/검역/복구 검증은 확정된 대상에서 별도 수행한다.

## 백업 도구의 자료 범위

[`backup-local.mjs`](../scripts/backup-local.mjs)는 dev 또는 test의 **owner 역할**로 public 스키마의 custom-format PostgreSQL archive를 만든다. 웹 app 역할이나 클러스터 관리자를 일반 백업 연결로 사용하지 않는다.

- 대상은 `boot_erp_dev`/`boot_erp_test`, localhost:55432뿐이며 production 모드를 거부한다.
- repeatable-read read-only 트랜잭션의 exported snapshot을 pg_dump와 검증 manifest 조회에 공통 사용한다. 백업 중 다른 가상 검수가 실행되더라도 서로 다른 시점의 표/합계를 섞지 않는다.
- manifest는 서버/마이그레이션 버전·열 정의·테이블별 건수·정수/numeric 열의 정확한 합계·첨부 내용 SHA256·archive SHA256을 기록한다. manifest의 금액 합계는 복원 무결성 대조용이며 업무 보고서의 실적 정의를 대신하지 않는다.
- 공개 파일명·로그에 실제 사람 이름·금액·계좌·증빙 파일명을 넣지 않는다. 실제 DB archive와 manifest는 모두 비공개 자료로 취급한다.
- 현재 첨부는 DB bytea에 저장되므로 DB archive에 함께 들어간다. 향후 파일 저장소가 분리되면 같은 기준시점의 객체·버전·해시 백업을 추가하기 전까지 이 도구만으로 전체 복구가 된다고 보지 않는다.
- Google JSON·관리자 pgpass·connections.json·인증 암호화 키는 DB archive에 포함하지 않는다. 암호화된 자료가 있는 DB는 원래 키의 별도 안전한 보관·복구 절차 없이는 운영 복구에 충분하지 않다.

## 경로·권한과 아티팩트

기본 보관 위치는 `%LOCALAPPDATA%\boot_erp\backups`다. 저장소와 PostgreSQL data directory 밖이며, 현재 Windows 사용자와 SYSTEM만 허용하도록 만든다. Windows 서비스나 영구 PATH를 변경하지 않는다.

`BOOT_ERP_BACKUP_ROOT`로 다른 전용 비공개 폴더를 지정할 수 있다. 절대경로·저장소/PGDATA 밖·존재하는 부모 경로가 필요하다. 기존의 임의 폴더는 도구 소유 marker가 없으면 채택하거나 ACL을 변경하지 않는다. 기존 marked 폴더는 보호된 ACL·현재 사용자 소유·사용자/SYSTEM FullControl만 존재하는지 읽기 검증하며 ACL을 반복 설정하지 않는다. 실제 운영 보관소를 선정했다는 뜻은 아니다. 단일 PC 장애까지 대비하려면 기관이 승인한 별도 저장 위치·권한·암호화·보존정책을 정해야 한다.

PostgreSQL 도구 기본 경로는 `%LOCALAPPDATA%\boot_erp\tools\postgresql-18.6-5\pgsql\bin`이다. 다른 승인된 설치는 `BOOT_ERP_PG_BIN` 절대경로로 지정한다. pg_dump/pg_restore의 실제 18.6 버전을 검사하고 저장소 안 실행파일은 사용하지 않는다.

성공한 백업은 무작위 ID `backup-<32자리 hex>`의 `.dump`와 `.json` 쌍이다. 기존 ID 파일을 덮어쓰지 않는다. pg_dump 실패 등으로 manifest가 완성되지 않은 archive는 성공 백업이 아니며 복원 도구가 채택하지 않는다. 기존 백업을 자동 삭제하거나 retention을 임의 적용하지 않는다.

## 실행

현재 대상이 새 격리 개발/시험 DB이고 원본을 보존할 수 있는지 먼저 확인한다. 자격증명을 명령행에 붙이거나 private JSON을 출력하지 않는다.

```powershell
$taskNode = Join-Path $env:LOCALAPPDATA 'boot_erp\tools\node-v24.21.0-win-x64\node.exe'
# dev 또는 test 중 지정한 한 DB의 백업. 실패하면 이후 복원 명령을 실행하지 않음
$taskBackup = & $taskNode scripts/backup-local.mjs dev | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Local backup failed' }
# 방금 받은 무작위 ID를 사용. 기존 DB에 덮어쓰지 않음
& $taskNode scripts/restore-check.mjs $taskBackup.id
if ($LASTEXITCODE -ne 0) { throw 'Isolated restore verification failed' }
```

`backup-local.mjs`는 owner 접속정보를 private connections.json에서 읽고 PostgreSQL 자식 프로세스에 환경변수로만 공급한다. 도구 원시 출력은 억제하며 실패에 실제 접속 문자열이나 SQL을 노출하지 않는다.

## 격리 복원의 경계

[`restore-check.mjs`](../scripts/restore-check.mjs)는 private backup root의 신뢰된 자체 생성 ID만 받는다. 임의 경로·URL·다른 사람이 제공한 archive를 복원하는 명령이 아니다. 일반 개발/시험 DB를 복원 대상으로 지정하는 옵션도 제공하지 않는다.

1. marker·파일 형식·manifest·archive SHA256·서버 버전을 확인한다.
2. 전용 private 클러스터 관리자 연결로 존재하지 않는 `boot_erp_restore_<32자리 hex>` DB와 해당 UUID의 임시 restricted owner 역할만 생성한다.
3. 실제 pg_restore는 새 restricted owner로 실행한다. 복원 SQL에 클러스터 superuser를 사용하지 않는다.
4. 복원된 스키마/마이그레이션·건수·정확한 numeric 합계·첨부 내용 해시를 백업 당시 manifest와 비교한다. 현재 사용 중인 원본 DB가 이후 변경돼도 당시 snapshot 기준으로 대조한다.
5. 이번 호출이 생성 완료한 임시 DB/역할만 정리한다. `boot_erp_dev`/`boot_erp_test`/기존 역할은 제거하지 않는다. busy 등의 이유로 임시 DB 정리에 실패하면 강제 제거하지 않고 임시 UUID와 실패를 보고한다.

cleanup 실패 시 원본 DB를 초기화하지 않는다. 전용 클러스터 관리자가 보고된 무작위 UUID와 실제 임시 객체 소유관계를 확인한 뒤 해당 실험 아티팩트만 별도로 처리한다. 다른 작업에서 사용 중인 DB/역할을 이름 일부 일치만으로 제거하지 않는다.

pg_restore의 clean/if-exists 옵션은 방금 생성하고 소유관계를 확인한 임시 DB의 기본 public 스키마 충돌만 처리한다. 기존 dev/test에 이 명령을 적용하는 경로는 없다. 자식 PostgreSQL 도구에는 상속된 PGHOSTADDR·PGSERVICE·PGOPTIONS 등 모든 libpq 설정을 제거한 뒤 고정된 로컬 접속정보만 공급한다.

## 검증과 운영 전환 체크

| 범위 | 필요한 증거 |
|---|---|
| 도구 안전 | 저장소/PGDATA 경로 거부, production/임의 DB 거부, 기존 폴더 보존, 잘못된 manifest/hash 거부, cleanup 실패 비파괴·비밀값 미출력 |
| 기본 복원 | 정확한 서버/마이그레이션, archive와 snapshot manifest 일치, 새 임시 DB로 복원 후 건수·numeric 합계·첨부 hash 비교, 임시 객체 정리 |
| 자료 있는 복원 | 가상 신청·지급·환입·첨부 버전·계정/권한으로 채운 별도 검증 환경에서 동일 검수 |
| 운영 복구 | 지정 운영 환경에서 DB+별도 파일/버전+필요 키의 동일 기준시점 복구, 인증/세션·권한·업무 합계·파일 표본 재확인, 실제 소요시간·손실 범위 측정 |
| 운영 인수 | 대상/담당자·TLS·접속 범위·비밀정보·보존/검역·백업 위치/주기·RPO/RTO·모니터링·복구 절차 확정 |

운영 복구와 RPO/RTO 검수는 target과 목표값이 정해진 뒤 별도 수행한다. 빈 개발 DB의 복원 통과를 실자료·운영 키·실제 Google 인증까지 검수한 것으로 확대하지 않는다.

## 이번 실행 기록

2026-11-06, 지정 Node에서 다음을 실행했다.

| 검사 | KST 시작~종료 | 결과 |
|---|---|---|
| `node --test tests/backup.test.mjs` 기본 | 00:59:04~00:59:05 | 9/9 통과, exit 0 |
| 실제 DB 왕복 첫 시도 | 01:05:13~01:05:14 | 9/10, 기존 backup 폴더 ACL 재설정에서 실패 |
| 원시 출력을 가린 도구/분류 진단 | 01:05:53~01:05:54 | 같은 ACL 단계 실패를 확인 |
| ACL 보정 후 기본+가상 clone 왕복 | 01:07:01~01:07:09 | 10/10 통과, exit 0 |
| dev 백업+별도 DB 복원+원본/정리 확인 | 01:07:38~01:07:41 | 성공, exit 0 |
| 신청·지급·환입·감사 포함 확장 clone 복원 | 01:28:52~01:29:00 | 10/10 통과, exit 0. 아래 금액·관계 추가 확인 |

첫 실패는 기존 폴더의 ACL 재설정에 필요한 SeSecurityPrivilege 부재였다. 기존 marked 폴더에서는 ACL을 다시 쓰지 않고 보호 상태와 권한을 검증하도록 수정했다. Windows 권한을 완화하지 않았다. 명령 실패 시 raw PostgreSQL 출력 대신 도구명·종료코드·고정된 오류 분류만 진단할 수 있다.

실제 DB 시험은 명시적 환경변수 `BOOT_ERP_RUN_BACKUP_DB_TEST=1`일 때만 추가 실행한다. 기본 9건은 DB를 사용하지 않는다.

```powershell
$taskNode = Join-Path $env:LOCALAPPDATA 'boot_erp\tools\node-v24.21.0-win-x64\node.exe'
$env:BOOT_ERP_RUN_BACKUP_DB_TEST = '1'
& $taskNode --test tests/backup.test.mjs
$taskCheckExit = $LASTEXITCODE
Remove-Item Env:BOOT_ERP_RUN_BACKUP_DB_TEST
if ($taskCheckExit -ne 0) { throw 'Local backup/restore tests failed' }
```

검수 당시 source의 마이그레이션 7개와 public 40개 테이블(업무 39+이력 1)을 대조했다. 원본 test는 읽기 전용으로 백업하고 신규 임시 clone에만 가상 사용자/과제·9,007,199,254,740,993원 예산·첨부 2버전을 넣었다. 이 clone의 새 snapshot을 다시 archive로 만든 뒤 다른 신규 임시 DB에 복원해 schema·migration·건수·numeric 합계·첨부 내용 SHA256을 대조했다. 기존 dev/test public에는 fixture를 넣지 않았다.

검수 후 임시 restore DB와 역할은 각각 0개, dev/test public의 사용자/과제는 각각 0/0, migration은 각각 7개임을 확인했다. 테스트가 만든 가상 archive/manifest는 정리했고 별도로 실행한 dev 백업 1쌍은 비공개 보관 위치에 남겼다. 운영 데이터·키·인증·전체 업무 복구/RPO/RTO는 이 통과 범위에 포함하지 않는다.

### F0 확장 복원 확인

같은 명시적 DB 검수 모드의 fixture를 확장해 기준·초안/첨부 버전·신청·동결 제출본·검토의견·실청구·부분 지급·환입·예산 복원·마감·감사 영수증을 넣었다. 이 자료는 새 임시 clone에만 SQL 제약에 맞춰 생성한 가상자료이며 운영 기준값이나 실적이 아니다.

| 가상 사실 | 검증 값 |
|---|---|
| 최초/현재 예산 | 9,007,199,254,740,993원, 정밀도 보존 |
| 신청·지급 총액 | 800원 |
| 지급 내역 | 300원 + 500원, 공제 합계 80원, 실수령 합계 720원 |
| 환입·예산 복원 | 원 지급 연결 200원 환입 및 동일 연차 복원 1건 |
| 유효 차감 | 800−200=600원, 가용액=현재예산−600원 |
| 보존 | 정책/제출본 1개, 초안·첨부 각 2버전, 마감 1건, budget 감사/영수증 각 8건 |

public 40개 테이블의 schema·migration·건수·numeric 합계·첨부 hash 전체 대조에 더해, 독립된 다른 신규 복원 DB에서 실제 JOIN으로 신청→초안→과제/업무→예산항목→정책→제출 파일 snapshot의 ID 연결을 확인했다. 실청구와 지급 2건, 원지급과 환입/복원 1건, 마감 1건, 감사와 영수증 8건의 관계도 확인했다. 이 검수의 새 DB/역할/테스트 백업만 정리했으며 원본 dev/test의 public 자료는 변경하지 않았다.

01:30:17~01:30:18 KST 최종 읽기 확인에서 dev/test의 migration 7·public 테이블 40, 사용자/과제/초안/신청/집행건/지급/환입 각 0을 재확인했다. 임시 restore DB/역할도 각각 0개다.

운영용 Google/암호화 키 복구와 실제 사용자의 인증·권한 재인수는 여전히 미검증이다. 가상 거래 archive 복원 통과를 이 경계까지 확대하지 않는다.
