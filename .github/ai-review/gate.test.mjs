// 실행 대상 판정(gate)·diff 분류·gate CLI — CIR-08, 09, 10, 11, 15, 22, 39, F1, G4, G6
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_AUTHORS, DIFF_LIMIT, classifyDiff, decide, decideEligibility } from './gate.mjs';

const REPO = 'safeDeal/safeDeal-Backend';
const pr = (over) => ({ author: 'CheatIsKey', actor: 'CheatIsKey', headRepo: REPO, baseRepo: REPO, ...over });
const denied = (reason) => ({ run: false, reason });

test('CIR-39 허용 목록은 CheatIsKey, DGAZA-max 두 명으로 고정', () => {
  assert.deepEqual(ALLOWED_AUTHORS, ['CheatIsKey', 'DGAZA-max']);
});

test('CIR-39·F1 작성자와 커밋한 사람이 모두 허용되면 리뷰한다', () => {
  assert.deepEqual(decideEligibility(pr()), { run: true });
  assert.deepEqual(decideEligibility(pr({ author: 'DGAZA-max', actor: 'CheatIsKey' })), { run: true });
});

test('CIR-39 allowlist를 넘기지 않으면 ALLOWED_AUTHORS를 쓴다', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'DGAZA-max', actor: 'DGAZA-max', allowlist: undefined })), { run: true });
});

test('CIR-39 GitHub 로그인은 대소문자를 구분하지 않는다(기타 결정)', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'cheatiskey', actor: 'DGAZA-MAX' })), { run: true });
});

test('CIR-39·CIR-22 허용 목록에 없는 작성자는 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'someone' })), denied('author_not_allowed'));
});

test('CIR-39 부분 일치는 허용이 아니다', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'CheatIsKey-evil' })), denied('author_not_allowed'));
  assert.deepEqual(decideEligibility(pr({ author: 'CheatIs' })), denied('author_not_allowed'));
});

test('CIR-39 작성자가 비어 있으면 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ author: '' })), denied('author_not_allowed'));
  assert.deepEqual(decideEligibility(pr({ author: undefined })), denied('author_not_allowed'));
});

test('CIR-39 넘겨받은 allowlist가 기준이 된다', () => {
  assert.deepEqual(decideEligibility(pr({ allowlist: ['someone'] })), denied('author_not_allowed'));
});

test('CIR-39 allowlist가 비면 누구도 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ allowlist: [] })), denied('author_not_allowed'));
});

test('CIR-09 봇·dependabot PR은 허용 작성자가 아니다', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'dependabot[bot]' })), denied('author_not_allowed'));
  assert.deepEqual(decideEligibility(pr({ author: 'github-actions[bot]' })), denied('author_not_allowed'));
});

test('F1 커밋한 사람(github.actor)이 허용 목록에 없으면 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ actor: 'someone' })), denied('actor_not_allowed'));
  assert.deepEqual(decideEligibility(pr({ actor: 'dependabot[bot]' })), denied('actor_not_allowed'));
});

test('F1 커밋한 사람이 비어 있으면 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ actor: '' })), denied('actor_not_allowed'));
  assert.deepEqual(decideEligibility(pr({ actor: undefined })), denied('actor_not_allowed'));
});

test('F1 작성자·커밋한 사람이 모두 허용되지 않으면 작성자 이유가 먼저', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'someone', actor: 'other' })), denied('author_not_allowed'));
});

test('CIR-15 포크 PR은 허용된 사람이라도 리뷰하지 않는다', () => {
  assert.deepEqual(decideEligibility(pr({ headRepo: 'CheatIsKey/safeDeal-Backend' })), denied('fork'));
});

test('CIR-15 포크 여부를 작성자·커밋한 사람보다 먼저 본다(기타 결정)', () => {
  assert.deepEqual(decideEligibility(pr({ author: 'someone', actor: 'other', headRepo: 'someone/x' })), denied('fork'));
});

test('CIR-15 head 레포가 삭제돼 비어 있으면 포크로 본다', () => {
  assert.deepEqual(decideEligibility(pr({ headRepo: null })), denied('fork'));
});

// ── classifyDiff / DIFF_LIMIT / decide (G4) ──
// 입력은 PR 이벤트의 숫자(changed_files·additions·deletions)다. 파일 목록 API는 부르지 않는다.
// limit은 { maxFiles, maxLines }. 실제 값은 시범에서 정하므로 여기서는 주입한다(CIR-10).
const LIMIT = { maxFiles: 3, maxLines: 100 };
const diff = (changed_files, additions, deletions) => ({ changed_files, additions, deletions });

test('G4 DIFF_LIMIT은 양의 정수 maxFiles·maxLines', () => {
  assert.deepEqual(Object.keys(DIFF_LIMIT).sort(), ['maxFiles', 'maxLines']);
  for (const v of Object.values(DIFF_LIMIT)) assert.ok(Number.isInteger(v) && v > 0, `양의 정수가 아님: ${v}`);
});

