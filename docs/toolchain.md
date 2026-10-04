# 확정 기술과 개발환경 실행 방법

2026-10-05 / Asia/Seoul. 사용자의 “적절하다면 진행” 지시에 따라 검토·확정했다. 결정기록 T-01/T-02가 D-01의 이전 제안을 대체한다. 준비 범위는 이번 Windows 환경이며 운영 서버나 별도 PC까지 검증한 것은 아니다.

## 확정 구성

| 영역 | 확정 버전 | 선택 이유·경계 |
|---|---|---|
| 웹 | Next.js 16.3.8 App Router, React/React DOM 19.3.0 | 화면과 서버 코드를 함께 관리. 업무 처리·DB/파일 권한은 Node 서버에서 검사 |
| 언어 | TypeScript 5.9.3, strict | 실제 API 호환을 검증한 5.x로 고정. 최신 7.0.2 자동 도입은 하지 않음 |
| 런타임 | Node.js 24.21.0 LTS, npm 11.19.0 | 공식 ZIP·SHA256 확인, package-lock.json으로 설치 의존성 고정 |
| DB | PostgreSQL 18.6 | 트랜잭션·행 잠금·정확한 금액·관계 제약을 예산/지급 업무 기반으로 사용 |
| 조회·트랜잭션 | Drizzle ORM 0.45.3, pg 8.23.1 | TypeScript 쿼리와 직접 SQL을 함께 사용 |
| 마이그레이션 | node-pg-migrate 9.0.0 | 검토 가능한 SQL 변경 이력, 전용 마이그레이션 계정으로 적용 |
| 타입 도구 | @types/pg 8.23.1 | pg·Drizzle·마이그레이션 API 컴파일 검사 |
| 개발 실행 | Windows x64, PowerShell/CMD | 현재 PC에서 검증. 운영 OS나 Docker/WSL 도입을 확정한 것은 아님 |

Prisma도 트랜잭션을 지원하지만, 이 프로젝트는 금액 원장·잠금·감사 제약을 SQL로 직접 검토하기 쉬운 구성을 선택했다. SQL 마이그레이션을 DB 구조의 기준으로 관리하고 Drizzle 타입 정의를 같은 변경 단위로 갱신한다. 01단계에서 실제 DB와 타입 정의의 일치를 검사한다. Django 전환이나 별도 API 서버는 현재 요구상 필요하지 않다.

처음 검토한 Drizzle Kit 0.31.11은 간접 의존성 esbuild 보안 경고로 최종 구성에서 제외했다. moderate 4건은 같은 문제의 의존성 경로를 포함한 집계이며 독립된 취약점 4개를 뜻하지 않는다. node-pg-migrate로 변경 후 audit 0건을 확인했다. 강제 다운그레이드·의존성 override는 사용하지 않았다.

ORM은 권한·중복처리·동시 예약을 자동 해결하지 않는다. 원 단위 금액은 PostgreSQL bigint와 TypeScript bigint를 기준으로 하며 JSON에서는 문자열로 직렬화한다. 트랜잭션·잠금·멱등성·감사이력은 업무 구현에서 별도로 검수한다.

## 실제 준비 결과

| 항목 | 확인 결과 |
|---|---|
| Node/npm | `%LOCALAPPDATA%\boot_erp\tools\node-v24.21.0-win-x64` 설치, 실제 24.21.0/11.19.0 출력 |
| ZIP 검증 | 공식 SHA256 `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` 일치 |
| 실행기 | scripts/toolchain.cmd가 해당 프로세스 PATH만 설정. 영구 PATH·PowerShell 실행 정책 변경 없음 |
| 기존 DB | 5432 서비스와 데이터·계정·설정 보존. 기존 바이너리 18.6만 재사용 |
| 프로젝트 DB | 별도 `127.0.0.1:55432` 클러스터, 실제 서버 18.6 접속, UTC·SCRAM-SHA-256 설정 |
| 개발·시험 | `boot_erp_dev`, `boot_erp_test` 빈 DB. 각 DB에 독립 owner/app 역할; app 교차 접속 거부 확인 |
| 권한 | owner는 자기 DB DDL 가능, app은 public 스키마 CREATE 불가. 모두 SUPERUSER/CREATEDB/CREATEROLE 없음 |
| 비밀파일 | DB·로그·자격증명은 `%LOCALAPPDATA%\boot_erp\postgres`에만 저장. 현재 Windows 사용자와 SYSTEM만 허용하는 NTFS ACL |
| 개발 DB 상태 | 검수 종료 시 실행 중. Windows 서비스·부팅 자동 시작 미등록 |
| IDE | 최초 VS Code/확장 파일 관찰은 유지. IDE 로그인은 이번에 재검증하지 않음 |

