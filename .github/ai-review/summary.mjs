// 요약 댓글 — CIR-05, 06, 10, 11, 13, 14, 15, 23, 24, 26, 27, 32, 34, 36, 39, F1, G2, G4, G6
// CLI:
//   node .github/ai-review/summary.mjs build
//     입력 env: VERDICT, VERDICT_REASON, FINDINGS(verdict.mjs conclude 출력), GATE_REASON, HEAD_SHA, DIFF_FILE
//     출력: 요약 글(markdown)을 stdout에
//   node .github/ai-review/summary.mjs comment
//     입력 env: BODY_FILE, PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_EVENT_PATH
//     표식이 있는 github-actions[bot] 요약 댓글 1개를 수정하고, 없으면 새로 단다(CIR-32).
//     PR의 현재 head가 이번 실행 SHA(이벤트 파일의 pull_request.head.sha)와 다르면
//     (옛 커밋 Re-run 등) 댓글을 건드리지 않고 실패한다(CIR-42·L1).
//     실패하면 종료 코드 1(판정은 이미 $GITHUB_STEP_SUMMARY에 있다, CIR-27).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUMMARY_MARKER = '<!-- ai-review-summary -->';
const SUMMARY_AUTHOR = 'github-actions[bot]';

// 판정 불가 이유별 문구. BLOCK·판정 불가 요약에는 "PASS" 글자를 쓰지 않는다.
const REASON_LABELS = {
  fork: '외부 PR은 처리하지 않음', // CIR-15
  author_not_allowed: '허용된 작성자가 아님', // CIR-39
  actor_not_allowed: '커밋한 사람이 허용 목록에 없음', // F1
  empty_diff: '리뷰할 변경 없음', // CIR-11
  too_large: '범위 초과', // CIR-10
  invalid_diff_stats: '변경 정보 이상', // G6
  usage_limit: '사용 한도', // CIR-23
  auth_failed: '인증 실패', // CIR-24
  timeout: '시간/턴 초과', // CIR-14
  no_verdict: '판정 표식 없음', // CIR-26
  multiple_verdicts: '판정 표식 중복', // CIR-26
  invalid_value: '판정 표식 형식 오류', // CIR-26
  // 아래는 CASES.md에 문구가 없어 구현에서 정했다(사람 검토 필요).
  upstream_error: '서비스 오류', // CIR-25
  empty_output: '실행 결과 없음', // CIR-26
  missing_nonce: '판정 확인값 없음', // CIR-26
  forbidden_tool: '허용되지 않은 도구 사용', // G2
  invalid_counts: '지적 수 표식 오류', // G1
};
const UNKNOWN_LABEL = '알 수 없는 오류';

// G4: gate가 거른 이유가 있으면 그것을 쓴다.
export function pickReason({ gateReason, verdictReason } = {}) {
  if (typeof gateReason === 'string' && gateReason !== '') return gateReason;
  if (typeof verdictReason === 'string' && verdictReason !== '') return verdictReason;
  return 'unknown';
}

const shortSha = (sha) => (typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : '알 수 없음');
// M2: 제어 문자는 지우지 않고 escape로 보여 준다(a<줄바꿈>b.md와 ab.md 구분).
// 역슬래시를 먼저 \\로 바꿔야 실제 줄바꿈(\n 표시)과 "역슬래시+n" 글자(\\n 표시)가 구분된다.
const CONTROL_ESCAPES = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const showControl = (ch) => CONTROL_ESCAPES[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
// M3: 백틱은 지우지 않고, 내용의 가장 긴 백틱 연속보다 한 개 긴 구분자로 감싼다.
// 백틱이나 공백으로 시작·끝나면 앞뒤 공백(CommonMark가 코드 스팬 양끝 공백을 한 칸씩 지우므로).
const code = (s) => {
  const text = String(s).replace(/[\\\x00-\x1f\x7f]/g, showControl);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[ `]|[ `]$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
};
const isCount = (n) => Number.isInteger(n) && n >= 0;

export function buildSummary({ verdict, reason, sha, reviewedFiles, findingCount, resolved } = {}) {
  const files = Array.isArray(reviewedFiles) ? reviewedFiles : [];
  const done = Array.isArray(resolved) ? resolved : [];
  const out = [SUMMARY_MARKER, '## ai-review', `기준 SHA: ${shortSha(sha)}`];

  if (verdict === 'PASS' || verdict === 'BLOCK') {
    out.push(`판정: ${verdict}`);
    out.push(`지적 수: ${isCount(findingCount) ? findingCount : '알 수 없음'}`);
    out.push(files.length ? `검토 범위(${files.length}개 파일):\n${files.map((f) => `- ${code(f)}`).join('\n')}` : '검토 범위: 없음');
  } else {
    // 판정 불가(Q4): 일부만 보았거나 보지 못했으므로 검토 범위를 확인된 것으로 적지 않는다.
    out.push(`판정 불가: ${REASON_LABELS[reason] ?? UNKNOWN_LABEL}`);
    out.push('검토 범위: 확인되지 않음');
  }

  if (done.length) out.push(`해결됨:\n${done.map((r) => `- ${String(r).replace(/[\r\n]+/g, ' ')}`).join('\n')}`);
  return `${out.join('\n\n')}\n`;
}

// CIR-32: GITHUB_TOKEN으로 단(작성자 github-actions[bot]) 표식 댓글 중 가장 먼저 단 것의 id. 없으면 null.
export function findSummaryComment(comments) {
  if (!Array.isArray(comments)) return null;
  const found = comments.find(
    (c) => c?.user?.login === SUMMARY_AUTHOR && typeof c.body === 'string' && c.body.startsWith(SUMMARY_MARKER),
  );
  return found ? found.id : null;
}

// CIR-41: git이 C 방식으로 인용한 경로("..." 안의 \NNN 8진수 바이트, \t, \", \\ 등)를 실제 경로로 되돌린다.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function unquoteGitPath(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(...Buffer.from(s[i], 'utf8'));
    } else if (/^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const c = s[++i] ?? '';
      bytes.push(...(c in ESCAPES ? [ESCAPES[c]] : Buffer.from(c, 'utf8')));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// 변경분 파일(git diff 출력)의 `diff --git a/<경로> b/<경로>` 줄에서 바뀐 파일 경로(b쪽)를 읽는다.
export function filesFromDiff(diffText) {
  const files = [];
  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    const quoted = line.match(/^diff --git .* "b\/((?:[^"\\]|\\.)*)"$/);
    const path = quoted ? unquoteGitPath(quoted[1]) : line.match(/^diff --git "?a\/.*?"? b\/(.*)$/)?.[1];
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

