# 01단계 개발 기반 인수인계

2026-10-05 / Asia/Seoul. 01단계의 실행 가능한 최소 기반이다. 업무 메뉴·실제 로그인·운영 배포는 포함하지 않는다. 기술 버전은 [T-01/T-02](07-decisions.md), 전체 논리 모델은 [데이터 설계](03-data-and-workflows.md)를 따른다.

후속 정책: Google 로그인·이메일 계정 관리·연구원 간 격리·책임자 전체 조회·재배정 자료 승계는 [AC-01~AC-06](07-decisions.md)으로 확정했다. 아래는 01 구현 당시의 코드 계약이며 새 정책이 자동 적용된 상태가 아니다. 특히 프로젝트 배정만 검사하는 함수와 닫힌 `sensitive.read`는 02에서 최신 권한을 구현할 때 확장해야 한다.

## 실행

준비된 Windows PC에서는 저장소 루트에서 다음을 실행한다. `scripts/app.cmd`는 사용자 전용 Node가 있으면 현재 프로세스 PATH에 추가하고, 없으면 설치된 npm을 사용한다. 영구 PATH나 실행 정책을 바꾸지 않는다.

```powershell
.\scripts\app.cmd ci --ignore-scripts --no-fund
.\scripts\app.cmd run local -- migrate
.\scripts\app.cmd run local -- migrate:test
.\scripts\app.cmd run local -- seed
.\scripts\app.cmd run local -- dev
```

브라우저: `http://127.0.0.1:3000`. 서버 종료: Ctrl+C. 포트가 사용 중이면 `run local -- dev --port 3101`처럼 명시한다. 개발 DB 시작/정지는 [toolchain.md](toolchain.md)의 `pg_ctl` 절차를 사용한다.

`local` 실행기는 저장소 밖 `%LOCALAPPDATA%\boot_erp\postgres\connections.json`을 읽어 자식 프로세스에 필요한 자격증명만 전달한다. 앱에는 app 계정, 마이그레이션에는 owner 계정, DB 검수에는 시험 계정만 전달한다. 파일을 저장소로 복사하거나 내용을 로그에 출력하지 않는다. DB 연결정보 없이도 빌드는 가능하며 `/api/health`는 연결 실패 시 상세정보 없는 503을 반환한다.

```powershell
.\scripts\app.cmd run typecheck
.\scripts\app.cmd test
.\scripts\app.cmd run local -- test:db
.\scripts\app.cmd run build
.\scripts\app.cmd run local -- start
# 별도 터미널, 서버 실행 중
.\scripts\app.cmd run test:http
.\scripts\app.cmd run check:docs
.\scripts\app.cmd audit
```

실제 검수에서는 dev 3101, start 3102를 사용하고 `$env:TEST_BASE_URL='http://127.0.0.1:3101'` 또는 3102로 HTTP 검수를 실행했다. 개발 서버와 프로덕션 서버를 동시에 같은 `.next` 빌드에 사용하지 않는다. 프로덕션 모드 실행은 로컬 빌드 검수이며 운영 배포가 아니다.

## 새 개발 PC

1. [확정 도구](toolchain.md)의 Node 24.21.0/npm 11.19.0, PostgreSQL 18.6을 준비하고 저장소를 clone한다. 전용 PostgreSQL 클러스터를 127.0.0.1:55432, SCRAM 인증으로 준비한다. 기존 5432 서비스는 사용하지 않는다.
2. 전용 클러스터 관리자가 아래 SQL로 빈 개발·시험 DB와 역할을 만든다. 역할의 비밀번호는 `psql`의 `\password 역할명`으로 각각 설정한다. SQL 파일·명령행에 실제 비밀번호를 적지 않는다.
3. `.env.example`을 참고해 승인된 비공개 환경변수 저장소에서 각 명령에 필요한 변수를 공급한다. Node 명령은 `.env.local`을 자동 읽지 않는다. 수동 `.env.local`을 쓸 경우 Node의 `--env-file` 등으로 주입한다. 웹 프로세스에는 `DATABASE_URL`만 공급하고 owner/test 자격증명을 같이 넣지 않는다.
4. `npm ci --ignore-scripts --no-fund`, `npm run db:migrate`, `npm run db:seed`, `npm run dev`를 순서대로 실행한다. 시험 마이그레이션은 시험 owner URL을 `MIGRATION_DATABASE_URL`에 공급해 실행한다. `npm run test:db`에는 `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`을 공급한다. `npm run build` 후 `npm start`도 확인한다.

