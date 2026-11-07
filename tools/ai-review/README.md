# SafeDeal AI 위임 리뷰

`safeDeal-platform/safeDeal-Frontend`의 같은 저장소 브랜치에서 `dev`로 여는 PR에 적용합니다. 팀원이 본인 계정으로 GitHub App에 동의하고 PR의 **Reviewers**에 지정되면 로컬 Ollama가 변경분을 읽습니다. Copilot, 유료 모델 API, GitHub Actions 러너를 사용하지 않습니다. 실행할 PC나 서버와 GitHub에서 접속할 수 있는 HTTPS 웹훅 주소는 팀에서 준비해야 합니다.

| 결과 | GitHub 동작 |
| --- | --- |
| **BLOCK** · P1 발견 | 코드 줄에 P1/P2 의견을 남기고 위임한 팀원 이름으로 **Request changes** |
| **PASS** · P1 없음, P2는 참고 | 자동 승인을 켰으면 같은 팀원 이름으로 **Approve**. 기본은 **Comment** |
| **BLOCK** · 판단 불가 | 사유를 **Comment**로 남기고 사람 검토 대기 |

리뷰에는 **SafeDeal AI 위임 리뷰**라고 표시합니다. GitHub App은 머지 권한을 사용하지 않습니다. 이전 P1의 근거가 새 diff에도 남아 있거나 기준 브랜치가 바뀌어서 해소 여부를 확인할 수 없으면 자동 승인을 보류합니다.

## 관리자 설치

1. 조직 소유의 비공개 [GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)을 등록하고 `safeDeal-Frontend`에만 설치합니다. **Contents: Read-only**, **Pull requests: Read and write**만 추가하고 **Pull request** 이벤트를 구독합니다. **Enable Device Flow**와 만료되는 사용자 토큰을 켜고 App private key를 생성합니다. 별도 OAuth 콜백이나 클라이언트 시크릿은 필요 없습니다. CodeRabbit 설정은 별개입니다.
2. 실행 호스트에 Node.js 22.17 이상과 [Ollama](https://docs.ollama.com/)를 설치합니다. Ollama가 `127.0.0.1:11434`에서 동작하는 상태에서 `ollama pull qwen2.5-coder:7b`로 모델을 받습니다. [기본 모델](https://ollama.com/library/qwen2.5-coder)은 약 4.7 GB입니다. 이 서비스는 승인된 코드 버전에서만 단일 프로세스로 실행합니다. PR의 코드를 체크아웃하거나 실행하지 않습니다.
3. App 웹훅 URL을 팀이 제어하는 HTTPS 주소의 `/webhook`으로 설정하고 로컬 서비스 `127.0.0.1:8787/webhook`으로 전달합니다. Ollama 포트와 호스트 관리 포트는 공개하지 않습니다. GitHub App 설정과 서비스에 동일한 웹훅 비밀을 지정합니다.
4. 환경 변수를 서비스 계정에 지정합니다. App 키, 환경 파일, 상태 DB는 저장소 밖에 두고 서비스 계정만 접근하도록 파일 권한을 설정합니다. 상태 DB에는 AES-256-GCM으로 암호화한 사용자 토큰과 처리 기록이 저장됩니다. 암호화 키는 DB와 분리해 보관합니다.

| 변수 | 값 |
| --- | --- |
| `REVIEW_APP_ID` / `REVIEW_APP_CLIENT_ID` | GitHub App 설정의 App ID와 Client ID |
| `REVIEW_INSTALLATION_ID` | 조직의 GitHub App 설치 설정 URL에 표시되는 숫자 |
| `REVIEW_REPO_ID` | `GET /repos/safeDeal-platform/safeDeal-Frontend` 응답의 `id` |
| `REVIEW_APP_PRIVATE_KEY_FILE` | 다운로드한 App PEM의 절대 경로 |
| `REVIEW_WEBHOOK_SECRET` | 32바이트 이상의 무작위 문자열 |
| `REVIEW_STATE_KEY` | 32바이트 무작위 키의 Base64 문자열. 예: `node -p "require('node:crypto').randomBytes(32).toString('base64')"` |
| `REVIEW_STATE_DB` | 저장소 밖의 영속 DB 경로 |
| `REVIEW_OLLAMA_MODEL` / `REVIEW_PORT` | 선택. 기본값 `qwen2.5-coder:7b` / `8787` |
| `REVIEW_AUTO_APPROVE` | 기본값 꺼짐. 아래 확인 뒤 `true`로 켭니다. |

## 팀원 동의와 시범 운영

운영자는 서버에서 `node tools/ai-review/main.mjs enroll <github-login>`을 실행합니다. 해당 팀원이 운영자와 확인한 일회용 코드를 직접 [GitHub 기기 인증 화면](https://github.com/login/device)에 입력하고 App에 동의합니다. 호스트 접근권한이나 비밀 키를 팀원에게 공유할 필요가 없습니다. 서비스가 GitHub 계정과 저장소 쓰기 권한을 확인하면 위임을 기록합니다. GitHub의 [사용자 위임 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)을 사용합니다.

1. `node tools/ai-review/main.mjs serve`로 실행하고, 시범 PR에서 등록된 팀원을 **Reviewers**에 직접 지정합니다. 팀 단위 지정, 포크, 초안, PR 작성자 본인에게 요청한 리뷰는 처리하지 않습니다. 등록 전에 지정했던 리뷰는 등록 후 다시 요청합니다.
2. 시범 PR에서 P1 → **Request changes**, 수정 푸시 → 새 커밋 **PASS**를 확인합니다. GitHub App의 **Recent deliveries**에서 웹훅 전송을 확인할 수 있습니다. 호스트가 꺼져 배달이 실패하면 GitHub 설정에서 배달을 다시 시도합니다. 모델 오류가 나면 같은 커밋에도 리뷰를 다시 요청할 수 있습니다.
3. 자동 승인을 켜기 전에 `dev` 보호 규칙에서 **Dismiss stale pull request approvals when new commits are pushed**와 **Require approval of the most recent reviewable push**를 켭니다. 서비스는 제출 직전에 PR을 다시 읽고 리뷰를 특정 커밋 SHA에 묶지만, GitHub 리뷰 API 자체는 읽기와 제출을 원자적으로 묶지 않습니다. 보호 규칙을 확인한 후에만 `REVIEW_AUTO_APPROVE=true`로 다시 실행하고 시범 PR에서 **Approve**까지 확인합니다.

자동 승인 범위는 `src/` 아래 텍스트 소스 코드와 스타일 변경, 최대 20개 파일 및 패치 24 KB입니다. 설정, 의존성, 워크플로, 바이너리나 불완전한 변경분은 수동으로 확인합니다. 모델은 변경분만 보며 테스트를 실행하지 않습니다. GitHub의 CI·머지 규칙은 따로 유지합니다.

팀원이 GitHub **Settings → Applications → Authorized GitHub Apps**에서 위임을 철회하거나, 운영자가 `node tools/ai-review/main.mjs revoke <github-user-id>`를 실행하면 이후 리뷰가 중단됩니다. 개별 PR에서 요청을 철회하거나 팀원이 직접 리뷰를 제출해도 해당 자동 흐름이 멈춥니다. 다시 사용하려면 리뷰를 새로 요청합니다.

로컬 검증: `node --test tools/ai-review/*.test.mjs`. 실제 GitHub App 설치와 계정 동의, Ollama 모델 정확도, GitHub 리뷰 제출은 시범 운영에서 확인합니다.
