import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { analyzeLocal, githubApp, localizeFindings, tokenGrant } from './clients.mjs'

test('a repository client restricts installation tokens and checks write access on the destination repository', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const repo = { id: 19, permissions: { push: true } }
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'app-token', expires_at: '2100-01-01T00:00:00Z' })
    if (url.endsWith('/user')) return Response.json({ id: 7, type: 'User' })
    if (url.endsWith('/safeDeal-Backend')) return Response.json(repo)
    return Response.json({})
  })
  const gh = githubApp({ appId: 1, installationId: 8, privateKey, repoId: 19, repository: 'safeDeal-Backend' })
  await gh.pr(2)
  assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body), {
    repository_ids: [19], permissions: { contents: 'read', pull_requests: 'read' },
  })
  assert.match(fetch.mock.calls[1].arguments[0], /safeDeal-Backend\/pulls\/2$/)
  assert.equal((await gh.identity('user-token')).id, 7)
  repo.permissions.push = false
  await assert.rejects(gh.identity('user-token'), /write access/)
  await gh.submit('user-token', 2, {})
  assert.match(fetch.mock.calls.at(-1).arguments[0], /safeDeal-Backend\/pulls\/2\/reviews$/)
})

test('Ollama receives patches only through its loopback API and truncated output fails closed', async t => {
  const response = { done: true, done_reason: 'stop', message: { content: '{"coverage":"all_supplied_patches_reviewed","findings":[]}' } }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(response))
  const patch = '@@ -4,1 +4,1 @@\n-old()\n+unsafe()'
  const files = [{ filename: 'src/fixture.ts', patch, unrelated: 'not sent' }]
  assert.deepEqual(await analyzeLocal('test-model', files), { complete: true, findings: [] })
  const [url, request] = fetch.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:11434/api/chat')
  const body = JSON.parse(request.body)
  assert.equal(body.stream, false)
  assert.equal(body.tools, undefined)
  assert.ok(body.format.properties.findings.items.required.includes('suggestion'))
  assert.deepEqual(JSON.parse(body.messages[1].content), [
    { filename: files[0].filename, patch: '@@ -4,1 +4,1 @@\nLEFT 4: -old()\nRIGHT 4: +unsafe()' },
  ])
  assert.match(body.messages[0].content, /another account’s private records .* always P1/)
  await analyzeLocal('test-model', files, true)
  assert.match(JSON.parse(fetch.mock.calls[1].arguments[1].body).messages[0].content, /previous result was invalid or incomplete/)
  response.message.content = '{"coverage":"unable_to_review_all_patches","findings":[]}'
  assert.deepEqual(await analyzeLocal('test-model', files), { complete: false, findings: [] })
  response.message.content = '{"findings":[]}'
  await assert.rejects(analyzeLocal('test-model', files), /coverage/)
  response.done_reason = 'length'
  await assert.rejects(analyzeLocal('test-model', files), /incomplete/)
})

test('only renewable, expiring GitHub App user tokens can be stored', () => {
  assert.throws(() => tokenGrant({ access_token: 'ghu_no_expiry' }))
  assert.throws(() => tokenGrant({ access_token: 'ghp_pat', refresh_token: 'ghr_fake', expires_in: 28800 }))
  const grant = tokenGrant({ access_token: 'ghu_test', refresh_token: 'ghr_test', expires_in: 28800 })
  assert.equal(grant.token, 'ghu_test')
  assert.equal(grant.refresh, 'ghr_test')
  assert.ok(grant.expires > Date.now())
})

test('English finding prose is translated without sending or replacing its code evidence and severity', async t => {
  const original = {
    severity: 'P1', path: 'src/review-pilot.ts', side: 'RIGHT', line: 9,
    evidence: 'order.ownerId !== viewerId',
    title: 'Inverted owner check', detail: 'The filter exposes another buyer’s orders.',
    suggestion: 'Keep only orders with a matching owner ID.',
  }
  const korean = { ...original, title: '기존 한글 제목', detail: '이미 한국어인 설명입니다.', suggestion: '소유자가 같은 주문만 조회합니다.' }
  const title = '주문 소유자 비교 조건 반전'
  const detail = '다른 구매자의 주문이 노출됩니다.'
  const suggestion = '조회 계정과 소유자가 일치하는 주문만 남기세요.'
  const result = { translations: [{ id: 1, title, detail, suggestion, severity: 'P2', line: 10 }] }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    done: true, done_reason: 'stop', message: { content: JSON.stringify(result) },
  }))
  assert.deepEqual(await localizeFindings('test-model', [korean, original]), [korean, { ...original, title, detail, suggestion }])
  const request = JSON.parse(fetch.mock.calls[0].arguments[1].body)
  assert.deepEqual(JSON.parse(request.messages[1].content), [
    { id: 1, title: original.title, detail: original.detail, suggestion: original.suggestion },
  ])
  result.translations[0].title = 'Still English'
  assert.deepEqual(await localizeFindings('test-model', [korean, original]), [korean, original])
  await localizeFindings('test-model', [korean])
  assert.equal(fetch.mock.calls.length, 2)
})
