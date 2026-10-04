# 기술 기준 확정·개발환경 준비

- 날짜: 2026-10-05 (Asia/Seoul)
- 요청: 제안된 기술 조합과 DB 도구를 검토하고 적절하면 진행
- 기준 커밋: 0f85f9575034bb38b2c7f1f9a8c8534103fc0d94
- 브랜치: codex/phase-00-toolchain. 결과 SHA·원격 확인은 완료 보고에서 제공
- 범위: 00단계 기술 확정·로컬 도구/빈 DB 준비·호환 검사. 01단계 앱 미착수

## 수행 내용

R-01/R-10 및 금액·동시성·감사 불변조건을 검토하고 공식 문서와 패키지 engines/peerDependencies를 대조했다. 사용자 조건부 지시에 따라 T-01/T-02를 확정했다. Next.js·TypeScript·PostgreSQL과 Drizzle ORM/pg·node-pg-migrate가 적합하다고 판단한 이유·정확한 버전·근거 URL은 [확정 환경](../toolchain.md)에 기록했다.

Node를 사용자 폴더에 설치했다. 기존 5432 DB는 용도를 추정하지 않고 보존하며 별도 55432 클러스터·개발/시험 DB를 생성했다. SCRAM·localhost·UTC, owner/app 분리, PUBLIC 접속/스키마 생성 제한, 비밀폴더 NTFS ACL을 적용했다. app에는 자기 DB 연결/임시 테이블·public 사용과 향후 owner가 생성하는 테이블 DML 기본 권한을 부여했다. owner도 SUPERUSER/CREATEDB/CREATEROLE은 없다. 실제 자료는 넣지 않았다.

변경: README, STATUS, environment, toolchain, 결정기록, 검수표, 00 작업서, CHANGELOG, 이 기록, scripts/toolchain.cmd, tools/toolchain-check의 패키지/잠금파일·tsconfig·검증 코드. 앱·업무 스키마는 추가하지 않았다.

## 실제 명령·검수

| 점검 | 결과·한계 |
|---|---|
| git 상태/fetch/main 확인/브랜치 생성 | 성공, 기존 변경 없음 |
| Get-Command / postgres --version / pg_isready | 최초 Node 없음, 바이너리 18.6, 5432 응답·55432 미응답 |
| Node 다운로드/Get-FileHash/Expand-Archive | 공식 SHA256 일치, 실제 Node 24.21.0/npm 11.19.0 |
| initdb/pg_ctl start/psql bootstrap | 별도 클러스터·두 빈 DB·독립 owner/app 생성, 기존 서비스 변경 없음 |
| 최초 PowerShell 환경 스크립트 | 실행 정책으로 실패. 정책 변경 없이 CMD 실행기로 대체하고 최초 스크립트 제거 |
| toolchain.cmd install --ignore-scripts --no-fund | 별도 도구 설치·잠금파일 생성 |
| 최초 audit | Drizzle Kit 경로 moderate 4건, esbuild GHSA-67mh-4wv8-2f99 |
| node-pg-migrate로 교체 후 audit --json | 0건. 강제 audit fix/버전 override 없음 |
| run typecheck | pg/Drizzle FOR UPDATE·bigint·MigrationBuilder API 통과. skipLibCheck 적용 |
| 최초 run check | 비밀파일 샌드박스 접근 EPERM; ACL 완화 없이 승인 재실행 |
| 승인 run check | dev/test 모두 PostgreSQL 18.6 접속·역할 제한·교차 DB 차단·정확한 큰 정수·Drizzle 롤백·owner DDL 롤백 통과 |
| run check:migrations | 테스트 DB 고유 임시 스키마에서 SQL up 1건, 반복 up 0건, down 1건. 임시 스키마·파일 제거 |
| next --version / npm ls --depth=0 | Next 16.3.8·고정 버전 확인. node-pg-migrate CLI --version은 검사 패키지 값 0.0.0을 출력하여 설치 메타데이터/npm ls의 9.0.0으로 확인 |
| Get-Acl / pg_isready 5432·55432 | 사용자+SYSTEM 전용 비밀폴더 ACL 및 두 포트 응답 확인 |
| toolchain.cmd ci --ignore-scripts --no-fund | 잠금파일 재설치 성공, 62개 설치·63개 감사, 취약점 0건 |
| ci 후 typecheck / check:migrations / check | 모두 재통과. public 스키마에 업무 테이블 없음 확인 |
| Markdown 상대 링크·코드펜스/패키지 잠금 선언 검사 | 문서 33개·상대 링크 103개·오류 0, package.json과 lock 직접 의존성 일치 |
| git diff --check / 공개 범위 검토 | 공백 오류 없음, 비밀정보·운영자료 없음. node_modules는 기존 gitignore로 제외 |

## 범위·다음 작업

도구 검사는 앱 기능 테스트가 아니다. 임시 검사 테이블은 롤백/삭제했고 업무 테이블은 없다. 앱 빌드·로그인·업무 권한·동시 예약·실제 마이그레이션·복구는 01 이후 검수한다. 00단계의 01 진입 기준은 충족했고 D-02~D-13은 기존 담당 단계 전에 결정한다. IDE 로그인은 별도 미확인이다. 01단계는 이번에 시작하지 않았다.

## 보존·되돌림

검수 종료 시 프로젝트 DB는 실행 중이며 자동 시작은 등록하지 않았다. 확정 환경 문서의 pg_ctl로 해당 클러스터만 정지할 수 있다. DB·로그·비밀파일은 사용자 전용 저장소 밖 폴더에 두며 Git에서 추적하지 않는다. 전역 PATH·실행 정책·기존 DB 설정은 변경하지 않았다. 문서는 커밋 revert로 되돌릴 수 있고 데이터 폴더를 자동 삭제하지 않는다. Notion 접근·외부 연동·실자료 이관·운영 배포는 수행하지 않았다.
