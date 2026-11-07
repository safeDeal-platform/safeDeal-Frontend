import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { openState } from './state.mjs'
import { eventFor, webhookServer } from './webhook.mjs'
import { signWebhook } from './review.mjs'

const config = { repoId: 15, installationId: 8, webhookSecret: 'test-only-secret' }
const payload = {
  action: 'review_requested', number: 2, repository: { id: 15 }, installation: { id: 8 },
  pull_request: { base: { ref: 'dev', repo: { id: 15 } }, head: { repo: { id: 15 } }, user: { id: 1 } },
  requested_reviewer: { type: 'User', id: 7 },
}

test('webhook only tracks individual, same-repository dev assignments', () => {
  assert.deepEqual(eventFor('pull_request', payload, config), { kind: 'assign', number: 2, reviewer: 7 })
  assert.equal(eventFor('pull_request', { ...payload, installation: { id: 1 } }, config), null)
  assert.equal(eventFor('pull_request', { ...payload, requested_reviewer: null }, config), null)
  const wrong = structuredClone(payload)
  wrong.pull_request.base.ref = 'main'
  assert.equal(eventFor('pull_request', wrong, config), null)
  wrong.pull_request.base.ref = 'dev'
  wrong.pull_request.head.repo.id = 10
  assert.equal(eventFor('pull_request', wrong, config), null)
  assert.deepEqual(eventFor('github_app_authorization', { action: 'revoked', sender: { id: 7 } }, config),
    { kind: 'revoke', reviewer: 7 })
})

test('queue deduplicates signed deliveries and survives review/update/removal sequencing', () => {
  const db = openState(':memory:', Buffer.alloc(32, 1))
  try {
    const assign = { kind: 'assign', number: 2, reviewer: 7 }
    db.receive('0', assign, 1)
    assert.equal(db.next(1), undefined)
    db.enroll(7, { token: 'user-token', refresh: 'refresh-token' })
    assert.equal(db.getGrant(7).token, 'user-token')
    assert.doesNotMatch(db.getGrant(7).version, /user-token|refresh-token/)
    assert.equal(db.receive('1', assign, 1), true)
    assert.equal(db.receive('1', assign, 1), false)
    const old = db.next(1)
    db.finish(old)
    assert.equal(db.next(1), undefined)
    db.receive('2', { kind: 'update', number: 2 }, 2)
    const next = db.next(2)
    assert.equal(next.reviewer, 7)
    assert.equal(db.active(old), false)
    db.receive('3', { ...assign, kind: 'remove' }, 2)
    db.receive('4', assign, 2)
    assert.equal(db.active(next), false)
    db.receive('5', { kind: 'revoke', reviewer: 7 }, 2)
    assert.equal(db.next(2), undefined)
    assert.equal(db.getGrant(7), null)
  } finally {
    db.close()
  }
})

test('HTTP webhook persists only verified deliveries', async () => {
  const seen = []
  const server = webhookServer(config, (...values) => seen.push(values))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const body = JSON.stringify(payload)
    const request = signature => fetch('http://127.0.0.1:' + server.address().port + '/webhook', {
      method: 'POST', body, headers: {
        'x-github-event': 'pull_request', 'x-hub-signature-256': signature,
        'x-github-delivery': '83ec679d-3b05-42be-b84a-1b1c3a63c1a3',
      },
    })
    assert.equal((await request('sha256=incorrect')).status, 401)
    assert.equal((await request(signWebhook(config.webhookSecret, body))).status, 202)
    assert.deepEqual(seen, [[
      '83ec679d-3b05-42be-b84a-1b1c3a63c1a3', { kind: 'assign', number: 2, reviewer: 7 },
    ]])
  } finally {
    server.close()
    await once(server, 'close')
  }
})
