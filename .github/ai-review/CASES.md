# PR 자동 Claude 리뷰(ai-review) — 프론트엔드 승인된 케이스와 결정

- 승인: 재민(CheatIsKey), 2026-11-15 — "Approve as recommended"
- 원본: safeDeal-Backend `.github/ai-review/` (dev `153d188`). 케이스 CIR-01~42와 결정 Q·F·G·H·I·J·K·L·M·N은 백엔드 CASES.md를 따른다. 이 문서는 프론트에서 **바뀌거나 새로 생긴 것**만 적는다.
- 스크립트·테스트는 백엔드에서 그대로 복사한다(C-D). 백엔드를 고치면 손으로 옮긴다. `ci-unchanged.local.mjs`(CIR-29)는 프론트에 기존 CI가 없어 옮기지 않는다.

## 백엔드 케이스가 어떻게 넘어오는가

| 분류 | 대상 |
|---|---|
| 그대로 | CIR-01~09, 11~22, 24~28, 30, 32, 33, 35, 36, 39, 41, 42 · F1~F5 · G1~G7 · H2 · H3 · I1~I3 · J1 · J3 · K1 · L1 · M1~M3 · N1 |
| 바뀜 | CIR-10(lockfile 포함, C-L) · CIR-23(구독 한도를 두 레포가 함께 씀, FIR-13) · CIR-29(해당 없음) · CIR-38(예약 작업 대신 Ollama 봇, C-B) · CIR-40(봇 대리 Approve, FIR-09) · G5(리뷰 관점 5 추가, C-K) · L2(기본 브랜치, C-A) |
| 보류 유지 | CIR-34(J2) · M4 |

## 케이스

