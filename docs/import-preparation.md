# P7 가상 입력 매핑·무쓰기 dry run

2026-11-06 / Asia/Seoul. [통합계획](completion-plan.md)의 P7 입력도구 준비 범위다. 실제 자료 입력(P8), DB 반영, 원본 조회/수정, Notion 연계(P9)는 수행하지 않는다. Q7의 실제 대상·기준일·기초잔액 방식·대조 책임은 여전히 결정이 필요하다.

## 사용과 출력

```powershell
# synthetic:true인 가상 JSON 파일만 준비한다.
.\scripts\app.cmd run validate:import -- C:\private-example\synthetic-batch.json
```

스크립트 자체는 `node scripts/validate-import.mjs <file>`로도 실행할 수 있다. 파일 하나를 읽고 구조·금액·관계·범위를 검사하며 파일이나 DB에 쓰지 않는다. 입력 파일은 최대 5MiB, 컬렉션별 최대 10,000행이다. 출력은 아래처럼 유효 여부·건수·고정 오류코드만 포함한다. 실제 값·식별자·파일 경로·원본 행·금액 합계를 출력하지 않는다. 실패 시 종료 코드 1, 검증 통과 시 0이다.

```json
{"valid":true,"counts":{"projects":1,"classifications":3,"budgetLines":1,"budgetHistory":1},"errorCodes":[]}
```

`valid:true`는 이 오프라인 계약의 검증만 뜻한다. 원본 진위·완전성, 실제 DB와 중복 여부, actor/권한, 첨부·지급 증거, 원본 수식, 실자료 인수 또는 G1/G2 통과를 증명하지 않는다. `synthetic:true`도 호출자의 가상자료 선언이며 개인정보 자동 탐지 기능은 아니다. 실제 자료를 이 P7 도구에 넣지 않는다.

## JSON 계약과 현재 스키마 매핑

필수 최상위 키는 `schemaVersion:1`, `synthetic:true`, `batchId`, `sourceSystem`, `scope`, `budgetBasis`, `previousImports`, `projects`, `classifications`, `budgetLines`, `budgetHistory`다. 문서에 없는 키·자료 종류는 무시하지 않고 거부한다. 거래/지급/계정/업무/증빙은 지원하지 않는다.

| 영역 | 필수 필드 | 매핑·검사 |
|---|---|---|
| scope | businessName, businessYear, academicYear, periodStart, periodEnd, cutoffDate, projectIds | 확정된 사업 1차년도 부트캠프 사업·1차년도·2026학년도·2026-03-01~12-31. cutoffDate는 기간 시작 이후 유효 날짜. projectIds는 이번 파일에 포함된 UUID 과제 범위 |
| projects | id, sourceId, code, name, kind, businessYear | projects. kind는 research/program, 이 테이블의 businessYear는 2026학년도 |
| classifications | id, sourceId, versionId, code, level, parentId, name, effectiveOn, active | budget_codes와 budget_code_versions의 매핑 후보. N코드 3계층·같은 파일의 부모 관계·활성·적용일 검사. versionId는 별도 UUID |
| budgetLines | id, sourceId, projectId, codeVersionId, label, fund, originalAmount, currentAmount, committedAmount, availableAmount | budget_lines/budget_accounts. 과제와 3단계 분류 버전은 같은 파일에서 참조. 최초/현재/차감/가용액은 정수 문자열 |
| budgetHistory | id, sourceId, lineId, occurredOn, beforeAmount, afterAmount, effect | 임시 대조용 과거 금액 자료. budget_changes/events를 생성하는 완성된 DB 입력 형식이 아님. actor·사유·파일·요청/원장 관계는 P8에서 확인 |
| previousImports | batchIds, sourceIds | 같은 sourceSystem의 기존 반영 이력 스냅샷을 호출자가 공급. 빈 이력도 명시해야 함. 이 도구가 신규 이력을 저장하거나 DB와 대조하지 않음 |

sourceId는 sourceSystem 안에서 모든 자료 종류에 걸쳐 유일한 원본 키다. 종류마다 같은 ID가 사용되는 원본이라면 매핑 준비 시 `project:원본ID`처럼 이름공간을 명시하고 대조표에 보존한다. 이 준비용 키가 기관 공식 코드나 실제 영속 매핑을 대신하지 않는다. UUID는 대소문자 차이를 정규화해 중복을 검사한다. 과제 코드·분류 코드 중복, 파일 내 원본ID 중복, ledger 내 반영 배치/원본ID 중복은 거부한다. ledger가 누락되거나 오래되면 실제 중복을 보장할 수 없으며 P8의 트랜잭션/영속 원본ID 제약을 대체하지 않는다.

현행 SQL의 bigint 범위와 금액 계약을 따라 숫자 타입·소수·음수·지수 표기·앞자리 0·범위 초과를 거부한다. 전체 합계도 signed bigint 범위 안이어야 한다. `가용액 = 현재예산 - 유효 신청 차감액`, `차감액 <= 현재예산`을 검사한다. committedAmount를 입력받는 것은 가상 대조 연습이며 신청 원장/실제 지급과의 대조가 완료됐다는 의미가 아니다. 지급액을 가용액에서 다시 차감하는 필드는 지원하지 않는다.

## 기초잔액과 과거 변경의 중복 방지

두 방식은 원본 대조를 위한 도구 옵션이며 아직 Q7의 실제 입력 방식이 선택된 것이 아니다.

