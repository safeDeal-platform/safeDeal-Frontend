import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openState } from './state.mjs'
import { eventFor, webhookServer } from './webhook.mjs'
import { signWebhook } from './review.mjs'

const config = { repoId: 15, installationId: 8, webhookSecret: 'test-only-secret' }
const scope = { repoId: 15, repository: 'safeDeal-Frontend', number: 2 }
const payload = {
  action: 'review_requested', number: 2,
  repository: { id: 15, name: scope.repository, owner: { login: 'safeDeal-platform' } }, installation: { id: 8 },
  pull_request: { base: { ref: 'dev', repo: { id: 15 } }, head: { repo: { id: 15 } }, user: { id: 1 } },
  requested_reviewer: { type: 'User', id: 7 },
}

test('webhook only tracks individual, same-repository dev assignments', () => {
  assert.deepEqual(eventFor('pull_request', payload, config), { kind: 'assign', ...scope, reviewer: 7 })
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

test('organization scope accepts another installed repository and rejects another organization', () => {
  const backend = structuredClone(payload)
  backend.repository.id = backend.pull_request.base.repo.id = backend.pull_request.head.repo.id = 19
  backend.repository.name = 'safeDeal-Backend'
  const organization = { ...config, organizationScope: true }
  assert.equal(eventFor('pull_request', backend, config), null)
  assert.deepEqual(eventFor('pull_request', backend, organization),
    { kind: 'assign', repoId: 19, repository: 'safeDeal-Backend', number: 2, reviewer: 7 })
  backend.repository.name = 'safeDeal-Docs'
  backend.repository.default_branch = backend.pull_request.base.ref = 'main'
  assert.equal(eventFor('pull_request', backend, organization).repository, 'safeDeal-Docs')
  backend.repository.owner.login = 'other-org'
  assert.equal(eventFor('pull_request', backend, organization), null)
})

test('queue deduplicates signed deliveries and survives review/update/removal sequencing', () => {
  const db = openState(':memory:', Buffer.alloc(32, 1))
  try {
    const assign = { kind: 'assign', ...scope, reviewer: 7 }
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
    db.receive('2', { kind: 'update', ...scope }, 2)
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

test('legacy frontend routes migrate and matching backend PR numbers stay independent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'safedeal-review-'))
  const path = join(directory, 'state.db')
  const original = new DatabaseSync(path)
  original.exec('CREATE TABLE routes (number INTEGER, reviewer INTEGER, generation TEXT, due INTEGER, attempts INTEGER)')
  original.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?)').run(2, 7, 'frontend-generation', 1, 0)
  original.close()
  const db = openState(path, Buffer.alloc(32, 1), scope.repoId)
  try {
    db.enroll(7, { token: 'user-token', organization: true })
    const frontend = db.next(1)
    assert.equal(frontend.repoId, scope.repoId)
    assert.equal(frontend.repository, scope.repository)
    db.receive('backend', { kind: 'assign', repoId: 19, repository: 'safeDeal-Backend', number: 2, reviewer: 7 }, 1)
    db.receive('frontend-close', { kind: 'close', ...scope }, 1)
    assert.equal(db.active(frontend), false)
    assert.equal(db.next(1).repoId, 19)
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmdirSync(directory)
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
      '83ec679d-3b05-42be-b84a-1b1c3a63c1a3', { kind: 'assign', ...scope, reviewer: 7 },
    ]])
  } finally {
    server.close()
    await once(server, 'close')
  }
})
