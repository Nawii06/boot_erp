# Google 로그인 연결 준비 보고 반영

2026-10-18 (Asia/Seoul). 기준 커밋 `8348b70`, 브랜치 `codex/phase-02-policy`. 시작 시 미커밋 변경 없음.

## 근거와 반영 내용

사용자가 Google Auth Platform 기본 설정, 외부/테스트 상태, 시험 사용자, 웹 클라이언트 생성, 인증정보 JSON 비공개 보관을 완료했다고 보고했다. 앞서 기존 프로젝트·직접 설정 권한·현재 PC 시험·최초 관리자/시험 계정 선정도 확인했다. 이 기록은 사용자 보고이며 Console 또는 파일을 직접 검증했다는 뜻이 아니다.

AGENTS, STATUS, 요구사항, 최신 결정기록, 02 작업서를 읽고 현재 로컬 실행기가 외부 DB 설정만 읽는 것을 확인했다. Google 반환 경로를 `http://localhost:3000/api/auth/google/callback`으로 정해 연결 안내에 기록했다. 실제 route·OAuth·세션 코드는 아직 구현하지 않았다. 업무 정책은 변경하지 않았다.

비공개 JSON의 전체 경로만 요청했고 사용자가 제공했다. 해당 파일을 PowerShell의 Get-Content/ConvertFrom-Json으로 읽어 웹 형식·ID 형식·Secret 존재·예상 원본/반환 주소 포함 여부만 boolean으로 출력했다. JSON 읽기/형식/ID/Secret/로컬 원본 주소는 확인했고 예정 반환 주소는 다운로드 JSON에 없었다. Console의 최신 상태·키 유효성은 검증하지 않았다. 파일 내용이나 Secret을 채팅으로 요청하지 않았고 실제 경로·이메일·인증정보를 공개 문서에 기록하지 않았다. Google 시험 사용자와 ERP 관리자 등록을 별도 절차로 명시했다.

## 검수와 남은 작업

`scripts/app.cmd run check:docs` 통과: Markdown 42개, 상대 링크 172개, 누락 0. `git diff --check` 통과. 비공개 JSON의 비밀값 비출력 형식 확인도 수행했다. 코드·DB 변경이 없는 준비 문서 작업이므로 앱 테스트를 재실행하지 않았다. Google Console 변경·로그인 시험·운영 배포·Notion 변경·main 병합은 미수행이다. 최종 커밋과 원격 반영 SHA는 작업 보고에 명시한다.

다음은 Console의 반환 주소 등록·확인, 02 데이터 구조·서버 인증정보 로딩·로그인/세션 구현 및 검수다. 실제 로그인 성공 없이 연결 완료 또는 02 완료로 표시하지 않는다.
