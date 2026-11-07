import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { analyzeLocal, enrollDevice, githubApp, refreshGrant } from './clients.mjs'
import { reviewRoute } from './review.mjs'
import { openState } from './state.mjs'
import { webhookServer } from './webhook.mjs'

function env(name) {
  const value = process.env[name]
  if (!value) throw new Error('Missing ' + name)
  return value
}

function id(name) {
  const value = Number(env(name))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + name)
  return value
}

async function main() {
  const [command, username] = process.argv.slice(2)
  if (!['serve', 'enroll', 'revoke'].includes(command)) throw new Error('Use serve, enroll <github-login>, or revoke <user-id>')
  const stateKey = Buffer.from(env('REVIEW_STATE_KEY'), 'base64')
  if (stateKey.length !== 32) throw new Error('REVIEW_STATE_KEY must encode 32 random bytes')
  const path = resolve(env('REVIEW_STATE_DB'))
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  process.umask(0o077)
  const state = openState(path, stateKey)
  try {
    if (command === 'revoke') {
      const reviewer = Number(username)
      if (!Number.isSafeInteger(reviewer) || reviewer < 1) throw new Error('Specify the numeric GitHub user ID')
      state.revoke(reviewer)
      console.log('Local delegation removed for GitHub user ' + reviewer)
      return
    }
    const config = {
      clientId: env('REVIEW_APP_CLIENT_ID'),
      appId: id('REVIEW_APP_ID'),
      repoId: id('REVIEW_REPO_ID'),
      installationId: id('REVIEW_INSTALLATION_ID'),
      privateKey: readFileSync(env('REVIEW_APP_PRIVATE_KEY_FILE')),
    }
    const gh = githubApp(config)
    if (command === 'enroll') {
      if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username ?? '')) throw new Error('Specify the GitHub login')
      const grant = await enrollDevice(config.clientId, code => {
        console.log('Authorize SafeDeal AI Review at https://github.com/login/device')
        console.log('Continue only if you consent to AI reviews and automatic approval on your behalf.')
        console.log('Device code: ' + code)
      })
      const user = await gh.identity(grant.token)
      if (user.login.toLowerCase() !== username.toLowerCase()) throw new Error('Authorized GitHub user did not match')
      state.enroll(user.id, grant)
      console.log('Delegation saved for @' + user.login + ' (id ' + user.id + ')')
      return
    }
    await serve(config, gh, state)
  } finally {
    state.close()
  }
}

async function serve(config, gh, state) {
  const webhookSecret = env('REVIEW_WEBHOOK_SECRET')
  if (Buffer.byteLength(webhookSecret) < 32) throw new Error('Use a random webhook secret of at least 32 bytes')
  const port = process.env.REVIEW_PORT ? id('REVIEW_PORT') : 8787
  if (port > 65535) throw new Error('Invalid REVIEW_PORT')
  const model = process.env.REVIEW_OLLAMA_MODEL || 'qwen2.5-coder:7b'
  const opts = { repoId: config.repoId, secret: webhookSecret, autoApprove: process.env.REVIEW_AUTO_APPROVE === 'true' }
  const server = webhookServer({ ...config, webhookSecret }, (delivery, event) => state.receive(delivery, event))
  const io = {
    ...gh,
    active: state.active,
    analyze: (files, retry) => analyzeLocal(model, files, retry),
    async grant(reviewer) {
      let current = state.getGrant(reviewer)
      if (!current) return null
      if (current.expires <= Date.now() + 60_000) {
        const refreshed = await refreshGrant(config.clientId, current.refresh)
        if (!state.rotate(reviewer, current.version, refreshed) || !refreshed) return null
        current = state.getGrant(reviewer)
        if (!current) return null
      }
      const user = await gh.identity(current.token)
      return user.id === reviewer && state.getGrant(reviewer)?.version === current.version ? current.token : null
    },
  }
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', ok)
  })
  console.log('Listening for signed GitHub webhooks on 127.0.0.1:' + port)
  let stopping = false
  const stop = () => { stopping = true; server.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    while (!stopping) {
      const route = state.next()
      if (!route) {
        await delay(1000)
        continue
      }
      try {
        const result = await reviewRoute(io, route, opts)
        console.log('PR #' + route.number + ' reviewer ' + route.reviewer + ': ' + result)
        state.finish(route)
      } catch (err) {
        // Avoid logging provider payloads, paths, tokens or code.
        console.error('PR #' + route.number + ': review could not run' + (err.status ? ' (HTTP ' + err.status + ')' : ''))
        const retry = route.attempts < 2 && ![401, 403, 404, 422].includes(err.status)
        state.finish(route, retry ? Date.now() + 30_000 * (route.attempts + 1) : null)
      }
    }
  } finally {
    server.close()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().catch(err => {
  console.error('AI review service: ' + err.message)
  process.exitCode = 1
})