test('CIR-11 바뀐 파일이 0개면 empty_diff', () => {
  assert.equal(classifyDiff(diff(0, 0, 0), LIMIT), 'empty_diff');
});

test('CIR-10 파일 수가 기준을 넘으면 too_large', () => {
  assert.equal(classifyDiff(diff(4, 1, 0), LIMIT), 'too_large');
});

test('CIR-10 바뀐 줄 수(추가+삭제)가 기준을 넘으면 too_large', () => {
  assert.equal(classifyDiff(diff(1, 60, 41), LIMIT), 'too_large');
});

test('CIR-10 기준과 같으면 리뷰한다(경계값)', () => {
  assert.equal(classifyDiff(diff(3, 75, 25), LIMIT), null);
});

test('CIR-08 문서만 바뀐 작은 PR도 리뷰 대상', () => {
  assert.equal(classifyDiff(diff(1, 3, 1), LIMIT), null);
});

// decide: PR 이벤트의 pull_request 객체 + github.actor를 받아 fork → 작성자 → 커밋한 사람 → diff 순으로 본다.
const payload = (over = {}) => ({
  user: { login: 'CheatIsKey' },
  head: { repo: { full_name: REPO } },
  base: { repo: { full_name: REPO } },
  changed_files: 2,
  additions: 10,
  deletions: 3,
  ...over,
});

test('G4 허용된 사람의 작은 PR이면 리뷰한다', () => {
  assert.deepEqual(decide({ pr: payload(), actor: 'DGAZA-max', limit: LIMIT }), { run: true });
});

test('G4 limit을 넘기지 않으면 DIFF_LIMIT을 쓴다(작은 PR은 리뷰)', () => {
  assert.deepEqual(decide({ pr: payload({ changed_files: 1, additions: 1, deletions: 0 }), actor: 'CheatIsKey' }), { run: true });
});

test('G4 포크가 가장 먼저(빈 diff·비허용 작성자여도 fork)', () => {
  const pr = payload({ user: { login: 'someone' }, head: { repo: { full_name: 'someone/x' } }, changed_files: 0 });
  assert.deepEqual(decide({ pr, actor: 'someone', limit: LIMIT }), denied('fork'));
});

test('G4 head 레포가 삭제돼 null이면 fork', () => {
  assert.deepEqual(decide({ pr: payload({ head: { repo: null } }), actor: 'CheatIsKey', limit: LIMIT }), denied('fork'));
});

test('G4 작성자가 커밋한 사람·diff보다 먼저', () => {
  const pr = payload({ user: { login: 'someone' }, changed_files: 0 });
  assert.deepEqual(decide({ pr, actor: 'other', limit: LIMIT }), denied('author_not_allowed'));
});

test('G4·F1 커밋한 사람이 diff보다 먼저', () => {
  assert.deepEqual(decide({ pr: payload({ changed_files: 99 }), actor: 'someone', limit: LIMIT }), denied('actor_not_allowed'));
});

test('G4·CIR-11 사람 검사를 통과한 빈 PR은 empty_diff', () => {
  assert.deepEqual(decide({ pr: payload({ changed_files: 0, additions: 0, deletions: 0 }), actor: 'CheatIsKey', limit: LIMIT }), denied('empty_diff'));
});

test('G4·CIR-10 사람 검사를 통과한 큰 PR은 too_large', () => {
  assert.deepEqual(decide({ pr: payload({ changed_files: 4 }), actor: 'CheatIsKey', limit: LIMIT }), denied('too_large'));
});

// ── 변경 정보 검증 (G6) ──
// 값은 String(v)이 ^(0|[1-9]\d*)$일 때만 숫자로 본다(env 문자열·숫자 모두). 아니면 invalid_diff_stats.
test('G6 정상 문자열 값은 숫자로 읽는다', () => {
  assert.equal(classifyDiff(diff('0', '0', '0'), LIMIT), 'empty_diff');
  assert.equal(classifyDiff(diff('3', '75', '25'), LIMIT), null);
  assert.equal(classifyDiff(diff('4', '1', '0'), LIMIT), 'too_large');
});

test('G6 비었거나 음수·소수·NaN·앞자리 0이면 invalid_diff_stats', () => {
  for (const bad of [undefined, '', '-1', '1.5', 'NaN', '01', ' 1', 'abc', -1, 1.5, NaN]) {
    assert.equal(classifyDiff(diff(bad, '1', '0'), LIMIT), 'invalid_diff_stats', `changed_files=${String(bad)}`);
    assert.equal(classifyDiff(diff('1', bad, '0'), LIMIT), 'invalid_diff_stats', `additions=${String(bad)}`);
    assert.equal(classifyDiff(diff('1', '0', bad), LIMIT), 'invalid_diff_stats', `deletions=${String(bad)}`);
  }
});

