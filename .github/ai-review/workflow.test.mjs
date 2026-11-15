// ai-review.yml 정적 검사 — CIR-07, 08, 09, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 27, 28, 32, 35, 39,
// F1, F2, F3, G1, G2, G4, G5, G7, 기타
// 백엔드 safeDeal-Backend dev 153d188에서 복사(C-D). 프론트에는 기존 CI가 없어 CIR-29는 해당 없음. 맨 아래 C-K는 프론트 전용.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './test-support/mini-yaml.mjs';
import { ALLOWED_TOOLS } from './verdict.mjs'; // 허용 도구 기준값은 verdict.mjs 한 곳(기타 결정)

const WF_PATH = fileURLToPath(new URL('../workflows/ai-review.yml', import.meta.url));

function load() {
  assert.ok(existsSync(WF_PATH), `ai-review.yml이 있어야 한다: ${WF_PATH}`);
  const raw = readFileSync(WF_PATH, 'utf8');
  return { raw, wf: parseYaml(raw) };
}
const jobs = (wf) => Object.values(wf.jobs ?? {});
const allSteps = (wf) => jobs(wf).flatMap((j) => j.steps ?? []);
const reviewJob = (wf) => wf.jobs?.['ai-review'];
const steps = (wf) => reviewJob(wf)?.steps ?? [];
const scripts = (wf) => allSteps(wf).flatMap((s) => [s.run, s.with?.script]).filter((x) => typeof x === 'string');
const mentions = (s, needle) => JSON.stringify(s).includes(needle);
const expr = (v) => String(v ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\s+/g, '');
const runsEvenAfterFailure = (s) => /always\(\)|!cancelled\(\)/.test(expr(s.if));
const claudeStep = (wf) => {
  const step = steps(wf).find((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'));
  assert.ok(step, 'ai-review job에 anthropics/claude-code-action 스텝이 있어야 한다');
  return step;
};
const gateStep = (wf) => {
  const step = steps(wf).find((s) => s.id === 'gate');
  assert.ok(step, 'id가 gate인 스텝이 있어야 한다');
  return step;
};
const claudeArgs = (wf) => String(claudeStep(wf).with?.claude_args ?? '');
const toolList = (args, flag) => {
  const m = args.match(new RegExp(`${flag}[ =]+("([^"]*)"|'([^']*)'|(\\S+))`));
  return m ? (m[2] ?? m[3] ?? m[4]).split(/[\s,]+/).filter(Boolean) : null;
};
const indexOf = (wf, step) => steps(wf).indexOf(step);

// ── 트리거·이름 ──

test('CIR-28 ai-review.yml이 있고 job 이름이 ai-review', () => {
  const { wf } = load();
  const job = reviewJob(wf);
  assert.ok(job, 'jobs.ai-review가 있어야 한다');
  assert.ok(job.name === undefined || job.name === 'ai-review', `job name은 ai-review여야 한다: ${job.name}`);
});

test('CIR-01~04·Q13 트리거는 pull_request 하나, 네 가지 타입, 브랜치·경로 필터 없음(CIR-08)', () => {
  const { wf } = load();
  assert.deepEqual(Object.keys(wf.on ?? {}), ['pull_request']);
  assert.deepEqual(Object.keys(wf.on.pull_request ?? {}), ['types']);
  assert.deepEqual([...wf.on.pull_request.types].sort(), ['opened', 'ready_for_review', 'reopened', 'synchronize']);
});

test('CIR-16 pull_request_target·issue_comment 트리거 금지', () => {
  const { wf } = load();
  const keys = Object.keys(wf.on ?? {});
  assert.ok(!keys.includes('pull_request_target'), 'pull_request_target 금지');
  assert.ok(!keys.includes('issue_comment'), 'issue_comment 금지');
});

// 주석은 파싱 결과에 없으므로 주석의 "draft"는 걸리지 않는다. 프롬프트 글에도 draft를 쓰지 않는다.
test('CIR-07·Q3 초안(draft) PR을 건너뛰는 조건이 없다', () => {
  const { wf } = load();
  assert.doesNotMatch(JSON.stringify(wf), /draft/i);
});

// ── 권한·공급망·자격 증명 ──

test('CIR-19 최상위·job 권한은 허용 범위 안이고 필요한 권한은 있다(checks:write 없음)', () => {
  const { wf } = load();
  assert.ok(wf.permissions !== undefined, '최상위 permissions가 있어야 한다');
  const allowed = { contents: ['read', 'none'], 'pull-requests': ['write', 'read', 'none'], issues: ['write', 'read', 'none'], 'id-token': ['write', 'none'] };
  for (const block of [wf.permissions, ...jobs(wf).map((j) => j.permissions)].filter((b) => b !== undefined)) {
    assert.equal(typeof block, 'object', `permissions는 키별로 적어야 한다(write-all/read-all 금지): ${block}`);
    for (const [k, v] of Object.entries(block)) {
      assert.ok(allowed[k]?.includes(v), `허용되지 않은 권한: ${k}: ${v}`);
    }
  }
  const effective = reviewJob(wf)?.permissions ?? wf.permissions;
  assert.equal(effective.contents, 'read');
  assert.equal(effective['pull-requests'], 'write');
});

test('CIR-20 모든 uses는 40자리 SHA로 고정', () => {
  const { wf } = load();
  const refs = [...jobs(wf).map((j) => j.uses), ...allSteps(wf).map((s) => s.uses)].filter(Boolean);
  assert.ok(refs.length > 0, 'uses가 하나 이상 있어야 한다');
  for (const ref of refs) assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `SHA 고정이 아님: ${ref}`);
});

test('CIR-21 checkout은 persist-credentials: false', () => {
  const { wf } = load();
  const checkouts = allSteps(wf).filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.ok(checkouts.length > 0, 'checkout 스텝이 있어야 한다');
  for (const s of checkouts) assert.equal(s.with?.['persist-credentials'], false);
});

// F5: gate·verdict 스크립트는 PR 쪽 코드라 "PR 코드 실행 없음"은 엄밀히 성립하지 않는다(CIR-40으로 보완).
// 여기서는 빌드 도구·패키지 설치로 PR의 임의 코드가 도는 것만 막는다.
test('CIR-21 PR 코드를 빌드·설치하지 않는다', () => {
  const { wf } = load();
  for (const s of scripts(wf)) {
    assert.doesNotMatch(s, /gradlew|\bgradle\b|\bmvn\b|\bnpm (ci|install|i)\b|\byarn\b|\bpnpm\b|\bmake\b|pip install/, s);
  }
});

test('CIR-12·CIR-35 concurrency는 PR 번호별 그룹이고 진행 중 실행을 취소', () => {
  const { wf } = load();
  const c = reviewJob(wf)?.concurrency ?? wf.concurrency;
  assert.equal(typeof c, 'object', 'concurrency에 group과 cancel-in-progress가 있어야 한다');
  assert.match(String(c.group), /github\.event\.pull_request\.number/);
  assert.doesNotMatch(String(c.group), /github\.(run_id|sha|run_number)/);
  assert.equal(c['cancel-in-progress'], true);
});

// ── 주입·시크릿 ──

test('CIR-17 PR 제목·본문·브랜치명·커밋 메시지·Claude 출력을 run/script에 직접 넣지 않는다', () => {
  const { wf } = load();
  const claude = claudeStep(wf);
  assert.ok(claude.id, 'Claude 스텝에 id가 있어야 한다');
  const tainted = new RegExp(
    `\\$\\{\\{[^}]*(pull_request\\.(title|body|head\\.ref|head\\.label)|github\\.head_ref|event\\.commits|head_commit|steps\\.${claude.id}\\.outputs\\.)`,
  );
  for (const s of scripts(wf)) assert.doesNotMatch(s, tainted, s);
});

test('CIR-18 시크릿을 run/script에 넣지 않고 xtrace·전체 출력을 켜지 않는다', () => {
  const { wf } = load();
  for (const s of scripts(wf)) {
    assert.doesNotMatch(s, /secrets\./, s);
    assert.doesNotMatch(s, /set -[a-wyz]*x|set -o xtrace/, s);
  }
  const full = claudeStep(wf).with?.show_full_output;
  assert.ok(full !== true && full !== 'true', `show_full_output을 켜면 안 된다: ${full}`);
});

// 참조 횟수는 원문 기준으로 센다 — 주석에도 시크릿 이름(secrets.<이름>)을 쓰지 않는다.
test('CIR-18 구독 토큰은 claude_code_oauth_token 한 곳에서만 쓰고 API 키는 쓰지 않는다', () => {
  const { raw, wf } = load();
  const w = claudeStep(wf).with ?? {};
  assert.equal(w.claude_code_oauth_token, '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
  assert.equal(w.anthropic_api_key, undefined);
  assert.equal(raw.split('secrets.CLAUDE_CODE_OAUTH_TOKEN').length - 1, 1, '토큰 참조는 한 번만');
});

// ── gate ──

test('CIR-39·F1·G4 gate 입력(작성자·커밋한 사람·head/base 레포·diff 숫자)은 env로 넘기고 run에 직접 넣지 않는다', () => {
  const { wf } = load();
  const gate = gateStep(wf);
  assert.ok(mentions(gate, 'gate.mjs'), 'gate 스텝은 gate.mjs를 불러야 한다');
  const env = Object.values(gate.env ?? {}).map(expr);
  const need = ['user.login', 'head.repo.full_name', 'changed_files', 'additions', 'deletions'].map((k) => `github.event.pull_request.${k}`);
  for (const need1 of [...need, 'github.actor']) {
    assert.ok(env.includes(need1), `gate env에 ${need1}가 있어야 한다`);
  }
  assert.ok(env.includes('github.event.pull_request.base.repo.full_name') || env.includes('github.repository'), 'gate env에 base 레포가 있어야 한다');
  assert.doesNotMatch(String(gate.run ?? gate.with?.script ?? ''), /\$\{\{/, 'gate run에는 ${{ }}를 쓰지 않는다');
});

test('G4 gate 스텝은 PR 파일 목록 API를 부르지 않는다', () => {
  const { wf } = load();
  assert.doesNotMatch(JSON.stringify(gateStep(wf)), /pulls\/[^"]*\/files|listFiles|gh pr (diff|view)|gh api|curl/);
});

test('CIR-39·CIR-22 Claude 스텝은 gate 뒤에 있고 조건은 정확히 gate 결과', () => {
  const { wf } = load();
  const claude = claudeStep(wf);
  assert.ok(indexOf(wf, gateStep(wf)) < indexOf(wf, claude), 'gate 스텝이 Claude 스텝보다 앞서야 한다');
  assert.equal(expr(claude.if), "steps.gate.outputs.run=='true'");
});

test('CIR-39·CIR-15·CIR-09 gate가 거르면 Claude를 건너뛰는 것에 그치지 않고 체크를 실패시킨다', () => {
  const { wf } = load();
  const fail = steps(wf).find((s) => expr(s.if).includes("steps.gate.outputs.run!='true'"));
  assert.ok(fail, "if에 steps.gate.outputs.run != 'true'인 스텝이 있어야 한다");
  assert.ok(indexOf(wf, gateStep(wf)) < indexOf(wf, fail), 'gate 뒤에 있어야 한다');
  assert.match(String(fail.run ?? ''), /exit 1/);
});

test('F3 ai-review 테스트를 Claude보다 먼저 실행한다', () => {
  const { wf } = load();
  const t = steps(wf).find((s) => /node --test ["']\.github\/ai-review\/\*\.test\.mjs["']/.test(String(s.run ?? '')));
  assert.ok(t, 'node --test ".github/ai-review/*.test.mjs" 스텝이 있어야 한다');
  assert.ok(indexOf(wf, t) < indexOf(wf, claudeStep(wf)), '테스트 스텝이 Claude 스텝보다 앞서야 한다');
});

test('기타·F3 SHA 고정 setup-node(Node 22 이상, cache 없음)가 테스트·gate 스텝보다 먼저', () => {
  const { wf } = load();
  const node = steps(wf).find((s) => String(s.uses ?? '').startsWith('actions/setup-node@'));
  assert.ok(node, 'actions/setup-node 스텝이 있어야 한다');
  assert.match(node.uses, /@[0-9a-f]{40}$/);
  const major = Number(String(node.with?.['node-version'] ?? '').match(/^(\d+)/)?.[1]);
  assert.ok(major >= 22, `node-version 주 버전은 22 이상: ${node.with?.['node-version']}`);
  assert.equal(node.with?.cache, undefined, 'cache 옵션 금지');
  const t = steps(wf).findIndex((s) => /node --test/.test(String(s.run ?? '')));
  assert.ok(t >= 0, 'node --test 스텝이 있어야 한다');
  assert.ok(indexOf(wf, node) < t, 'setup-node가 테스트 스텝보다 앞서야 한다');
  assert.ok(indexOf(wf, node) < indexOf(wf, gateStep(wf)), 'setup-node가 gate 스텝보다 앞서야 한다');
});

// ── Claude 실행 설정 ──

test('CIR-17·기타 --allowedTools는 verdict.mjs의 ALLOWED_TOOLS와 같은 집합이고 쓰기·실행 도구가 없다', () => {
  const { wf } = load();
  const args = claudeArgs(wf);
  const allowed = toolList(args, '--allowedTools');
  assert.ok(allowed, `claude_args에 --allowedTools가 있어야 한다: ${args}`);
  assert.ok(ALLOWED_TOOLS.includes('mcp__github_inline_comment__create_inline_comment'), 'ALLOWED_TOOLS 기준값이 비어 있거나 불완전하다');
  assert.deepEqual([...new Set(allowed)].sort(), [...ALLOWED_TOOLS].sort());
  for (const t of allowed) {
    assert.doesNotMatch(t, /commit|push|merge|create_or_update|delete|approve|Bash|Edit|Write|Task/i, `금지 도구: ${t}`);
  }
});

// I1: 토큰이 든 .git/config 읽기 금지 · I2: 하위 작업 도구의 새 이름 Agent
test('G2·G7·I1·I2 --disallowedTools에 쓰기·실행·웹·TodoWrite·Task·Agent 도구와 .git/config 읽기 금지가 모두 있다', () => {
  const { wf } = load();
  const denied = toolList(claudeArgs(wf), '--disallowedTools') ?? [];
  for (const t of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'Read(./.git/config)']) {
    assert.ok(denied.includes(t), `--disallowedTools에 ${t}가 있어야 한다`);
  }
});

test('G2 도구 플래그는 --allowedTools 한 번, 다른 표기·권한 우회 플래그·모드 금지', () => {
  const { wf } = load();
  const args = claudeArgs(wf);
  assert.equal(args.match(/--allowedTools\b/g)?.length ?? 0, 1, '--allowedTools는 정확히 한 번');
  assert.doesNotMatch(args, /--(allowed|disallowed)[-_]tools/i, '--allowed-tools 같은 다른 표기 금지');
  assert.doesNotMatch(args, /dangerously|skip-permissions|bypassPermissions/i, '권한 우회 금지');
  for (const m of args.matchAll(/--permission-mode[ =]+["']?([\w-]+)/g)) assert.equal(m[1], 'default', `권한 모드 완화 금지: ${m[1]}`);
  assert.doesNotMatch(String(claudeStep(wf).with?.settings ?? ''), /permissions|bypass/i, 'settings로 권한을 바꾸지 않는다');
});

test('CIR-14 --max-turns, job timeout, 그보다 작은 Claude 스텝 timeout이 있다', () => {
  const { wf } = load();
  assert.match(claudeArgs(wf), /--max-turns[ =]+\d+/);
  const job = reviewJob(wf)?.['timeout-minutes'];
  const step = claudeStep(wf)['timeout-minutes'];
  assert.ok(Number.isInteger(job) && job > 0, `job timeout-minutes는 양의 정수여야 한다: ${job}`);
  assert.ok(Number.isInteger(step) && step > 0 && step < job, `Claude 스텝 timeout-minutes(${step})는 job(${job})보다 작아야 한다`);
});

test('CIR-17·CIR-26 실행마다 무작위 nonce를 만들어 프롬프트와 판정 파서에 넘긴다', () => {
  const { wf } = load();
  const nonce = steps(wf).find((s) => /openssl rand|randomUUID|randomBytes|\/dev\/urandom|uuidgen/.test(`${s.run ?? ''}${s.with?.script ?? ''}`));
  assert.ok(nonce?.id, '무작위 값을 만드는 스텝(id 포함)이 있어야 한다');
  const ref = new RegExp(`steps\\.${nonce.id}\\.outputs\\.`);
  const prompt = String(claudeStep(wf).with?.prompt ?? '');
  const tag = (name) => `${name}\\[\\$\\{\\{\\s*steps\\.${nonce.id}\\.outputs\\.\\w+\\s*\\}\\}\\]: `;
  // G1·G5: 판정·건수 줄의 정확한 모양을 프롬프트가 그대로 보여 준다.
  assert.match(prompt, new RegExp(`^\\s*${tag('P1')}`, 'm'), '프롬프트에 줄 맨 앞 P1[<nonce>]: 형식이 있어야 한다');
  assert.match(prompt, new RegExp(`^\\s*${tag('P2')}`, 'm'), '프롬프트에 줄 맨 앞 P2[<nonce>]: 형식이 있어야 한다');
  assert.match(prompt, new RegExp(`${tag('VERDICT')}PASS\\b`), '프롬프트에 VERDICT[<nonce>]: PASS가 있어야 한다');
  assert.match(prompt, new RegExp(`${tag('VERDICT')}BLOCK\\b`), '프롬프트에 VERDICT[<nonce>]: BLOCK이 있어야 한다');
  const parser = steps(wf).find((s) => mentions(s, 'verdict.mjs'));
  assert.ok(parser, 'verdict.mjs를 부르는 스텝이 있어야 한다');
  assert.match(JSON.stringify(parser), ref, '판정 파서에 같은 nonce가 넘어가야 한다');
});

// ── 리뷰 입력(G5): 플러그인 없이 diff 파일 + 프롬프트 ──

test('G5 code-review 플러그인·플러그인 마켓플레이스를 쓰지 않는다', () => {
  const { wf } = load();
  const w = claudeStep(wf).with ?? {};
  assert.equal(w.plugins, undefined, 'plugins 입력 금지');
  assert.equal(w.plugin_marketplaces, undefined, 'plugin_marketplaces 입력 금지');
  assert.doesNotMatch(JSON.stringify(claudeStep(wf)), /code-review|plugin/i);
});

test('G5 checkout은 base 이력까지 가져온다(fetch-depth: 0, 자격 증명은 남기지 않음)', () => {
  const { wf } = load();
  const checkout = steps(wf).find((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.ok(checkout, 'ai-review job에 checkout 스텝이 있어야 한다');
  assert.equal(checkout.with?.['fetch-depth'], 0);
  assert.equal(checkout.with?.['persist-credentials'], false);
});

// diff 파일 경로는 프롬프트에 그대로 적어야 하므로 `$`가 없는 고정 상대 경로로 쓴다.
const DIFF_REDIRECT = /git diff\b[^\n]*\.\.\.[^\n]*>\s*["']?([^\s"'$]+)["']?/;

test('G5 Claude보다 먼저 base...head 변경분을 고정 경로 파일로 만든다', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => DIFF_REDIRECT.test(String(x.run ?? '')));
  assert.ok(s, 'run에서 git diff <base>...<head> > <파일> 하는 스텝이 있어야 한다');
  assert.ok(mentions(s, 'github.event.pull_request.base.sha'), 'base SHA를 써야 한다');
  assert.ok(mentions(s, 'github.event.pull_request.head.sha'), 'head SHA를 써야 한다');
  assert.ok(indexOf(wf, s) < indexOf(wf, claudeStep(wf)), 'diff 스텝이 Claude 스텝보다 앞서야 한다');
});

test('G5 프롬프트가 diff 파일 경로를 가리킨다', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => DIFF_REDIRECT.test(String(x.run ?? '')));
  assert.ok(s, 'diff 파일을 만드는 스텝이 있어야 한다');
  const path = String(s.run).match(DIFF_REDIRECT)[1];
  assert.ok(String(claudeStep(wf).with?.prompt ?? '').includes(path), `프롬프트에 ${path}가 있어야 한다`);
});

// P1·P2 정의 문장 자체는 기존 AI 위임 리뷰(Q5)와 같아야 하며 사람이 리뷰한다. 여기서는 정의 줄이 있는지만 본다.
test('G5 프롬프트에 P1·P2 정의와 네 가지 리뷰 관점이 있다', () => {
  const { wf } = load();
  const prompt = String(claudeStep(wf).with?.prompt ?? '');
  assert.match(prompt, /^\s*[-*]?\s*P1\s*[:：]/m, '줄 맨 앞 "P1:" 정의 줄이 있어야 한다');
  assert.match(prompt, /^\s*[-*]?\s*P2\s*[:：]/m, '줄 맨 앞 "P2:" 정의 줄이 있어야 한다');
  for (const angle of ['줄 단위 조건 점검', '제거된 동작', '호출하는 쪽 영향', '팀 규칙 위반']) {
    assert.ok(prompt.includes(angle), `리뷰 관점 "${angle}"이 있어야 한다`);
  }
});

// ── 판정·요약·체크 결론 ──

test('CIR-26·CIR-14 판정·요약 스텝은 앞 스텝이 실패해도 돈다(always() 또는 !cancelled())', () => {
  const { wf } = load();
  for (const file of ['verdict.mjs', 'summary.mjs']) {
    const s = steps(wf).find((x) => mentions(x, file));
    assert.ok(s, `${file}를 부르는 스텝이 있어야 한다`);
    assert.ok(runsEvenAfterFailure(s), `${file} 스텝 if에 always() 또는 !cancelled()가 있어야 한다: ${s.if}`);
  }
});

test('CIR-13 요약의 기준 SHA는 PR head SHA(github.sha 아님)', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => mentions(x, 'summary.mjs'));
  assert.ok(s, 'summary.mjs를 부르는 스텝이 있어야 한다');
  assert.ok(mentions(s, 'github.event.pull_request.head.sha'), '요약 스텝에 github.event.pull_request.head.sha가 있어야 한다');
  assert.ok(!/github\.sha\b/.test(JSON.stringify(s)), 'github.sha는 merge 커밋 SHA라 쓰지 않는다');
});

test('기타·F2·Q4 결론은 verdict.mjs conclude의 종료 코드로 내고 셸 문자열 비교를 쓰지 않는다', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => /node \.github\/ai-review\/verdict\.mjs conclude\b/.test(String(x.run ?? '')));
  assert.ok(s, 'run에서 node .github/ai-review/verdict.mjs conclude를 부르는 스텝이 있어야 한다');
  assert.ok(runsEvenAfterFailure(s), `결론 스텝 if에 always() 또는 !cancelled()가 있어야 한다: ${s.if}`);
  assert.ok(indexOf(wf, claudeStep(wf)) < indexOf(wf, s), '결론 스텝은 Claude 스텝 뒤에 있어야 한다');
  assert.equal(s['continue-on-error'], undefined, '결론 스텝 실패를 무시하면 안 된다');
  for (const r of scripts(wf)) assert.doesNotMatch(r, /(=|==|!=)\s*["']?success\b/, `셸 문자열 비교 금지: ${r}`);
});

test('G4 요약은 gate 이유(steps.gate.outputs.reason)를 받는다', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => mentions(x, 'summary.mjs'));
  assert.ok(s, 'summary.mjs를 부르는 스텝이 있어야 한다');
  assert.ok(mentions(s, 'steps.gate.outputs.reason'), '요약 스텝에 steps.gate.outputs.reason이 있어야 한다');
});

test('CIR-27 판정을 $GITHUB_STEP_SUMMARY에 남긴다(댓글 실패와 별개)', () => {
  const { wf } = load();
  const s = steps(wf).find((x) => /GITHUB_STEP_SUMMARY/.test(String(x.run ?? '')));
  assert.ok(s, 'run에서 $GITHUB_STEP_SUMMARY에 쓰는 스텝이 있어야 한다');
  assert.ok(runsEvenAfterFailure(s), `if에 always() 또는 !cancelled()가 있어야 한다: ${s.if}`);
});

// C-K·FIR-03(프론트 전용): 프롬프트에 프론트 리뷰 관점 5가 있다.
test('C-K 프롬프트에 프론트 리뷰 관점(XSS·토큰 저장·VITE_ 환경 변수·가드·API 오류·공급망·접근성)이 있다', () => {
  const { wf } = load();
  const prompt = String(claudeStep(wf).with?.prompt ?? '');
  for (const word of ['dangerouslySetInnerHTML', 'localStorage', 'VITE_', '라우트 가드', 'API 오류', '의존성', '접근성']) {
    assert.ok(prompt.includes(word), `프론트 리뷰 관점 "${word}"가 있어야 한다`);
  }
});

// O2: 프론트 #10에서 diff 파일의 줄 번호로 댓글을 단 뒤 같은 지적을 다시 단 중복을 막는다.
test('O2 프롬프트가 inline 댓글에 실제 파일 줄 번호를 쓰고 같은 지적을 두 번 달지 말라고 한다', () => {
  const { wf } = load();
  const prompt = String(claudeStep(wf).with?.prompt ?? '');
  assert.ok(prompt.includes('실제 파일의 줄 번호'), '줄 번호 기준 문구가 있어야 한다');
  assert.ok(prompt.includes('ai-review-pr.diff 파일의 줄 번호를 쓰지 않는다'), 'diff 파일 줄 번호 금지 문구가 있어야 한다');
  assert.ok(prompt.includes('같은 지적은 한 번만'), '중복 금지 문구가 있어야 한다');
});
