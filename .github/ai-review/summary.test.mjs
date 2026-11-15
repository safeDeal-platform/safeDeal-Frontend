// 요약 댓글 — CIR-05, 06, 10, 11, 13, 14, 15, 23, 24, 26, 32, 34, 36, 39, F1, G2, G4, G6
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_MARKER, buildSummary, filesFromDiff, findSummaryComment, isStaleHead, pickReason, runShaFromEvent } from './summary.mjs';

const MARKER = '<!-- ai-review-summary -->';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILES = ['src/main/java/com/safedeal/A.java', 'README.md'];
const pass = { verdict: 'PASS', sha: SHA, reviewedFiles: FILES, findingCount: 0, resolved: [] };
const unknown = (reason) => ({ verdict: 'UNKNOWN', reason, sha: SHA, reviewedFiles: FILES, findingCount: 0, resolved: [] });

test('CIR-32 요약 표식 값은 고정', () => {
  assert.equal(SUMMARY_MARKER, MARKER);
});

test('CIR-13·CIR-32 모든 판정의 요약에 표식, 정확히 7자리 기준 SHA, 검토 범위가 있다', () => {
  for (const input of [pass, { ...pass, verdict: 'BLOCK', findingCount: 1 }, unknown('no_verdict')]) {
    const text = buildSummary(input);
    assert.ok(text.includes(MARKER), `${input.verdict}: 표식 없음`);
    assert.match(text, /기준 SHA[^\n]*0123456/, `${input.verdict}: 기준 SHA 없음`);
    assert.ok(!text.includes(SHA.slice(0, 8)), `${input.verdict}: SHA는 7자리만 적는다`);
    assert.match(text, /검토 범위/, `${input.verdict}: 검토 범위 없음`);
  }
});

test('CIR-05 PASS 요약은 고정 판정 줄, 검토한 파일, 지적 수를 함께 적는다', () => {
  const text = buildSummary({ ...pass, findingCount: 2 });
  assert.match(text, /^판정: PASS$/m);
  for (const f of FILES) assert.ok(text.includes(f), `검토 파일 ${f} 없음`);
  assert.match(text, /지적 수\D*2/);
});

test('CIR-06 BLOCK 요약은 고정 판정 줄과 지적 수를 적고 PASS라고 쓰지 않는다', () => {
  const text = buildSummary({ ...pass, verdict: 'BLOCK', findingCount: 3 });
  assert.match(text, /^판정: BLOCK$/m);
  assert.match(text, /지적 수\D*3/);
  assert.doesNotMatch(text, /PASS/);
});

const LABELS = {
  usage_limit: '사용 한도', // CIR-23
  auth_failed: '인증 실패', // CIR-24
  timeout: '시간/턴 초과', // CIR-14
  too_large: '범위 초과', // CIR-10
  no_verdict: '판정 표식 없음', // CIR-26
  multiple_verdicts: '판정 표식 중복', // CIR-26
  invalid_value: '판정 표식 형식 오류', // CIR-26
  invalid_diff_stats: '변경 정보 이상', // G6
};

for (const [reason, label] of Object.entries(LABELS)) {
  test(`CIR-10·14·23·24·26 판정 불가(${reason}) 요약은 "판정 불가: ${label}"`, () => {
    const text = buildSummary(unknown(reason));
    assert.match(text, new RegExp(`판정 불가: ${label}`));
    assert.doesNotMatch(text, /PASS/);
  });
}

test('CIR-25·26 한국어 문구가 정해지지 않은 이유도 판정 불가로 적고 PASS라고 쓰지 않는다', () => {
  for (const reason of ['upstream_error', 'unknown', 'empty_output', 'missing_nonce', 'forbidden_tool']) {
    const text = buildSummary(unknown(reason));
    assert.match(text, /판정 불가/, reason);
    assert.doesNotMatch(text, /PASS/, reason);
  }
});

test('CIR-15 포크 PR 요약은 "외부 PR은 처리하지 않음"', () => {
  const text = buildSummary(unknown('fork'));
  assert.match(text, /외부 PR은 처리하지 않음/);
  assert.doesNotMatch(text, /PASS/);
});

test('CIR-39 허용되지 않은 작성자 요약은 "허용된 작성자가 아님"', () => {
  const text = buildSummary(unknown('author_not_allowed'));
  assert.match(text, /허용된 작성자가 아님/);
  assert.doesNotMatch(text, /PASS/);
});

// 문구는 CASES.md에 없어 테스트 작성자가 정했다(사람 검토 필요).
test('F1 커밋한 사람이 허용되지 않으면 "커밋한 사람이 허용 목록에 없음"', () => {
  const text = buildSummary(unknown('actor_not_allowed'));
  assert.match(text, /커밋한 사람이 허용 목록에 없음/);
  assert.doesNotMatch(text, /PASS/);
});

