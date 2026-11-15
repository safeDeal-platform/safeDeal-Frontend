// 판정 표식 파서·건수·결과 추출·도구 검사·체크 결론·실패 분류
// — CIR-05, 06, 14, 17, 23, 24, 25, 26, F2, F4, G1, G2
// CLI: node .github/ai-review/verdict.mjs conclude
//   입력 env: NONCE, EXECUTION_FILE(claude-code-action의 execution_file), GITHUB_OUTPUT(있으면 덧붙임)
//   출력: stdout과 GITHUB_OUTPUT에 `verdict=<PASS|BLOCK|UNKNOWN>`, `reason=<코드>`, `findings=<P1+P2>`
//   종료 코드: PASS일 때만 0. 이 종료 코드가 ai-review 체크의 결론이다.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 허용 도구 기준값은 여기 한 곳. 워크플로의 --allowedTools는 이 값과 같은 집합이어야 한다(workflow.test.mjs).
export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'mcp__github_inline_comment__create_inline_comment'];

// G2: init 도구 목록에 있기만 해도 판정 불가가 되는 도구
const FORBIDDEN_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']);
const FORBIDDEN_MCP = /commit|push|merge|create_or_update|delete|approve/i;
// N1: 써도 되는 무해한 보조 도구. ToolSearch는 지연 로딩된 도구의 사용법만 불러온다.
// --allowedTools(ALLOWED_TOOLS)에는 넣지 않는다 — 권한이 필요 없고, 넣으면 ai-review.yml이 바뀐다.
const HELPER_TOOLS = ['ToolSearch'];

const unknown = (reason) => ({ verdict: 'UNKNOWN', reason });
const validNonce = (nonce) => typeof nonce === 'string' && nonce !== '' && nonce === nonce.trim();
const linesOf = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim());

// 판정 줄: 앞뒤 공백을 뺀 줄 전체가 정확히 `VERDICT[<nonce>]: PASS` 또는 `VERDICT[<nonce>]: BLOCK`.
// nonce는 문자 그대로 비교한다. 꾸민 줄(굵게·백틱·인용)은 접두어가 맞지 않으므로 판정 줄이 아니다(F4).
export function parseVerdict(text, nonce) {
  if (!validNonce(nonce)) return unknown('missing_nonce');
  if (typeof text !== 'string' || text.trim() === '') return unknown('empty_output');
  const prefix = `VERDICT[${nonce}]`;
  const hits = linesOf(text).filter((l) => l.startsWith(prefix));
  if (hits.length === 0) return unknown('no_verdict');
  if (hits.length > 1) return unknown('multiple_verdicts');
  if (hits[0] === `${prefix}: PASS`) return { verdict: 'PASS', reason: '' };
  if (hits[0] === `${prefix}: BLOCK`) return { verdict: 'BLOCK', reason: '' };
  return unknown('invalid_value');
}