```sql
-- 신규 전용 클러스터에서만. 이미 준비된 DB에 재실행하지 않는다.
CREATE ROLE boot_erp_dev_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE boot_erp_dev_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE boot_erp_test_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE boot_erp_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE boot_erp_dev OWNER boot_erp_dev_owner;
CREATE DATABASE boot_erp_test OWNER boot_erp_test_owner;
REVOKE ALL ON DATABASE boot_erp_dev FROM PUBLIC;
REVOKE ALL ON DATABASE boot_erp_test FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE boot_erp_dev TO boot_erp_dev_app;
GRANT CONNECT, TEMPORARY ON DATABASE boot_erp_test TO boot_erp_test_app;
ALTER DATABASE boot_erp_dev SET timezone TO 'UTC';
ALTER DATABASE boot_erp_test SET timezone TO 'UTC';
\connect boot_erp_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO boot_erp_dev_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boot_erp_dev_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO boot_erp_dev_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boot_erp_dev_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO boot_erp_dev_app;
\connect boot_erp_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO boot_erp_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boot_erp_test_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO boot_erp_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boot_erp_test_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO boot_erp_test_app;
```

위 초기 역할·DB 구문은 00단계에서 준비한 구조를 재현하는 안내다. 이번 검수는 현재 Windows의 잠금파일 재설치, 빈 개발·시험 DB에 첫 마이그레이션, 별도 임시 스키마의 매번 초기 생성으로 수행했다. 다른 PC 전체 설치나 운영 복구 검수까지 완료했다는 의미는 아니다.

## 모듈과 물리 DB 범위

| 위치 / 테이블 | 구현된 범위 | 후속 범위 |
|---|---|---|
| `src/app` | 한국어 준비 화면, DB 상태 API, 항상 미인증인 세션 경계 | 02 이후 실제 계정·업무 화면 |
| `people`, `users` | 사람과 계정 분리, 4종 역할 제약, 비활성 기본값, nullable 고유 인증 subject | 로그인 제공자, 계정 발급·정지, 역할 변경 감사 |
| `projects`, `project_memberships` | 과제/프로그램, 사용자 배정·유효기간·활성 상태 | 사업연차·재원·참여자 배정 이력과 관리 UI |
| `budget_lines` | 프로젝트 FK, 가상 내부 항목명, 변경 불가 최초금액 bigint | 공식 분류·연차·재원, 예산변경·가용액·예약 원장 (03) |
| `spend_cases` | 동일 집행 건 UUID, 신청자, 프로젝트 및 예산항목의 복합 FK | 사전신청·청구 버전/배분·공식 결재·실청구·지급·환입 (04~06) |
| `command_receipts`, `audit_events` | 행위자+요청 ID 중복 방지, 입력 지문, 결과·전후값·사유·시각 원자적 저장 | 업무별 서비스에서 실제 잠금·한도·정정 규칙 연결 |
| `src/lib` | 입력 UUID/문자열 검증, 원 단위 계산·JSON 문자열, 공통 오류 응답 | 단계별 입력 명세 |
| `src/server/storage.ts` | 비공개 저장소 인터페이스, 읽기·쓰기 비활성 | 권한 검사와 파일 검역 이후 실제 어댑터 (04) |

논리 모델 전체를 확정 업무 정책으로 승격하거나 모든 테이블을 선구현하지 않았다. 현재 `internal_label`은 공식 비목코드가 아니며 `original_amount`를 현재예산·가용액으로 표시하지 않는다. 승인·지급 상태나 예약 자동 발생 기본값도 없다. `users`의 단일 역할 열은 01 기반 표현이며 겸임 정책은 후속 결정이 필요하다.

## 서비스 계약