| ID | 관점 | 상황 | 기대 결과 | 테스트 |
|---|---|---|---|---|
| FIR-01 | 정상 | 레포 브랜치에서 dev로 PR 열기·push | 요약 댓글 + `ai-review` 체크가 head SHA에 붙는다 | 복사한 단위·정적 + 시범 |
| FIR-02 | 정상 | dev → main 릴리스 PR | 워크플로가 기본 브랜치와 같아 리뷰·판정이 돈다 | 시범 |
| FIR-03 | 정상 | 프론트 결함(예: API 문자열을 `dangerouslySetInnerHTML`로 넣음)이 든 PR | 해당 줄에 [P1]/[P2] inline 지적 | 정적(관점 5 존재) + 시범 |
| FIR-04 | 예외 | 기본 브랜치의 ai-review.yml이 없거나 다름 | 액션이 실행 거부 → 판정 불가, PASS 금지 | 시범(관찰) |
| FIR-05 | 예외 | ai-review 도입 전에 갈라진 브랜치의 PR(#1 등) | 판정 불가가 나면 dev를 병합해 복구 | 시범(관찰) |
| FIR-06 | 경계값 | PR #1 수치(23파일, 4,604줄) | `too_large` → 판정 불가: 범위 초과 | gate 단위 |
| FIR-07 | 경계값 | 의존성만 추가했는데 lockfile 때문에 2,000줄 초과 | `too_large`(G4는 파일 목록을 보지 않음) | gate 단위 |
| FIR-08 | 경계값 | 스택 PR의 base가 머지되어 dev로 자동 retarget | strict(최신 브랜치 필수)로 재실행을 강제 | 시범(관찰) |
| FIR-09 | 권한 | Ollama 봇이 `REVIEW_AUTO_APPROVE`로 팀원 이름 Approve | 룰셋을 켜기 전에 봇을 끈다(C-B) | 수동 |
| FIR-10 | 권한 | 포크 PR, 허용 목록 밖 작성자·actor | Claude 호출 없음, 체크 실패 | 복사한 gate 단위 |
| FIR-11 | 실패 | 프론트 레포에 `CLAUDE_CODE_OAUTH_TOKEN` 없음 | 판정 불가, PASS 금지 | 시범(관찰) |
| FIR-12 | 실패 | Claude GitHub App이 프론트에 미설치 | App 토큰 실패 → 판정 불가 | 시범(관찰) |
| FIR-13 | 실패 | 두 레포가 재민 구독 한도를 함께 씀 | 한도에 닿으면 판정 불가: 사용 한도 | 관찰 |
| FIR-14 | 중복 요청 | 같은 PR에 Ollama 봇과 Claude가 함께 리뷰 | 전환 뒤 Claude 리뷰만 남는다 | 수동 |
| FIR-15 | 동시성 | 두 레포의 같은 번호 PR이 동시에 실행 | concurrency 그룹이 레포 단위라 서로 취소하지 않음 | 관찰 |
| FIR-16 | 회귀 | 앞으로 vitest include를 넓힘 | `npm test`가 `.github/ai-review/*.test.mjs`를 집지 않는다 | 빌드 CI 생긴 뒤 |
| FIR-17 | 마이그레이션(설정) | 저장소 설정을 차례로 전환 | 검증 없는 머지 경로가 생기지 않는다(순서 C-F) | 수동 체크리스트 |
| FIR-18 | 마이그레이션(DB) | — | 해당 없음(`.github/` 파일만 추가) | — |
| FIR-19 | 정상 | 복사한 `*.test.mjs`를 Self test 스텝에서 실행 | 전부 통과, Claude보다 먼저 | 단위 |

## 결정

| # | 결정 |
|---|---|
| C-A | **기본 브랜치를 dev로 바꾼다.** main은 릴리스 전용 |
| C-B | Ollama 봇 서비스를 멈추고 `REVIEW_AUTO_APPROVE`를 끈다. 봇 App을 제거하고 위임을 철회한다. 봇 PR #5~#7은 닫는다. dev의 `tools/ai-review/` 삭제는 별도 PR. eval 하네스는 로컬 보관. 봇 App 설치 범위(백엔드 포함 여부)는 경화가 확인 |
| C-C | 프론트 빌드·테스트 CI는 이번 범위 밖. PR #1 머지 뒤 별도 요구사항 |
| C-D | 스크립트·테스트·CODEOWNERS를 **복사**한다. 레포 간 `uses:`·reusable workflow는 쓰지 않는다(공급망 위험) |
| C-E | PR #1은 나눠서 올린다(설정+lockfile 먼저, src는 2,000줄 이하로 여러 번). ai-review가 들어간 뒤 각 브랜치에 dev를 병합 |
| C-F | 설정 순서: 동의 → 봇 정지 → 기본 브랜치 dev → Interaction limits → Actions 외부 기여자 승인 → Claude App에 프론트 추가 → 재민 토큰 등록 → 도입 PR(경화 직접 리뷰) 머지·main 반영 → CODEOWNERS 확인 → 룰셋 → 시범 PR |
| C-G | 룰셋은 dev·main만(K1): PR 필수, `ai-review` 필수, 최신 브랜치 필수(strict), 코드 소유자 승인, 최신 push 기준 승인, 새 커밋 시 승인 해제, Bypass는 Repository admin "For pull requests only"(L2) |
| C-H | `claude setup-token`으로 프론트용 새 토큰을 만들어 이 레포 시크릿으로만 등록. 사용 크레딧 꺼짐 재확인 |
| C-I | App 설치 범위 변경에는 조직 소유자 권한이 필요 — 경화가 소유자인지 확인 |
| C-J | 리뷰 관점 4(팀 규칙) 문구는 그대로. 프론트 팀 규칙 문서는 별도 작업 |
| C-K | P1·P2 정의 문장은 그대로(H1). 프론트 리뷰 관점 5(XSS, 토큰 저장, `VITE_` 환경 변수, 인증·라우트 가드, API 오류 상태, 공급망, 접근성)를 프롬프트에 넣고 프론트 전용 테스트로 확인 |
| C-L | lockfile도 크기에 포함(G4 그대로). 자주 막히면 따로 설계 |
| C-M | 재민 PC의 프론트 봇 자동 실행(start-review.cmd 등)이 있으면 C-B와 함께 끈다 |

## #9·#10 시범 후 개선 (재민 승인, 2026-11-15 — "Proceed now")

| # | 결정 |
|---|---|
| O1 | 인증 실패 문구를 실측값으로 바꾼다(CIR-24·기타 "시범에서 실제 출력으로 교체"). 실측: `Failed to authenticate. API Error: 401 …`, 토큰에 줄바꿈이 있으면 `Invalid auth token · Fix external auth token …`(api_error_status 없음). result의 `api_error_status`가 401·403이면 문구와 상관없이 auth_failed |
| O2 | inline 댓글 줄 번호는 변경분 파일(`.git/ai-review-pr.diff`)의 줄이 아니라 **실제 파일의 줄**(Read로 본 줄)을 쓰고, 같은 지적을 두 번 달지 않도록 프롬프트에 적는다(프론트 #10에서 diff 줄 번호로 잘못 단 뒤 다시 단 중복 관찰). 워크플로 변경이므로 L2 우회 머지 |

## 사람이 할 일 (Claude가 대신하지 않음)

| 누가 | 할 일 |
|---|---|
| 재민 | 프론트용 `claude setup-token` → 레포 시크릿 `CLAUDE_CODE_OAUTH_TOKEN` 등록, 사용 크레딧 꺼짐 확인, 로컬 봇 자동 실행 끄기(C-M) |
| 경화 | C-F 순서대로: 동의, 봇 정지·App 제거, 기본 브랜치 dev, Interaction limits, Actions 승인, Claude App에 프론트 추가, 도입 PR 리뷰·머지(main 반영), 머지 뒤 룰셋(C-G) |

## 설정 완료 기록 (2026-11-15)

| 항목 | 상태 |
|---|---|
| 기본 브랜치 | dev (C-A) |
| 봇 PR #5~#7 | 닫음 (C-B) |
| 룰셋 `ai-review` | dev·main, strict, 코드 소유자 승인 (C-G) |
| 시크릿 | 프론트 전용 `CLAUDE_CODE_OAUTH_TOKEN` 등록 (C-H) |
