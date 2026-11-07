import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signWebhook, verifyWebhook, classify, makeReview, reviewRoute } from './review.mjs'

const file = { filename: 'src/App.tsx', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -4,1 +4,1 @@\n-old()\n+new()' }
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const pr = { state: 'open', draft: false, changed_files: 1, user: { id: 100 },
  head: { sha: head, repo: { id: 1 } }, base: { sha: base, ref: 'dev', repo: { id: 1 } } }
const route = { number: 4, reviewer: 9, generation: 1 }
const p1 = { severity: 'P1', path: file.filename, line: 4, evidence: 'new()', title: 'Wrong handler', detail: 'Checkout no longer completes.' }
const model = (...findings) => ({ complete: true, findings })
const opts = { secret: 'test-secret', repoId: 1, autoApprove: true }

test('only the unchanged raw webhook body passes HMAC verification', () => {
  const body = Buffer.from('{"number":4}')
  const signature = signWebhook('secret', body)
  assert.equal(verifyWebhook('secret', body, signature), true)
  assert.equal(verifyWebhook('secret', Buffer.from('{}'), signature), false)
  assert.equal(verifyWebhook('secret', body, 'sha256=short'), false)
})

test('P1 blocks and P2 is advisory, with precise inline comments', () => {
  assert.equal(classify(pr, [file], model(p1)).verdict, 'BLOCK')
  const result = classify(pr, [file], model({ ...p1, severity: 'P2' }))
  const review = makeReview(pr, route, result, opts)
  assert.equal(review.event, 'APPROVE')
  assert.equal(review.commit_id, head)
  assert.match(review.body, /PASS.*AI/)
  assert.deepEqual(review.comments.map(({ path, line, side }) => ({ path, line, side })), [
    { path: 'src/App.tsx', line: 4, side: 'RIGHT' },
  ])
  assert.equal(makeReview(pr, route, result, { ...opts, autoApprove: false }).event, 'COMMENT')
})

test('invalid model data, fabricated lines and incomplete diffs cannot pass', () => {
  assert.throws(() => classify(pr, [file], { complete: false, findings: [] }))
  assert.throws(() => classify(pr, [file], { complete: false, findings: [{ ...p1, severity: 'P2' }] }))
  assert.throws(() => classify(pr, [file], { findings: [p1] }))
  assert.throws(() => classify(pr, [file], model({ ...p1, line: 5, evidence: 'new(' })))
  assert.throws(() => classify(pr, [{ ...file, additions: 2, patch: file.patch + '\n+new()' }],
    model({ ...p1, line: 8 })))
  assert.throws(() => classify(pr, [{ ...file, additions: 2 }], model()))
  assert.throws(() => classify(pr, [{ ...file, patch: undefined }], model()))
})

function harness(overrides = {}) {
  const posted = []
  let active = true
  const io = {
    pr: async () => pr,
    requested: async () => [{ id: route.reviewer }],
    reviews: async () => [],
    files: async () => [file],
    analyze: async () => model(p1),
    localize: async findings => findings,
    grant: async () => 'fake-token',
    active: () => active,
    submit: async (token, number, review) => posted.push({ token, number, ...review }),
    ...overrides,
  }
  return { io, posted, cancel: () => { active = false } }
}

test('an incomplete review is retried once and exact evidence anchors the corrected P1', async () => {
  const evidence = 'return orders.filter((order) => order.ownerId !== viewerId)'
  const changed = {
    filename: 'src/review-pilot.ts', additions: 1, deletions: 0,
    patch: '@@ -8,0 +9,1 @@\n+  ' + evidence,
  }
  const finding = { ...p1, path: changed.filename, line: 8, evidence }
  const attempts = []
  const { io, posted } = harness({
    files: async () => [changed],
    analyze: async (_files, retry = false) => {
      attempts.push(retry)
      return retry ? model(finding) : { complete: false, findings: [{ ...finding, severity: 'P2' }] }
    },
  })
  await reviewRoute(io, route, opts)
  assert.deepEqual(attempts, [false, true])
  assert.equal(posted[0].event, 'REQUEST_CHANGES')
  assert.equal(posted[0].comments[0].line, 9)
})

test('a P1 verified against the patch blocks even when model coverage is incomplete', async () => {
  const evidence = 'return orders.filter((order) => order.ownerId !== viewerId)'
  const changed = { filename: 'src/review-pilot.ts', additions: 1, deletions: 0, patch: '@@ -8,0 +9,1 @@\n+  ' + evidence }
  const finding = {
    severity: 'P1', path: changed.filename, side: 'RIGHT', line: 9, evidence,
    title: "Inverted owner check that selects other users' records",
    detail: "The function shows other users' orders instead of the signed-in buyer's orders.",
  }
  const { io, posted } = harness({
    files: async () => [changed],
    analyze: async () => ({ complete: false, findings: [finding] }),
  })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'REQUEST_CHANGES')
  assert.match(posted[0].body, /검토가 일부만 완료/)
  assert.equal(posted[0].comments[0].line, 9)
  assert.throws(() => classify(pr, [changed], { complete: false, findings: [{ ...finding, evidence: 'fabricated()' }] }))
})