test('G6 바뀐 파일이 0인데 추가·삭제 줄이 있으면 invalid_diff_stats', () => {
  assert.equal(classifyDiff(diff('0', '3', '0'), LIMIT), 'invalid_diff_stats');
  assert.equal(classifyDiff(diff(0, 0, 2), LIMIT), 'invalid_diff_stats');
});

test('G6 사람 검사를 통과한 PR의 변경 정보가 이상하면 리뷰하지 않는다', () => {
  assert.deepEqual(decide({ pr: payload({ additions: '' }), actor: 'CheatIsKey', limit: LIMIT }), denied('invalid_diff_stats'));
  assert.deepEqual(decide({ pr: payload({ changed_files: 0, additions: 5 }), actor: 'CheatIsKey', limit: LIMIT }), denied('invalid_diff_stats'));
});

test('G6 사람 검사가 변경 정보 검사보다 먼저', () => {
  assert.deepEqual(decide({ pr: payload({ additions: 'NaN' }), actor: 'someone', limit: LIMIT }), denied('actor_not_allowed'));
});

// ── gate CLI: node .github/ai-review/gate.mjs ──
// 입력 env: AUTHOR, ACTOR, HEAD_REPO, BASE_REPO, CHANGED_FILES, ADDITIONS, DELETIONS, GITHUB_OUTPUT(있으면 덧붙임).
// 출력: stdout과 GITHUB_OUTPUT에 `run=true|false`, `reason=<코드>`(리뷰하면 빈 값) 줄.
// 종료 코드: 판정을 냈으면 run 값과 상관없이 0. 실패는 다음 스텝(`steps.gate.outputs.run != 'true'` → exit 1)이 낸다.
//   (gate가 0이 아닌 코드로 끝나면 그 실패 스텝과 요약의 gate 이유 전달이 건너뛰어질 수 있어서다.)
// 큰 PR 확인에는 DIFF_LIMIT 기본값을 쓰므로, 어떤 기준값으로도 넘을 큰 수를 쓴다.
const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ai-review-gate-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const ENV = { AUTHOR: 'CheatIsKey', ACTOR: 'DGAZA-max', HEAD_REPO: REPO, BASE_REPO: REPO, CHANGED_FILES: '2', ADDITIONS: '12', DELETIONS: '0' };

function gate(over = {}) {
  const output = join(dir, `out-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(output, '');
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...ENV, ...over };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [GATE], { env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, file: readFileSync(output, 'utf8') };
}
function assertGate(r, run, reason) {
  for (const text of [r.out, r.file]) {
    assert.match(text, new RegExp(`^run=${run}$`, 'm'));
    assert.match(text, new RegExp(`^reason=${reason}$`, 'm'));
  }
  assert.equal(r.status, 0);
}

test('gate CLI 허용된 작은 PR이면 run=true, reason 빈 값, 종료 코드 0', () => {
  assertGate(gate(), 'true', '');
});

test('gate CLI 포크면 run=false reason=fork', () => {
  assertGate(gate({ HEAD_REPO: 'someone/safeDeal-Backend' }), 'false', 'fork');
  assertGate(gate({ HEAD_REPO: undefined }), 'false', 'fork');
  // H3: head 레포가 지워지면 워크플로는 미설정이 아니라 빈 문자열을 넘긴다
  assertGate(gate({ HEAD_REPO: '' }), 'false', 'fork');
});

test('gate CLI 작성자·커밋한 사람이 허용되지 않으면 각각의 이유', () => {
  assertGate(gate({ AUTHOR: 'someone' }), 'false', 'author_not_allowed');
  assertGate(gate({ ACTOR: 'dependabot[bot]' }), 'false', 'actor_not_allowed');
  assertGate(gate({ ACTOR: undefined }), 'false', 'actor_not_allowed');
  // H3: 빈 문자열도 거부
  assertGate(gate({ AUTHOR: '' }), 'false', 'author_not_allowed');
  assertGate(gate({ ACTOR: '' }), 'false', 'actor_not_allowed');
});

test("gate CLI 문자열 '0'만 바뀐 PR은 empty_diff", () => {
  assertGate(gate({ CHANGED_FILES: '0', ADDITIONS: '0', DELETIONS: '0' }), 'false', 'empty_diff');
});

test('gate CLI 변경 정보가 없거나 형식이 틀리면 invalid_diff_stats', () => {
  assertGate(gate({ DELETIONS: undefined }), 'false', 'invalid_diff_stats');
  assertGate(gate({ ADDITIONS: '01' }), 'false', 'invalid_diff_stats');
});

test('gate CLI 기준을 넘는 큰 PR은 too_large', () => {
  assertGate(gate({ CHANGED_FILES: '999999', ADDITIONS: '99999999' }), 'false', 'too_large');
});
