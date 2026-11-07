import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeLocal, tokenGrant } from './clients.mjs'

test('Ollama receives patches only through its loopback API and truncated output fails closed', async t => {
  const response = { done: true, done_reason: 'stop', message: { content: '{"complete":true,"findings":[]}' } }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(response))
  const patch = '@@ -4,1 +4,1 @@\n-old()\n+unsafe()'
  const files = [{ filename: 'src/fixture.ts', patch, unrelated: 'not sent' }]
  assert.deepEqual(await analyzeLocal('test-model', files), { complete: true, findings: [] })
  const [url, request] = fetch.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:11434/api/chat')
  const body = JSON.parse(request.body)
  assert.equal(body.stream, false)
  assert.equal(body.tools, undefined)
  assert.deepEqual(JSON.parse(body.messages[1].content), [
    { filename: files[0].filename, patch: '@@ -4,1 +4,1 @@\nLEFT 4: -old()\nRIGHT 4: +unsafe()' },
  ])
  assert.match(body.messages[0].content, /another account’s private records .* always P1/)
  await analyzeLocal('test-model', files, true)
  assert.match(JSON.parse(fetch.mock.calls[1].arguments[1].body).messages[0].content, /previous result was invalid or incomplete/)
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