- 웹의 인증 제공자는 검증된 subject를 반환하는 인터페이스만 있고 현재는 항상 null이다. 개발 헤더·쿠키·고정 관리자 우회가 없다. 02에서 subject를 활성 DB 계정에 연결하고 요청마다 역할·배정을 확인해야 한다.
- 공통 접근 검사는 실제 DB의 계정 상태, 프로젝트와 배정 유효기간을 읽는다. 연구원·책임자는 배정 조회만, 업무 관리 쓰기는 담당자·관리자만 허용한다. 연구원 본인 제출은 04의 별도 행위로 구현한다. `sensitive.read`는 D-04 확정과 실제 기능 구현 전까지 모든 역할에서 닫혀 있다. 이는 관리자 권한의 업무 정책 변경이 아니다.
- `auditedCommand`는 신뢰된 서버 서비스만 호출한다. 현재 HTTP 쓰기 경로는 없다. 행위자+요청 ID로 트랜잭션 advisory lock을 잡고 현재 역할을 검사한 뒤 같은 요청을 한 번만 처리한다. 같은 ID의 다른 프로젝트/행위/사유/입력은 CONFLICT 오류이며 HTTP 연결 시 409로 매핑된다. 결과는 bigint를 문자열로 정규화한 JSON이다. 입력 JSON은 서비스가 일관된 키 순서로 구성한다.
- callback은 같은 `PoolClient`에서 행 잠금·버전 비교·업무 검증 후 결과와 전후값을 반환해야 한다. 오류는 전부 롤백되며 자동 재시도하지 않는다. 이번 동시성 검수는 공통 기반의 공유 행 잠금과 중복 명령이다. 동시 예산 예약 B-01이나 중복 지급 E-04의 업무 검수를 대신하지 않는다.
- 최초 예산, 처리 영수기록, 감사기록은 UPDATE/DELETE/TRUNCATE를 트리거로 거부한다. 앱에는 DDL·TRUNCATE 권한이 없으며 마이그레이션 이력 테이블 접근도 제거한다. DB 소유자의 DDL로 트리거를 제거하는 행위까지 앱에서 방지하는 것은 아니다.
- `server-only`로 DB/인증/저장소/서비스를 브라우저 import에서 차단한다. 오류 응답은 코드만 반환한다. 운영 로그·관측·보존 정책과 일반 업무 서비스별 감사 적용은 후속 단계다.

## 마이그레이션과 가상 데이터

SQL이 구조의 기준이다. 적용된 파일은 수정하지 않고 다음 SQL 마이그레이션으로 정정한다. Drizzle 스키마를 같은 변경에 갱신한다. 검수는 열/자료형/null 여부와 PK·고유·FK·CHECK 개수, 큰 정수 왕복 및 실제 제약 동작을 대조한다. 트리거는 SQL에서 관리한다.

마이그레이션·seed·DB 검수 실행기는 운영 모드, 원격 호스트, 다른 포트·DB·사용자를 거부한다. 향후 운영 마이그레이션은 10단계 배포 범위에서 별도 구성한다. 최초 SQL의 down은 데이터 손실 방지를 위해 명시적으로 거부한다. 실패한 up은 트랜잭션 롤백한다. 시험 검수는 매번 생성한 고유 스키마의 알려진 객체만 제거하며 기존 public 데이터는 삭제하지 않는다.

seed는 가상 참여자 1명·비활성 연구원 계정 1개·과제 1개·배정 1개·최초 가상예산 1개다. 인증 subject/비밀번호/실제 개인정보가 없고 관리자를 만들지 않는다. 같은 UUID로 반복 실행해도 덮어쓰지 않는다. DB·원본 파일·비밀정보는 저장소 밖에 두고 `public`에는 증빙을 저장하지 않는다.

검수 증거와 미실행 항목: [01 작업기록](history/2026-10-05-phase-01.md), [검수표](06-acceptance.md).

## 공식 참고

- [Next.js 설치](https://nextjs.org/docs/app/getting-started/installation), [데이터 보안과 서버 전용 경계](https://nextjs.org/docs/app/guides/data-security)
- [pg 트랜잭션](https://node-postgres.com/features/transactions), [SQL 마이그레이션](https://salsita.github.io/node-pg-migrate/migrations/)
- 타입 선언은 공식 npm registry의 @types/react 19.3.0, @types/react-dom 19.3.0, @types/node 24.19.1을 대조 후 고정했다. server-only 0.0.1도 잠금파일에 고정했다.
- 설치된 Next.js의 `node_modules/next/dist/docs` 설치·데이터 보안 안내도 확인했다. `agentRules: false`로 개발 서버의 AGENTS.md 자동 추가를 끄고 저장소 지침을 보존한다.
