# boot_erp

산공과제·비교과 프로그램의 예산, 사용신청, 청구, 증빙, 대학 ERP 실청구 및 지급·정산을 관리하기 위한 웹 ERP 프로젝트입니다.

**현재 상태: 00단계 기술 확정·개발환경 준비 완료. 애플리케이션은 아직 구현되지 않았습니다.**

기준일: 2026-10-05 / 시간대: Asia/Seoul / 문서 버전: 0.2

## 시작하기

1. [전체 구축계획](docs/00-overview.md)과 [단계별 로드맵](docs/04-roadmap.md)을 읽습니다.
2. [현재 진행상황](docs/STATUS.md)에서 다음 작업과 미결정을 확인합니다.
3. VS Code에서 저장소를 열고 [Codex 작업 안내](docs/05-codex-runbook.md)에 따라 **한 단계씩** 작업합니다.
4. [확정 환경·실행 방법](docs/toolchain.md)을 확인합니다. 다음 대상은 [01단계: 개발 기반](docs/stages/01-foundation.md)이며 아직 시작하지 않았습니다.

## 사용자와 범위

| 사용자 | 범위 | 역할 |
|---|---|---|
| 연구원 | 배정된 과제·프로그램 | 사용신청, 청구·증빙 제출, 보완 |
| 과제책임자 | 배정된 과제·프로그램 | 현황 조회 전용 |
| 담당자 | 전체 과제·프로그램 | 예산·청구·실청구·지급·정산 및 업무 설정 |
| 관리자 | 전체 시스템 | 전체 기능 접근, 계정·권한·전산 설정 |

본 ERP의 내부 검토와 대학 산학협력단 ERP의 공식 결재·지급을 구분합니다. 대학 ERP에는 담당자가 직접 실청구하고 처리결과를 본 ERP에 기록합니다.

홈페이지·Notion 연동은 현재 개발 범위에 포함하지 않습니다. 향후 연결을 위한 고유 ID와 서비스/API 경계만 준비합니다. 기존 Notion의 데이터·설정·파일은 변경하지 않습니다.

## 문서 안내

| 문서 | 목적 |
|---|---|
| [AGENTS.md](AGENTS.md) | Codex의 저장소 작업 원칙 |
| [전체 구성](docs/00-overview.md) | 범위, 아키텍처, 화면 구성 |
| [요구사항](docs/01-requirements.md) | 사용자 확정 요구와 설계 제안 구분 |
| [권한표](docs/02-access-control.md) | 역할·업무 배정·파일 접근 기준 |
| [데이터와 업무 흐름](docs/03-data-and-workflows.md) | 데이터 관계, 상태, 금액 규칙 |
| [단계별 로드맵](docs/04-roadmap.md) | 00~10단계 순서·특이사항·완료 조건 |
| [VS Code·Codex 안내](docs/05-codex-runbook.md) | 시작·재개·검토·Git 작업 방법 |
| [검수 기준](docs/06-acceptance.md) | 권한·금액·처리이력 검증 사례 |
| [결정기록](docs/07-decisions.md) | 확정 사항, 제안, 미결정 |
| [자료 목록](docs/08-sources.md) | 참고 자료와 검토 한계 |
| [이관·운영](docs/09-data-and-operations.md) | 읽기 전용 이관, 시범운영, 백업·복구 |
| [진행상황](docs/STATUS.md) | 실제 완료와 다음 작업 |
| [연혁](CHANGELOG.md) | 변경사항과 구현 이력 |
| [작업기록 양식](docs/history/TEMPLATE.md) | 단계별 실행·검수 증거 기록 |

## 공개 저장소의 자료 범위

2026-10-04 확인 당시 이 저장소는 Public입니다. 공개 가능한 설계·코드·가상 테스트자료만 커밋합니다. 실제 연락처·학번·계좌·영수증·청구내역·내부 PDF·운영 DB·비밀키는 포함하지 않습니다. 자료 목록에는 원본 식별정보와 검토 범위만 남깁니다.

## 개발 명령

확정 구성은 Next.js·TypeScript·PostgreSQL, Drizzle ORM/pg, node-pg-migrate입니다. 버전·DB 시작/정지는 [확정 환경](docs/toolchain.md)을 참조합니다. 아래는 준비된 PC의 00단계 도구 검증이며 앱 실행 명령이 아닙니다.

```powershell
.\scripts\toolchain.cmd run typecheck
.\scripts\toolchain.cmd run check
.\scripts\toolchain.cmd run check:migrations
```

check는 빈 개발·시험 DB 준비 검사용이므로 01단계에서 업무 테이블 생성 후 그대로 사용하지 않습니다. 앱·빌드·실제 업무 마이그레이션은 01단계에서 구성·검증합니다.
