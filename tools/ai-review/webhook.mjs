import { createServer } from 'node:http'
import { verifyWebhook } from './review.mjs'
import { allowedTarget, ORGANIZATION, validRepository } from './scope.mjs'

const MAX_BODY = 1024 * 1024
const numericId = n => Number.isSafeInteger(n) && n > 0

export function eventFor(type, payload, config) {
  if (type === 'github_app_authorization' && payload.action === 'revoked' && numericId(payload.sender?.id)) {
    return { kind: 'revoke', reviewer: payload.sender.id }
  }
  if (type !== 'pull_request' || payload.installation?.id !== config.installationId || !numericId(payload.number)) return null
  const { id: repoId, name: repository, owner } = payload.repository ?? {}
  if (!numericId(repoId) || !validRepository(repository) || String(owner?.login ?? '').toLowerCase() !== ORGANIZATION.toLowerCase()
    || (!config.organizationScope && repoId !== config.repoId)) return null
  const pr = payload.pull_request
  const { action, number } = payload
  const scope = { repoId, repository, number }
  if (pr?.base?.repo?.id !== repoId) return null
  if (action === 'closed' || (action === 'edited' && payload.changes?.base?.ref)) return { kind: 'close', ...scope }
  if (!allowedTarget(pr.base.ref, payload.repository.default_branch, repoId === config.repoId)
    || pr.head?.repo?.id !== repoId) return null
  if (action === 'synchronize' || action === 'ready_for_review') return { kind: 'update', ...scope }
  const reviewer = payload.requested_reviewer
  if (reviewer?.type !== 'User' || !numericId(reviewer.id) || pr.user?.id === reviewer.id) return null
  if (action === 'review_requested') return { kind: 'assign', ...scope, reviewer: reviewer.id }
  if (action === 'review_request_removed') return { kind: 'remove', ...scope, reviewer: reviewer.id }
  return null
}

export function webhookServer(config, receive) {
  return createServer({ requestTimeout: 15_000 }, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') return res.writeHead(404).end()
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_BODY) return res.writeHead(413).end()
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      if (!verifyWebhook(config.webhookSecret, body, req.headers['x-hub-signature-256'])) return res.writeHead(401).end()
      const delivery = req.headers['x-github-delivery']
      if (typeof delivery !== 'string' || !/^[0-9a-f-]{36}$/i.test(delivery)) return res.writeHead(400).end()
      let payload
      try { payload = JSON.parse(body) } catch { return res.writeHead(400).end() }
      if (!payload || typeof payload !== 'object') return res.writeHead(400).end()
      const event = eventFor(req.headers['x-github-event'], payload, config)
      if (event) receive(delivery, event)
      return res.writeHead(event ? 202 : 204).end()
    } catch {
      // GitHub can redeliver the request; never log payloads or credentials.
      return res.writeHead(503).end()
    }
  })
}