test('CIR-11 diff가 비면 "리뷰할 변경 없음", "검토 완료"·PASS 금지', () => {
  const text = buildSummary({ ...unknown('empty_diff'), reviewedFiles: [] });
  assert.match(text, /리뷰할 변경 없음/);
  assert.doesNotMatch(text, /검토 완료/);
  assert.doesNotMatch(text, /PASS/);
});

test('CIR-34 해결된 이전 지적은 "해결됨"으로 표시', () => {
  const text = buildSummary({ ...pass, resolved: ['A.java:10 널 체크 누락'] });
  assert.match(text, /해결됨[\s\S]*A\.java:10 널 체크 누락/);
});

const bot = (id, body) => ({ id, body, user: { login: 'github-actions[bot]', type: 'Bot' } });
const claudeBot = (id, body) => ({ id, body, user: { login: 'claude[bot]', type: 'Bot' } });
const human = (id, body) => ({ id, body, user: { login: 'CheatIsKey', type: 'User' } });

test('CIR-32 표식이 있는 github-actions[bot] 댓글을 찾아 수정 대상으로 돌려준다', () => {
  const comments = [human(1, '좋아요'), bot(2, `${MARKER}\n판정: PASS`), bot(3, '다른 봇 메시지')];
  assert.equal(findSummaryComment(comments), 2);
});

test('CIR-32 사람이 표식을 붙여 쓴 댓글은 무시', () => {
  assert.equal(findSummaryComment([human(1, `> ${MARKER} 인용`)]), null);
});

test('CIR-32 claude[bot]이 단 표식 댓글은 수정 대상이 아니다(GITHUB_TOKEN 댓글만)', () => {
  assert.equal(findSummaryComment([claudeBot(4, MARKER)]), null);
  assert.equal(findSummaryComment([claudeBot(4, MARKER), bot(6, MARKER)]), 6);
});

test('CIR-32 요약 댓글이 없으면 null', () => {
  assert.equal(findSummaryComment([]), null);
  assert.equal(findSummaryComment([bot(5, '표식 없는 봇 댓글')]), null);
});

test('CIR-36 표식 댓글이 여럿이면 가장 먼저 단 것 하나만 수정한다', () => {
  assert.equal(findSummaryComment([bot(7, MARKER), bot(9, MARKER)]), 7);
});

// ── pickReason (G4) ── gate가 거른 이유가 있으면 그것을 쓴다(Claude를 부르지 않았으므로 판정 이유는 부수 결과다).
test('G4 gate 이유가 판정 이유보다 우선', () => {
  assert.equal(pickReason({ gateReason: 'too_large', verdictReason: 'empty_output' }), 'too_large');
  assert.equal(pickReason({ gateReason: 'fork', verdictReason: 'forbidden_tool' }), 'fork');
});

test('G4 gate 이유가 비면 판정 이유', () => {
  assert.equal(pickReason({ gateReason: '', verdictReason: 'no_verdict' }), 'no_verdict');
  assert.equal(pickReason({ gateReason: undefined, verdictReason: 'forbidden_tool' }), 'forbidden_tool');
});

test('G4 둘 다 비면 unknown', () => {
  assert.equal(pickReason({ gateReason: '', verdictReason: '' }), 'unknown');
  assert.equal(pickReason({}), 'unknown');
});

// CIR-41: git이 C 방식으로 인용한 경로를 실제 경로로 되돌린다.
test('CIR-41 인용되지 않은 경로는 그대로', () => {
  assert.deepEqual(filesFromDiff('diff --git a/src/A.java b/src/A.java\n+x'), ['src/A.java']);
});

// 입력은 git이 실제로 찍는 글자 그대로 쓰려고 String.raw를 쓴다(\355는 역슬래시+숫자 세 글자).
test('CIR-41 한글 경로(8진수 UTF-8 바이트)를 실제 경로로', () => {
  assert.deepEqual(filesFromDiff(String.raw`diff --git "a/docs/\355\225\234.md" "b/docs/\355\225\234.md"`), ['docs/한.md']);
});

test('CIR-41 역슬래시·따옴표·탭 escape를 되돌린다', () => {
  assert.deepEqual(filesFromDiff(String.raw`diff --git "a/a\\b.txt" "b/a\\b.txt"`), ['a\\b.txt']);
  assert.deepEqual(filesFromDiff(String.raw`diff --git "a/q\"x.txt" "b/q\"x.txt"`), ['q"x.txt']);
  assert.deepEqual(filesFromDiff(String.raw`diff --git "a/t\tab.txt" "b/t\tab.txt"`), ['t\tab.txt']);
});

test('CIR-41 이름이 바뀌어 b쪽만 인용된 경우 b쪽 경로', () => {
  assert.deepEqual(filesFromDiff(String.raw`diff --git a/old.md "b/\355\225\234.md"`), ['한.md']);
});

// CIR-42: 요약 댓글을 고치기 전에 PR 현재 head와 이번 실행 SHA를 비교한다. 확인할 수 없으면 오래된 실행으로 본다.
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
test('CIR-42 현재 head와 실행 SHA가 같으면 최신 실행', () => {
  assert.equal(isStaleHead({ runSha: SHA, currentHeadSha: SHA }), false);
});

