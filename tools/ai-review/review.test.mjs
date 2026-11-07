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
    verifyP1: async (_files, candidates) => candidates.map(({ id, code }) => ({
      id, verdict: 'confirmed', evidence: code.trim(), reason: 'The code triggers the reported defect.',
    })),
    reviewComments: async () => [],
    localize: async findings => findings,
    grant: async () => 'fake-token',
    active: () => active,
    submit: async (token, number, review) => posted.push({ token, number, ...review }),
    ...overrides,
  }
  return { io, posted, cancel: () => { active = false } }
}

test('a refuted legacy P1 on the same head can be approved after an explicit rerequest', async () => {
  const code = 'history.filter(({ ownerId }) => accountId === ownerId)'
  const fixed = {
    filename: 'src/review-pilot.ts', additions: 1, deletions: 0, patch: '@@ -8,0 +9,1 @@\n+  ' + code,
  }
  const finding = { ...p1, path: fixed.filename, line: 9, side: 'RIGHT', evidence: code,
    title: 'All orders exposed', detail: 'Every order is returned.' }
  const legacy = makeReview(pr, route, { verdict: 'BLOCK', findings: [finding] }, opts)
  const { io, posted } = harness({
    files: async () => [fixed],
    analyze: async () => model(finding),
    reviews: async () => [{ ...legacy, id: 11, user: { id: route.reviewer }, state: 'CHANGES_REQUESTED' }],
    reviewComments: async () => legacy.comments,
    verifyP1: async (_files, candidates) => {
      assert.equal(candidates.length, 2)
      assert.match(candidates[1].detail, /Every order is returned/)
      return candidates.map(({ id }) => ({
        id, verdict: 'refuted', evidence: code,
        reason: 'A different account produces false and the filter excludes that order.',
      }))
    },
  })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'APPROVE')
  assert.equal(posted[0].commit_id, head)
  assert.deepEqual(posted[0].comments, [])
})

test('the complete pilot fixture is checked against both owners, including after a model-verified false block', async () => {
  const prelude = ['type Order = {', '  id: string', '  ownerId: string', '  deliveryAddress: string', '}', '',
    "// The account's order history must only show the signed-in buyer's orders."]
  const filename = 'src/review-pilot.ts'
  const samples = [
    { event: 'APPROVE', lines: [
      'export const visibleOrders = (history: readonly Order[], accountId: string): Order[] =>',
      '  history.filter(({ ownerId }) => accountId === ownerId)',
    ] },
    { event: 'REQUEST_CHANGES', lines: [
      'export function visibleOrders(orders: readonly Order[], viewerId: string): Order[] {',
      '  return orders.filter((order) => order.ownerId !== viewerId)',
      '}',
    ] },
    { event: 'COMMENT', lines: [
      'export const visibleOrders = (history: readonly Order[], accountId: string): Order[] =>',
      '  history.filter(({ ownerId }) => accountId === ownerId)',
      'export const unrelated = readOtherOrders()',
    ] },
  ]
  for (const { event, lines } of samples) {
    const source = [...prelude, ...lines]
    const patch = ['@@ -0,0 +1,' + source.length + ' @@', ...source.map(line => '+' + line)].join('\n')
    const pilot = { filename, status: 'added', additions: source.length, deletions: 0, patch }
    const prior = makeReview(pr, route, { verdict: 'BLOCK', p1Verified: true, findings: [{ ...p1,
      path: filename, side: 'RIGHT', line: 9, evidence: lines[1].trim(),
    }] }, opts)
    // Simulate an already-posted model result, without the new proof marker.
    const { io, posted } = harness({
      files: async () => [pilot],
      reviews: async () => [{ ...prior, id: 11, user: { id: route.reviewer }, state: 'CHANGES_REQUESTED' }],
      analyze: async () => { throw new Error('the proof should use the patch') },
    })
    await reviewRoute(io, route, opts)
    assert.equal(posted[0]?.event, event)
    assert.equal(posted[0].comments.length, event === 'REQUEST_CHANGES' ? 1 : 0)
    if (event === 'COMMENT') assert.match(posted[0].body, /팀원 검토/)
    else assert.match(posted[0].body, /계정 일치·불일치 검증/)
  }
})