// G1: `P1[<nonce>]: <정수>`, `P2[<nonce>]: <정수>`. 판정 줄과 같은 엄격한 규칙. 문제가 있으면 그 항목은 undefined.
function countLine(text, tag, nonce) {
  if (!validNonce(nonce)) return undefined;
  const prefix = `${tag}[${nonce}]: `;
  const hits = linesOf(text).filter((l) => l.startsWith(`${tag}[${nonce}]`));
  if (hits.length !== 1 || !hits[0].startsWith(prefix)) return undefined;
  const value = hits[0].slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function parseCounts(text, nonce) {
  const p1 = countLine(text, 'P1', nonce);
  const p2 = countLine(text, 'P2', nonce);
  return { p1, p2, total: p1 === undefined || p2 === undefined ? undefined : p1 + p2 };
}

function parseMessages(executionJson) {
  if (typeof executionJson !== 'string' || executionJson.trim() === '') return null;
  try {
    const messages = JSON.parse(executionJson);
    return Array.isArray(messages) ? messages : null;
  } catch {
    return null;
  }
}

const lastResultMessage = (messages) => messages.filter((m) => m?.type === 'result').pop();
const isSuccessResult = (m) => m?.subtype === 'success' && m.is_error !== true && typeof m.result === 'string';

// 마지막 result 메시지의 result만 쓴다(subtype이 success일 때만). 프롬프트·도구 결과·중간 글은 쓰지 않는다.
export function extractResultText(executionJson) {
  const messages = parseMessages(executionJson);
  if (!messages) return '';
  const last = lastResultMessage(messages);
  return isSuccessResult(last) ? last.result : '';
}

// G2: 쓴 도구(tool_use)는 모두 allowed 안에 있어야 하고, init 도구 목록에 금지 도구가 없어야 한다.
// 문제 없으면 null. 실행 기록을 읽을 수 없으면 확인할 수 없으므로 판정 불가.
export function checkTools(executionJson, allowed) {
  if (!parseMessages(executionJson)) return unknown('forbidden_tool');
  return forbiddenToolNames(executionJson, allowed).length ? unknown('forbidden_tool') : null;
}

// M1: 걸린 도구 이름(init의 금지 도구 + 허용 밖 tool_use), 처음 나온 순서·중복 없음. 로그용이라 이상한 이름은 <invalid>.
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
export function forbiddenToolNames(executionJson, allowed) {
  const messages = parseMessages(executionJson) ?? [];
  const permitted = new Set([...(Array.isArray(allowed) ? allowed : []), ...HELPER_TOOLS]);
  const isForbidden = (name) =>
    typeof name !== 'string' || FORBIDDEN_TOOLS.has(name) || (name.startsWith('mcp__') && FORBIDDEN_MCP.test(name));
  const hits = [];
  for (const m of messages) {
    if (m?.type === 'system' && m.subtype === 'init' && Array.isArray(m.tools)) hits.push(...m.tools.filter(isForbidden));
    if (m?.type === 'assistant') {
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      hits.push(...content.filter((c) => c?.type === 'tool_use' && !permitted.has(c.name)).map((c) => c.name));
    }
  }
  return [...new Set(hits.map((n) => (typeof n === 'string' && SAFE_TOOL_NAME.test(n) ? n : '<invalid>')))];
}

// F2: PASS는 "표식 PASS + P1 정수 0건"일 때만. P1이 1건 이상이면 BLOCK. 그 밖은 판정 불가.
export function finalVerdict({ verdict, p1Count } = {}) {
  if (verdict === 'BLOCK') return 'BLOCK';
  if (verdict !== 'PASS' || !Number.isInteger(p1Count) || p1Count < 0) return 'UNKNOWN';
  return p1Count === 0 ? 'PASS' : 'BLOCK';
}

export function conclusionOf({ verdict, p1Count } = {}) {
  return finalVerdict({ verdict, p1Count }) === 'PASS' ? 'success' : 'failure';
}

// 아래 문구는 문서·관찰에서 가져온 가정값이다. 시범에서 실제 출력으로 바꾼다(테스트 변경 승인 절차).
const USAGE_LIMIT = /session limit|weekly limit|usage limit|spend limit|API Error: 429|rate_limit_error/i;
// O1: 실측(2026-11-15) — "Failed to authenticate. API Error: 401 …", 토큰에 줄바꿈이 있으면 "Invalid auth token · Fix external auth token …"
const AUTH_FAILED = /OAuth token (revoked|has expired)|does not have access to Claude Code|API Error: 401|authentication_error|Failed to authenticate|Invalid auth token|Fix external auth token/i;
const UPSTREAM = /API Error: 5\d\d|overloaded/i;

export function classifyFailure({ exitCode, stderr, timedOut } = {}) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (timedOut === true) return 'timeout';
  if (exitCode === 0) return null;
  if (/error_max_turns/.test(text)) return 'timeout';
  if (USAGE_LIMIT.test(text)) return 'usage_limit';
  if (AUTH_FAILED.test(text)) return 'auth_failed';
  if (UPSTREAM.test(text)) return 'upstream_error';
  return 'unknown';
}

// conclude: 실행 기록에서 판정을 낸다. 어느 단계에서든 확인이 안 되면 판정 불가(PASS 아님).
export function conclude({ nonce, executionJson } = {}) {
  if (!validNonce(nonce)) return { ...unknown('missing_nonce'), findings: undefined };
  const messages = parseMessages(executionJson);
  if (!messages) return { ...unknown('empty_output'), findings: undefined };
  const toolProblem = checkTools(executionJson, ALLOWED_TOOLS);
  if (toolProblem) return { ...toolProblem, findings: undefined };
  const last = lastResultMessage(messages);
  if (!last) return { ...unknown('empty_output'), findings: undefined };
  if (!isSuccessResult(last)) {
    // O1: 구조화된 상태 코드가 401·403이면 문구와 상관없이 인증 실패.
    if (last.api_error_status === 401 || last.api_error_status === 403) return { ...unknown('auth_failed'), findings: undefined };
    // 실패한 result(error_max_turns, is_error 등)의 내용으로 이유를 분류한다.
    return { ...unknown(classifyFailure({ exitCode: 1, stderr: JSON.stringify(last), timedOut: false })), findings: undefined };
  }
  const text = extractResultText(executionJson);
  const parsed = parseVerdict(text, nonce);
  if (parsed.verdict === 'UNKNOWN') return { ...parsed, findings: undefined };
  const counts = parseCounts(text, nonce);
  // G1: 건수 줄도 판정 줄과 같은 엄격한 규칙 — 어느 한쪽이라도 읽지 못하면 판정 불가.
  if (counts.total === undefined) return { ...unknown('invalid_counts'), findings: undefined };
  const verdict = finalVerdict({ verdict: parsed.verdict, p1Count: counts.p1 });
  return { verdict, reason: verdict === 'UNKNOWN' ? 'invalid_counts' : '', findings: counts.total };
}

function readExecutionFile(path) {
  if (typeof path !== 'string' || path === '') return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'conclude') {
    process.stderr.write('usage: node verdict.mjs conclude\n');
    process.exit(2);
  }
  const env = process.env;
  const result = conclude({ nonce: env.NONCE, executionJson: readExecutionFile(env.EXECUTION_FILE) });
  const lines = `verdict=${result.verdict}\nreason=${result.reason}\nfindings=${result.findings ?? ''}\n`;
  process.stdout.write(lines);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  if (result.reason === 'forbidden_tool') {
    // M1: 실행 기록은 로그에 안 나오므로 걸린 도구 이름만 남긴다.
    const names = forbiddenToolNames(readExecutionFile(env.EXECUTION_FILE), ALLOWED_TOOLS);
    process.stderr.write(`::warning::forbidden_tools=${names.join(',') || '(실행 기록을 읽을 수 없음)'}\n`);
  }
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}