test('CIR-42 현재 head가 다르면 오래된 실행', () => {
  assert.equal(isStaleHead({ runSha: SHA, currentHeadSha: OTHER }), true);
});

test('CIR-42 어느 쪽이든 없거나 SHA 형식이 아니면 오래된 실행으로 본다(fail closed)', () => {
  for (const [runSha, currentHeadSha] of [[undefined, SHA], [SHA, undefined], ['', SHA], [SHA, ''], ['abc', 'abc'], [SHA.slice(0, 7), SHA]]) {
    assert.equal(isStaleHead({ runSha, currentHeadSha }), true, `${runSha} / ${currentHeadSha}`);
  }
  assert.equal(isStaleHead(), true);
});

// CIR-42·L1: 이번 실행 SHA는 GitHub가 넣어 주는 이벤트 파일(GITHUB_EVENT_PATH)의 pull_request.head.sha에서 읽는다.
// 워크플로 env로 넘기면 ai-review.yml을 고쳐야 하고, 고친 PR에서는 Claude가 실행되지 않는다.
test('CIR-42·L1 이벤트 JSON의 pull_request.head.sha를 실행 SHA로 읽는다', () => {
  assert.equal(runShaFromEvent(JSON.stringify({ pull_request: { head: { sha: SHA } } })), SHA);
});

test('CIR-42·L1 이벤트 파일이 없거나 깨졌거나 SHA가 없으면 undefined(→ 오래된 실행으로 처리)', () => {
  for (const text of [undefined, '', '{', 'null', '{}', JSON.stringify({ pull_request: {} }), JSON.stringify({ pull_request: { head: { sha: 42 } } })]) {
    assert.equal(runShaFromEvent(text), undefined, String(text));
    assert.equal(isStaleHead({ runSha: runShaFromEvent(text), currentHeadSha: SHA }), true);
  }
});

// M2: 복원한 경로의 제어 문자를 지우지 않고 escape로 보여 준다. a<줄바꿈>b.md와 ab.md가 구분돼야 한다.
test('M2 경로의 줄바꿈·탭은 \\n·\\t로 보여 주고 지우지 않는다', () => {
  const files = filesFromDiff(String.raw`diff --git "a/a\nb.md" "b/a\nb.md"
diff --git a/ab.md b/ab.md
diff --git "a/t\tx.md" "b/t\tx.md"`);
  assert.deepEqual(files, ['a\nb.md', 'ab.md', 't\tx.md']);
  const s = buildSummary({ ...pass, reviewedFiles: files });
  assert.ok(s.includes('`a\\nb.md`'), s);
  assert.ok(s.includes('`ab.md`'), s);
  assert.ok(s.includes('`t\\tx.md`'), s);
  assert.match(s, /검토 범위\(3개 파일\)/);
});

// M2 보완(CodeRabbit #42): 실제 줄바꿈 경로와 "역슬래시+n" 경로가 같은 표시가 되면 안 된다. 역슬래시를 먼저 \\로 보여 준다.
test('M2 실제 줄바꿈 경로와 역슬래시+n 경로는 표시가 다르다', () => {
  const s = buildSummary({ ...pass, reviewedFiles: ['a\nb.md', String.raw`a\nb.md`] });
  assert.ok(s.includes('- `' + String.raw`a\nb.md` + '`\n'), s); // 실제 줄바꿈 → \n
  assert.ok(s.includes('- `' + String.raw`a\\nb.md` + '`'), s); // 역슬래시+n → \\n
});

// M3(CodeRabbit #42): 경로의 백틱을 지우지 않는다. 내용의 가장 긴 백틱 연속보다 긴 구분자로 감싼다(CommonMark 인라인 코드).
test('M3 백틱이 든 경로는 백틱을 지우지 않고 더 긴 구분자로 감싼다', () => {
  const s = buildSummary({ ...pass, reviewedFiles: ['a`b.md', 'ab.md', 'x``y.md', '`edge.md'] });
  assert.ok(s.includes('- ``a`b.md``\n'), s);
  assert.ok(s.includes('- `ab.md`\n'), s);
  assert.ok(s.includes('- ```x``y.md```\n'), s);
  assert.ok(s.includes('- `` `edge.md ``'), s); // 백틱으로 시작·끝나면 앞뒤 공백
});

// M3 보완(CodeRabbit #42): CommonMark는 코드 스팬 양끝 공백을 한 칸씩 지우므로, 공백으로 시작·끝나는 경로도 앞뒤에 공백을 둔다.
test('M3 양끝 공백이 있는 경로는 공백 없는 경로와 다르게 보인다', () => {
  const s = buildSummary({ ...pass, reviewedFiles: [' a ', 'a', 'b '] });
  assert.ok(s.includes('- `  a  `\n'), s);
  assert.ok(s.includes('- `a`\n'), s);
  assert.ok(s.includes('- ` b  `'), s);
});