test('uncertain, ungrounded or incomplete P1 checks never produce an approval', async () => {
  const checks = [
    { verdict: 'uncertain', evidence: 'new()', reason: 'The behavior is unclear.' },
    { verdict: 'refuted', evidence: 'invented()', reason: 'This line is not in the patch.' },
    { verdict: 'refuted', evidence: 'new()', reason: 'This finding was refuted.' },
  ]
  for (const [i, check] of checks.entries()) {
    const { io, posted } = harness({
      analyze: async () => ({ complete: i < 2, findings: [p1] }),
      verifyP1: async () => [{ id: 0, ...check }],
    })
    await reviewRoute(io, route, opts)
    assert.equal(posted[0].event, 'COMMENT')
    assert.match(posted[0].body, /팀원 검토/)
  }
})

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

test('100 small source files can be reviewed and 101 are held for manual review', async () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ ...file, filename: 'src/change-' + i + '.ts' }))
  const { io, posted } = harness({
    pr: async () => ({ ...pr, changed_files: files.length }),
    files: async () => files,
    analyze: async () => model(),
  })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'APPROVE')

  io.pr = async () => ({ ...pr, changed_files: 101 })
  io.files = async () => assert.fail('an oversized PR should not fetch its changes')
  await reviewRoute(io, route, opts)
  assert.equal(posted[1].event, 'COMMENT')
  assert.match(posted[1].body, /101개로 검토 상한 100개/)
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

test('a large source file is split at changed lines and mixed changes are reviewed without approval', async () => {
  const longLine = 'x'.repeat(13_000)
  const large = { ...file, additions: 3, deletions: 1,
    patch: '@@ -10,1 +10,3 @@\n-' + longLine + '\n+' + longLine + '\n+safe()\n+unsafe()' }
  const config = { ...file, filename: 'package.json' }
  const calls = []
  const { io, posted } = harness({
    pr: async () => ({ ...pr, changed_files: 2 }),
    files: async () => [large, config],
    analyze: async batch => {
      calls.push(batch)
      return batch[0].patch.includes('unsafe()')
        ? model({ ...p1, side: 'RIGHT', line: 12, evidence: 'unsafe()' })
        : model()
    },
  })
  await reviewRoute(io, route, opts)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(batch => batch.length === 1 && batch[0].filename === large.filename))
  assert.equal(posted[0].event, 'COMMENT')
  assert.deepEqual(posted[0].comments.map(comment => [comment.path, comment.side, comment.line]), [[large.filename, 'RIGHT', 12]])
  assert.match(posted[0].body, /1\/2개 파일 · 2\/2개 묶음 완료/)
  assert.match(posted[0].body, /미완료·제외 파일 1개 \(package\.json\)/)
})

test('a failed batch is reported as incomplete and does not discard findings from another batch', async () => {
  const large = { ...file, additions: 2, deletions: 0,
    patch: '@@ -0,0 +1,2 @@\n+' + 'x'.repeat(13_000) + '\n+' + 'y'.repeat(13_000) }
  const { io, posted } = harness({
    files: async () => [large],
    analyze: async ([part]) => {
      if (part.patch.includes('yyyyy')) throw new Error('model unavailable')
      return model({ ...p1, severity: 'P2', side: 'RIGHT', line: 1, evidence: 'xxxxx' })
    },
  })
  await reviewRoute(io, route, opts)
  assert.equal(posted[0].event, 'COMMENT')
  assert.equal(posted[0].comments.length, 1)
  assert.match(posted[0].body, /0\/1개 파일 · 1\/2개 묶음 완료/)
  assert.match(posted[0].body, /미완료·제외 파일 1개/)
})