- `current_snapshot`: currentAmount를 기준시점 확정 값으로 본다. budgetHistory의 effect는 모두 `reference`여야 하며 과거 증감은 다시 가산하지 않는다. originalAmount는 별도 최초예산 값으로 보존한다.
- `original_with_history`: originalAmount부터 파일 내 순서대로 `apply` 이력의 before/after 연쇄를 대조한다. 각 before는 직전 after와 같아야 하며 최종 값은 currentAmount와 같아야 한다. 날짜 역순·빠진 이력으로 인한 금액 불일치·reference 혼용을 거부한다.

어느 방식도 DB에 금액을 실제 적용하지 않는다. 이력은 사업 사용기간과 cutoffDate 안의 유효 날짜여야 한다. 원본에 날짜/수식/관계가 미확인인 경우 가상 0으로 보충해 성공시키지 않고 입력 준비 미완료로 남긴다.

## 가상 예시

아래는 형태를 설명하는 가상 배치다. 실제 이름·금액·원본ID·비공개 대조표로 교체해 공개 저장소에 저장하지 않는다.

```json
{
  "schemaVersion": 1,
  "synthetic": true,
  "batchId": "SYNTHETIC-BATCH-01",
  "sourceSystem": "synthetic-fixture",
  "scope": {
    "businessName": "1차년도 부트캠프 사업", "businessYear": 1, "academicYear": 2026,
    "periodStart": "2026-03-01", "periodEnd": "2026-12-31", "cutoffDate": "2026-11-06",
    "projectIds": ["10000000-0000-4000-8000-000000000001"]
  },
  "budgetBasis": "current_snapshot",
  "previousImports": {"batchIds": [], "sourceIds": []},
  "projects": [
    {"id":"10000000-0000-4000-8000-000000000001","sourceId":"PROJECT-01","code":"SYNTHETIC-01","name":"가상 검수 과제","kind":"research","businessYear":2026}
  ],
  "classifications": [
    {"id":"10000000-0000-4000-8000-000000000002","sourceId":"CODE-01","versionId":"10000000-0000-4000-8000-000000000012","code":"N01","level":1,"parentId":null,"name":"가상 비목","effectiveOn":"2026-03-01","active":true},
    {"id":"10000000-0000-4000-8000-000000000003","sourceId":"CODE-02","versionId":"10000000-0000-4000-8000-000000000013","code":"N01.01","level":2,"parentId":"10000000-0000-4000-8000-000000000002","name":"가상 세목","effectiveOn":"2026-03-01","active":true},
    {"id":"10000000-0000-4000-8000-000000000004","sourceId":"CODE-03","versionId":"10000000-0000-4000-8000-000000000014","code":"N01.01.001","level":3,"parentId":"10000000-0000-4000-8000-000000000003","name":"가상 세세목","effectiveOn":"2026-03-01","active":true}
  ],
  "budgetLines": [
    {"id":"10000000-0000-4000-8000-000000000005","sourceId":"LINE-01","projectId":"10000000-0000-4000-8000-000000000001","codeVersionId":"10000000-0000-4000-8000-000000000014","label":"가상 배정 항목","fund":"가상 재원","originalAmount":"1000","currentAmount":"1200","committedAmount":"200","availableAmount":"1000"}
  ],
  "budgetHistory": [
    {"id":"10000000-0000-4000-8000-000000000006","sourceId":"HISTORY-01","lineId":"10000000-0000-4000-8000-000000000005","occurredOn":"2026-04-01","beforeAmount":"1000","afterAmount":"1200","effect":"reference"}
  ]
}
```

## 오류와 후속 범위

중복은 `BATCH_ALREADY_IMPORTED`, `SOURCE_ALREADY_IMPORTED`, `DUPLICATE_SOURCE_ID`, `DUPLICATE_TARGET_ID`로, 금액은 `INVALID_WON`, `TOTAL_WON_OVERFLOW`, `BALANCE_MISMATCH`로 구분한다. 이력 혼용은 `SNAPSHOT_HISTORY_REAPPLY`, `MIXED_BUDGET_BASIS`, `HISTORY_CHAIN_MISMATCH`, `HISTORY_TOTAL_MISMATCH`다. 나머지 고정 코드는 입력 구조·날짜·과제/분류/항목 관계·범위 위반을 나타낸다. 오류 행/원본 값은 출력하지 않으므로 호출자의 비공개 준비 환경에서 원본과 대조한다.

P8 전에 Q7 실제 대상과 기준일, 기초잔액/재구성 선택, 원본/대조 책임, 수기/배치 방식, 기존 대상 UUID와 버전, 영속 원본/배치 ledger 및 충돌 처리, 권한/감사/첨부/진행 신청/지급/환입의 입력 계약을 별도로 확정해야 한다. 이 도구가 그 범위의 실제 이관기나 지급 증빙 검증기를 제공하는 것으로 해석하지 않는다.

## 검증

검사: `node --test tests/import-validation.test.mjs`. 가상 자료의 정상 매핑·무변경, 지원하지 않는 자료, 배치/원본/대상 중복, canonical bigint·합계 overflow·잔액, 기준시점/범위/관계/분류, 스냅샷 이중반영·이력 연쇄/순서, 악성 구조·개인값 비출력·CLI 종료 결과를 검사한다. 실제 DB·실자료·Notion은 사용하지 않는다.

2026-11-06 전용 Node 24.21.0을 승인 실행 환경에서 사용해 **13건 통과**했다. 최초 `npm exec -- node` 호출은 npm의 오프라인 캐시 조회로 실패했고, 직접 Node 테스트는 샌드박스 자식 프로세스 EPERM으로 실패했다. 승인 실행 환경의 재실행은 별도 결과다. 실패를 성공으로 바꾸어 기록하지 않는다.