무작위 비밀번호를 사용하는 `connections.json`(dev/test 및 dev_migration/test_migration)과 `admin.pgpass`는 비공개 폴더에만 둔다. 관리자 계정은 이 새 클러스터의 유지관리용이며 앱에서 사용하지 않는다. 실제 업무자료·원본 증빙은 넣지 않았다. 로컬 파일 준비가 운영 보관소 결정을 뜻하지 않는다.

## 실행 방법

저장소 루트 PowerShell에서 실행한다. 도구 실행기는 CMD이므로 PowerShell 정책을 완화하지 않는다.

```powershell
.\scripts\toolchain.cmd ci --ignore-scripts --no-fund
.\scripts\toolchain.cmd run typecheck
.\scripts\toolchain.cmd run check
.\scripts\toolchain.cmd run check:migrations
.\scripts\toolchain.cmd audit
```

최초 설치는 `install --ignore-scripts --no-fund`로 잠금파일을 생성했다. `ci`는 잠금파일 기반 재설치용이다. 도구는 tools/toolchain-check에만 있으며 앱 생성·빌드 명령이 아니다. `typecheck`는 API 사용 검사로 skipLibCheck를 적용한다.

**check는 00단계 빈 public 스키마 검사용이다. 01단계 업무 테이블 생성 후 그대로 실행하지 않는다.** check:migrations는 테스트 DB의 매 실행 고유 스키마에서 SQL up/반복 up/down을 검사하고 해당 스키마·임시 파일을 제거한다. 실제 ERP 마이그레이션 완료를 뜻하지 않는다.

DB 상태·시작·정지 명령(현재 사용자 세션):

```powershell
$taskDbRoot = Join-Path $env:LOCALAPPDATA 'boot_erp\postgres'
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' status -D (Join-Path $taskDbRoot 'data')
# 정지 상태에서만 시작
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' start -D (Join-Path $taskDbRoot 'data') -l (Join-Path $taskDbRoot 'server.log') -w
# 작업 종료 시 정지
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' stop -D (Join-Path $taskDbRoot 'data') -m fast -w
```

에이전트 샌드박스에서 비밀파일 접근이 거부되면 ACL을 풀지 않고 승인된 실행 환경에서 검증한다. 이번에도 EPERM 후 승인 재실행으로 통과했다. 다른 PC는 같은 Node/PostgreSQL 바이너리와 전용 DB·계정을 별도로 준비해야 하며, 이 실행기가 자동 설치하는 것은 아니다.

## 검수와 다음 단계

TypeScript API, pg/Drizzle 실제 접속, app 권한·교차 DB 차단, 큰 정수의 정확한 계산·문자열 반환, 트랜잭션 롤백, owner DDL 롤백, node-pg-migrate SQL 적용/반복 실행/down을 검증했다. 최종 npm audit은 0건이며 해당 시점의 알려진 취약점 조회 결과다.

**00단계의 01 진입 기술·환경 기준 충족. 01단계 착수 가능, 이번에는 미착수.** 앱 빌드·화면·로그인·업무 권한·동시 예약·실제 업무 마이그레이션·복구 검수는 01 이후 수행한다. 기관 정책 D-02~D-13과 IDE 로그인 확인은 후속 사항이다. [작업기록](history/2026-10-05-toolchain.md) 참고.

## 공식 근거

2026-10-05 조회. npm 공식 registry의 버전·engines·peerDependencies와 실제 설치 결과를 대조했다.

- [Next.js 설치 요구](https://nextjs.org/docs/app/getting-started/installation), [16.3.8 패키지](https://raw.githubusercontent.com/vercel/next.js/v16.3.8/packages/next/package.json)
- [Node 24.21.0](https://nodejs.org/en/blog/release/v24.21.0), [공식 배포 해시](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)
- [Drizzle PostgreSQL 연결](https://orm.drizzle.team/docs/get-started/postgresql-new), [트랜잭션](https://orm.drizzle.team/docs/transactions): 현재 안내의 RC 설치 예제 대신 안정 버전 0.45.3을 검증
- [Prisma 트랜잭션](https://www.prisma.io/docs/orm/fundamentals/transactions): 대안 비교
- [node-pg-migrate 9.0.0 README](https://github.com/salsita/node-pg-migrate/blob/v9.0.0/README.md): Node 20.11 이상·PostgreSQL 13 이상. 문서 사이트의 10 alpha와 설치 버전을 구분
- [PostgreSQL initdb](https://www.postgresql.org/docs/18/app-initdb.html)
- [esbuild 보안 공지](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99): Drizzle Kit 제외 근거