// CIR-42: 이번 실행 SHA와 PR 현재 head가 둘 다 온전한 SHA이고 같을 때만 최신 실행이다. 확인할 수 없으면 오래된 실행으로 본다.
const FULL_SHA = /^[0-9a-f]{40}$/;

// CIR-42·L1: GitHub가 넣어 주는 이벤트 JSON에서 이번 실행의 PR head SHA를 읽는다. 읽을 수 없으면 undefined.
export function runShaFromEvent(eventText) {
  try {
    const sha = JSON.parse(eventText)?.pull_request?.head?.sha;
    return typeof sha === 'string' ? sha : undefined;
  } catch {
    return undefined;
  }
}
export function isStaleHead({ runSha, currentHeadSha } = {}) {
  return !(FULL_SHA.test(runSha ?? '') && FULL_SHA.test(currentHeadSha ?? '') && runSha === currentHeadSha);
}

function buildFromEnv(env) {
  const gateReason = env.GATE_REASON ?? '';
  // gate가 걸렀으면 Claude를 부르지 않았으므로 판정은 판정 불가다.
  const verdict = gateReason === '' && (env.VERDICT === 'PASS' || env.VERDICT === 'BLOCK') ? env.VERDICT : 'UNKNOWN';
  const findings = /^(0|[1-9]\d*)$/.test(env.FINDINGS ?? '') ? Number(env.FINDINGS) : undefined;
  const diffFile = env.DIFF_FILE || '.git/ai-review-pr.diff';
  const reviewedFiles = existsSync(diffFile) ? filesFromDiff(readFileSync(diffFile, 'utf8')) : [];
  return buildSummary({
    verdict,
    reason: pickReason({ gateReason, verdictReason: env.VERDICT_REASON }),
    sha: env.HEAD_SHA,
    reviewedFiles,
    findingCount: findings,
    resolved: [],
  });
}

async function github(env, method, path, body) {
  const res = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
  return res.json();
}

async function upsertComment(env) {
  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR_NUMBER;
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(pr ?? '')) {
    throw new Error('GITHUB_TOKEN·GITHUB_REPOSITORY·PR_NUMBER가 필요하다');
  }
  const runSha = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)
    ? runShaFromEvent(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : undefined;
  const current = await github(env, 'GET', `/repos/${repo}/pulls/${pr}`);
  if (isStaleHead({ runSha, currentHeadSha: current?.head?.sha })) {
    throw new Error(`오래된 실행이라 요약 댓글을 고치지 않는다(실행 ${runSha ?? '?'}, 현재 head ${current?.head?.sha ?? '?'})`);
  }
  const body = readFileSync(env.BODY_FILE, 'utf8');
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await github(env, 'GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const id = findSummaryComment(comments);
  if (id === null) await github(env, 'POST', `/repos/${repo}/issues/${pr}/comments`, { body });
  else await github(env, 'PATCH', `/repos/${repo}/issues/comments/${id}`, { body });
  process.stdout.write(id === null ? '요약 댓글을 새로 달았다\n' : `요약 댓글 ${id}을 수정했다\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'build') {
    process.stdout.write(buildFromEnv(process.env));
  } else if (mode === 'comment') {
    upsertComment(process.env).catch((e) => {
      process.stderr.write(`::error::요약 댓글 등록 실패: ${e.message}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write('usage: node summary.mjs build|comment\n');
    process.exit(2);
  }
}
