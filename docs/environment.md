# 00단계 개발환경 점검과 기술 기준안

기준일: 2026-10-04 (Asia/Seoul). 점검 대상은 이번 Codex 세션이 접근하는 Windows 실행 환경과 작업 폴더다. 별도 사용자 PC, VS Code 대화형 로그인, 운영 서버까지 확인했다는 의미가 아니다. 설치·설정 변경 및 DB 생성은 수행하지 않았다.

원격 상태 후속 확인: 2026-10-05. 도구·DB 설치 상태는 이번에 재점검하지 않았으며 아래 제품 버전은 최초 점검값이다.

## 실제 점검 결과

| 항목 | 관찰 결과 | 한계·다음 조치 |
|---|---|---|
| OS·셸 | Windows NT 10.0.26300.0, x64; PowerShell 5.1.26100.9444 Desktop | 운영 서버 OS는 미결정 |
| 저장소 | `D:\boot_erp`, origin은 `https://github.com/Nawii06/boot_erp.git` | 작업 전 main과 origin/main 일치, 미커밋 변경 없음 |
| Git | 2.54.0.windows.1 | 최초 작성자 설정 없음; 로컬 커밋에는 명령 단위 Codex 작성자 사용 |
| 작업 브랜치 | `codex/phase-00-discovery` | .git 쓰기 제한으로 첫 생성 실패, 승인된 재실행 성공 |
| 원격 접근 | 최초 API push=false·Git dry-run 403; 후속 push 성공 및 원격 SHA 일치 확인 | 2026-10-05 원격 작업 브랜치·main에 `e30c1b2` 존재 확인. 원격 반영 장애 해결; API 권한 필드는 재조회하지 않음 |
| VS Code | 설치 파일 제품 버전 1.140.0, `code.cmd` 발견 | 편집기 실행·확장 활성 상태는 미확인 |
| Codex | `openai.chatgpt-26.930.41038-win32-x64` 확장 디렉터리 존재 | 확장 내 로그인은 미확인. 현재 에이전트 세션과 별도이며 인증파일을 읽지 않음 |
| Node.js·npm·pnpm | `Get-Command`에서 발견되지 않음; 버전 명령 실패 | 통상 설치 경로도 확인했으나 미발견. PC 전체의 미설치를 단정하지 않음; 실행 경로 확보 필요 |
| PostgreSQL | psql·postgres 바이너리 18.6, postgresql-x64-18 서비스 Running | 서버 접속 후 버전 조회·로그인·DB 생성 권한은 미검증 |
| DB 포트 | `pg_isready -h localhost -p 5432`: accepting connections | 준비 상태 응답일 뿐 프로젝트 DB 접속·권한 검증이 아님 |
| Docker | 명령·점검한 기본 설치 경로·서비스에서 미발견 | 아래 네이티브 개발 기준안의 필수 요건 아님 |
| Python | 3.14.6 실행 확인 | 문서 검사에 사용; 웹 앱 런타임으로 채택하지 않음 |

샌드박스 안 GitHub API·push dry-run은 네트워크 제한으로 실패했다. 승인된 외부 실행에서 API 조회는 성공했고 push dry-run은 저장소 권한 부족으로 실패했다. 네트워크 제한과 계정 권한 문제를 구분한다.

위 실패는 최초 점검 당시의 이력이다. 이후 작업 브랜치 push 성공(`Everything up-to-date`)과 원격 SHA를 확인했고, 2026-10-05에는 main push가 `7c0945e..e30c1b2`로 성공했다. 실제 인증·권한이 어떻게 변경됐는지는 추정하지 않는다. [후속 기록](history/2026-10-05-remote-main.md).

## 기술 후보 비교와 기준안

아래는 00단계에서 작성한 **개발자 제안**이다. 사용자 확정 요구(C-01~C-09)와 구분하며 D-01은 기준안 정리 상태로 남긴다. 실제 설치·빌드 호환성 통과로 표현하지 않는다.

| 영역 | 비교 후보 | 우선 기준안·이유 | 결정 경계 |
|---|---|---|---|
| 웹 | Next.js/TypeScript, Django | Next.js App Router: 화면과 서버 로직을 TypeScript로 통일하고 예산·청구 입력 화면을 구성 | Django는 ORM·관리 화면을 함께 제공하는 대안. 기관의 Python 운영 표준 여부 미확인 |
| DB | PostgreSQL, SQLite | PostgreSQL: 실 DB 트랜잭션·동시 예약 검수와 관계 제약을 기준으로 개발 | SQLite를 동시성 검수 대체 DB로 사용하지 않는 안 |
| 실행 | Windows 네이티브, WSL2/Docker | 점검된 PowerShell·PostgreSQL을 활용하는 Windows 네이티브 | WSL2/Docker 및 운영용 Windows 서버를 채택했다고 해석하지 않음 |
| 패키지 관리 | npm, pnpm | 단일 앱에 Node 배포본의 npm 사용, package-lock.json 유지 | pnpm 병행 사용·모노레포 도입 필요 없음 |
| 인증 | 기관 SSO, 초대된 자체 계정 | 기관 지원 방식 확인 후 02단계에서 선택; 검증된 인증 라이브러리 사용을 제안 | Google SSO·특정 인증 제품·비밀번호 정책 미확정. 01단계는 인증 경계만 준비 |
| 파일 | 비공개 로컬 디렉터리, 비공개 객체 저장소 | 개발은 저장소 밖 별도 디렉터리와 가상 파일, 저장소 인터페이스 분리 | 운영 위치·보존기간·서비스는 D-12/D-13. 외부 저장소 연결 미구현 |
| DB 접근 | SQL/드라이버, ORM | 트랜잭션과 SQL 제약을 검토할 수 있는 구조; 구체 드라이버·마이그레이션 도구는 01 진입 전에 선택 | ORM이 잠금·정확한 금액 처리를 자동 보장한다고 간주하지 않음 |