test('assignment blocks on P1; a new commit can be approved after the request disappears', async () => {
  const { io, posted } = harness()
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'REQUEST_CHANGES')
  io.requested = async () => []
  io.reviews = async () => [{ ...posted[0], user: { id: route.reviewer }, state: 'CHANGES_REQUESTED' }]
  io.pr = async () => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
  io.files = async () => [{ ...file, patch: '@@ -4,1 +4,1 @@\n-old()\n+fixed()' }]
  io.analyze = async () => model()
  await reviewRoute(io, route, opts)
  assert.equal(posted[1].event, 'APPROVE')
  assert.equal(posted[1].commit_id, 'c'.repeat(40))
})

test('a prior P1 cannot be approved while its evidence still appears after a new commit', async () => {
  const { io, posted } = harness()
  await reviewRoute(io, route, opts)
  io.requested = async () => []
  io.reviews = async () => [{ ...posted[0], user: { id: route.reviewer }, state: 'CHANGES_REQUESTED' }]
  io.pr = async () => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
  io.analyze = async () => model()
  await reviewRoute(io, route, opts)
  assert.equal(posted[1].event, 'COMMENT')
  assert.match(posted[1].body, /BLOCK/)
})

test('a new head is reviewed after GitHub dismisses an older approval', async () => {
  const { io, posted } = harness({ analyze: async () => model() })
  await reviewRoute(io, route, opts)
  io.requested = async () => []
  io.reviews = async () => [{ ...posted[0], user: { id: route.reviewer }, state: 'DISMISSED' }]
  io.pr = async () => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
  await reviewRoute(io, route, opts)
  assert.equal(posted[1].event, 'APPROVE')
})

test('an explicit rerequest on the same head retries a model failure', async () => {
  const { io, posted } = harness({ analyze: async () => ({ complete: false, findings: [] }) })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'COMMENT')
  io.reviews = async () => [{ ...posted[0], user: { id: route.reviewer }, state: 'COMMENTED' }]
  io.analyze = async () => model()
  await reviewRoute(io, route, opts)
  assert.equal(posted[1].event, 'APPROVE')
})

test('no grant, stale head, withdrawn assignment and duplicate review never post', async () => {
  const missing = harness({ grant: async () => null })
  await reviewRoute(missing.io, route, opts)
  assert.equal(missing.posted.length, 0)
  const stale = harness()
  stale.io.analyze = async () => {
    stale.io.pr = async () => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
    return model()
  }
  await reviewRoute(stale.io, route, opts)
  assert.equal(stale.posted.length, 0)
  const withdrawn = harness()
  withdrawn.io.analyze = async () => { withdrawn.cancel(); return model() }
  await reviewRoute(withdrawn.io, route, opts)
  assert.equal(withdrawn.posted.length, 0)
  const duplicate = harness()
  await reviewRoute(duplicate.io, route, opts)
  duplicate.io.reviews = async () => [{ ...duplicate.posted[0], user: { id: route.reviewer }, state: 'CHANGES_REQUESTED' }]
  await reviewRoute(duplicate.io, route, opts)
  assert.equal(duplicate.posted.length, 1)
})

test('forks, self approval and human override are ignored', async () => {
  const scenarios = [
    { pr: async () => ({ ...pr, head: { ...pr.head, repo: { id: 8 } } }) },
    { pr: async () => ({ ...pr, user: { id: route.reviewer } }) },
    { requested: async () => [], reviews: async () => [
      { user: { id: route.reviewer }, body: 'My own decision', state: 'APPROVED' },
    ] },
  ]
  for (const overrides of scenarios) {
    const { io, posted } = harness(overrides)
    await reviewRoute(io, route, opts)
    assert.equal(posted.length, 0)
  }
})

test('changes to the review automation are held for manual review', async () => {
  const { io, posted } = harness({
    files: async () => [{ ...file, filename: 'tools/ai-review/review.mjs' }],
    analyze: async () => { throw new Error('should not invoke model') },
  })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'COMMENT')
  assert.match(posted[0].body, /BLOCK/)
})
