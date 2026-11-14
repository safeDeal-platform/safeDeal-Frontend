// CIR-40·Q15 — .github/** 변경은 재민(CheatIsKey)·경화(DGAZA-max) 두 코드 소유자 지정.
// 여기서는 CODEOWNERS 내용만 본다. 실제 강제(코드 소유자 승인 필수)는 룰셋 설정이며 수동 확인이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../CODEOWNERS', import.meta.url));
const OWNERS = ['@CheatIsKey', '@DGAZA-max'];

function rules() {
  assert.ok(existsSync(PATH), `.github/CODEOWNERS가 있어야 한다: ${PATH}`);
  return readFileSync(PATH, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [pattern, ...owners] = l.split(/\s+/); return { pattern, owners }; });
}
// 나중 줄이 이긴다. /.github/ 뒤의 줄 중 .github 아래 파일에 걸릴 수 있는 줄은 두 소유자를 모두 가져야 한다.
// 걸릴 수 있는 줄: 앵커 없는 패턴(`*`, `*.yml`, `docs/` 등 어디서나 매칭) 또는 /.github·/*·/** 로 시작하는 앵커 패턴.
// 걸리지 않는 줄: 그 밖의 앵커 패턴(예: /src/).
const mayMatchGithub = (p) => !p.startsWith('/') || /^\/(\.github|\*)/.test(p) || p === '/';

test('CIR-40 /.github/ 전체의 소유자는 CheatIsKey·DGAZA-max 두 명', () => {
  const list = rules();
  const root = list.findIndex((r) => ['/.github/', '/.github/**'].includes(r.pattern));
  assert.ok(root >= 0, 'CODEOWNERS에 /.github/ 줄이 있어야 한다');
  assert.deepEqual([...list[root].owners].sort(), [...OWNERS].sort());
});

test('CIR-40 /.github/ 줄이 마지막이거나, 뒤에서 .github에 걸릴 수 있는 줄은 모두 두 소유자를 가진다', () => {
  const list = rules();
  const root = list.findIndex((r) => ['/.github/', '/.github/**'].includes(r.pattern));
  assert.ok(root >= 0, 'CODEOWNERS에 /.github/ 줄이 있어야 한다');
  for (const r of list.slice(root + 1).filter((x) => mayMatchGithub(x.pattern))) {
    for (const o of OWNERS) assert.ok(r.owners.includes(o), `/.github/ 뒤의 ${r.pattern}이 소유자를 덮어쓴다(${o} 없음)`);
  }
});