## 정확한 버전 기준안과 근거

조회일은 2026-10-04이며, 버전은 공식 릴리스/소스에서 확인했다. 다음 설치 시 보안 패치와 패키지 배포 메타데이터를 다시 대조한다. 변경 시 결정기록에 실제 채택 버전을 남긴다.

| 구성요소 | 기준안 | 확인 근거·제약 |
|---|---|---|
| Node.js | 24.21.0 LTS, Windows x64 | [공식 릴리스](https://nodejs.org/en/blog/release/v24.21.0). 현재 환경 실행 미확인 |
| npm | 11.19.0 | [Node 24.21.0에 포함된 npm 소스](https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/npm/package.json). 설치 후 실제 버전 대조 필요 |
| Next.js | 16.3.8 | [공식 릴리스](https://github.com/vercel/next.js/releases/tag/v16.3.8). 프리릴리스 대신 안정 버전 기준 |
| React·React DOM | 각각 19.3.0 | [공식 릴리스](https://github.com/react/react/releases/tag/v19.3.0), [Next.js 16.3.8 peerDependencies](https://raw.githubusercontent.com/vercel/next.js/v16.3.8/packages/next/package.json)의 React 19 범위 확인 |
| TypeScript | 5.9.3 | [공식 릴리스](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3). 최신 버전이라는 뜻이 아님; 초기 기준은 기존 5.x 도구 체계로 제한 |
| PostgreSQL | 18.6 | 설치된 바이너리와 [공식 지원 버전표](https://www.postgresql.org/support/versioning/) 대조. 서버 SQL 버전 조회는 별도 필요 |

[Next.js 설치 문서](https://nextjs.org/docs/app/getting-started/installation)의 Windows 지원, Node.js 20.9 이상·TypeScript 5.1 이상 요구에 위 기준안이 수치상 부합한다. 이는 설치·빌드 검증을 대신하지 않는다. 인증 구현은 [공식 인증 가이드](https://nextjs.org/docs/app/guides/authentication)를 참고하되 기관 정책 확인 전 제품을 확정하지 않는다. 대안 비교 근거는 [Django 개요](https://www.djangoproject.com/start/overview/)다.

## 개발 DB·파일·실행 분리안

- 개발 DB 이름은 `boot_erp_dev`, 테스트 DB는 `boot_erp_test`로 분리하는 안이다. 아직 존재·생성하지 않았으며 기존 DB를 조회·변경하지 않았다.
- 현재 5432 서비스가 프로젝트 전용인지 미확인이다. 관리자가 허용한 전용 DB와 제한된 역할을 확보한 후 연결한다. 기존 계정의 비밀번호를 추측하거나 기본 관리자 권한으로 앱을 실행하지 않는다.
- 접속 문자열은 비공개 환경변수로 관리하고 저장소에는 가짜 값의 예제만 둔다. DB 비밀번호를 작업기록에 기록하지 않는다.
- 개발 파일 루트는 저장소 밖 전용 위치를 선택한 뒤 기록한다. 운영 원본 보관 위치는 D-13에서 별도로 결정하며 공개 정적 폴더에 증빙을 두지 않는다.
- 01단계에서 Node/npm 실행, 의존성 잠금파일, 빈 개발·시험 DB의 마이그레이션·가상 seed·빌드 검수를 수행한다. 현재 실행 가능한 앱 명령은 없다.

## 01단계 진입 판단

현재는 **진입 보류**다. 기술 기준안·정확한 버전 후보는 작성했으나 D-01 최종 채택, Node/npm 실행 환경, 전용 개발 DB 접근, DB 도구 선택이 남았다. 원격 반영 및 main 병합은 완료되어 더 이상 미해결 항목이 아니다. D-02~D-09의 업무 정책은 [결정기록](07-decisions.md)의 해당 구현 단계 전에 해결하며, 모든 미결정이 기반 문서 작업을 막는 것은 아니다.

점검 명령·검수 증거: [00단계 작업기록](history/2026-10-04-phase-00.md).
