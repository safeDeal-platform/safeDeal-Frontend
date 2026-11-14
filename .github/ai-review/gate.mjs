// 실행 대상 판정(gate) — CIR-09, 10, 11, 15, 22, 39, F1, G4, G6
// CLI: node .github/ai-review/gate.mjs
//   입력 env: AUTHOR, ACTOR, HEAD_REPO, BASE_REPO, CHANGED_FILES, ADDITIONS, DELETIONS, GITHUB_OUTPUT(있으면 덧붙임)
//   출력: stdout과 GITHUB_OUTPUT에 `run=true|false`, `reason=<코드>`(리뷰하면 빈 값)
//   종료 코드: 판정을 냈으면 0. 실패는 다음 스텝(`steps.gate.outputs.run != 'true'` → exit 1)이 낸다.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_AUTHORS = ['CheatIsKey', 'DGAZA-max'];

// { maxFiles, maxLines } — 시범 전 임시값. 실제 값은 시범에서 정한다(G4, CIR-10).
export const DIFF_LIMIT = { maxFiles: 50, maxLines: 2000 };

const deny = (reason) => ({ run: false, reason });

// GitHub 로그인은 대소문자를 구분하지 않는다. 빈 값·부분 일치는 허용이 아니다.
function isAllowed(login, allowlist) {
  if (typeof login !== 'string' || login === '' || !Array.isArray(allowlist)) return false;
  const who = login.toLowerCase();
  return allowlist.some((x) => typeof x === 'string' && x.toLowerCase() === who);
}

// 순서: 포크 → 작성자 → 커밋한 사람(github.actor). head 레포가 비면(삭제됨) 포크로 본다.
export function decideEligibility({ author, actor, headRepo, baseRepo, allowlist = ALLOWED_AUTHORS } = {}) {
  if (typeof headRepo !== 'string' || headRepo === '' || headRepo !== baseRepo) return deny('fork');
  if (!isAllowed(author, allowlist)) return deny('author_not_allowed');
  if (!isAllowed(actor, allowlist)) return deny('actor_not_allowed');
  return { run: true };
}

// G6: String(v)이 ^(0|[1-9]\d*)$일 때만 숫자로 본다. 아니면 null.
function count(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (!/^(0|[1-9]\d*)$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// 반환: null(리뷰한다) | 'empty_diff' | 'too_large' | 'invalid_diff_stats'
export function classifyDiff({ changed_files, additions, deletions } = {}, limit = DIFF_LIMIT) {
  const files = count(changed_files);
  const added = count(additions);
  const deleted = count(deletions);
  if (files === null || added === null || deleted === null) return 'invalid_diff_stats';
  if (files === 0) return added + deleted > 0 ? 'invalid_diff_stats' : 'empty_diff';
  return files > limit.maxFiles || added + deleted > limit.maxLines ? 'too_large' : null;
}

// pr: PR 이벤트의 pull_request 객체, actor: github.actor. 순서: 포크 → 작성자 → 커밋한 사람 → 변경 정보
export function decide({ pr, actor, limit = DIFF_LIMIT } = {}) {
  const p = pr ?? {};
  const eligibility = decideEligibility({
    author: p.user?.login,
    actor,
    headRepo: p.head?.repo?.full_name,
    baseRepo: p.base?.repo?.full_name,
  });
  if (!eligibility.run) return eligibility;
  const reason = classifyDiff(p, limit);
  return reason ? deny(reason) : { run: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const pr = {
    user: { login: env.AUTHOR },
    head: { repo: env.HEAD_REPO ? { full_name: env.HEAD_REPO } : null },
    base: { repo: { full_name: env.BASE_REPO } },
    changed_files: env.CHANGED_FILES,
    additions: env.ADDITIONS,
    deletions: env.DELETIONS,
  };
  const result = decide({ pr, actor: env.ACTOR });
  const lines = `run=${result.run}\nreason=${result.reason ?? ''}\n`;
  process.stdout.write(lines);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
}
