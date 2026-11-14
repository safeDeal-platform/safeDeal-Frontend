// 테스트 도구(mini-yaml) 자체 검사. 워크플로 정적 검사가 잘못 읽어 거짓 통과·거짓 실패하지 않게 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from './test-support/mini-yaml.mjs';

const fixture = readFileSync(new URL('./test-support/fixture.yml', import.meta.url), 'utf8');

test('mini-yaml: 블록 스칼라·흐름 리스트·따옴표 속 ${{ }}·줄 끝 주석을 바르게 읽는다', () => {
  assert.deepEqual(parseYaml(fixture), {
    name: 'Fixture',
    on: { pull_request: { types: ['opened', 'synchronize'] } },
    jobs: {
      'a-job': {
        'timeout-minutes': 5,
        steps: [
          {
            name: 'quoted # not comment',
            if: "${{ steps.gate.outputs.run == 'true' }}",
            env: { TOKEN: '${{ secrets.X }}' },
            run: 'echo "a: b"  # 블록 안은 그대로\nexit 1\n',
          },
          { uses: 'actions/checkout@0123456789abcdef0123456789abcdef01234567', with: { 'persist-credentials': false } },
        ],
      },
    },
  });
});

test('mini-yaml: CRLF도 같게 읽는다', () => {
  assert.deepEqual(parseYaml(fixture.replace(/\n/g, '\r\n')), parseYaml(fixture));
});
