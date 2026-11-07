import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { updateQuickWebhook } from './clients.mjs'
import { signWebhook } from './review.mjs'

const controller = new AbortController()
const { signal } = controller
const children = []
let stopping = false

function stop() {
  stopping = true
  controller.abort()
}

function start(name, command, args, { env = process.env, onLine = () => {} } = {}) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  child.once('error', err => {
    controller.abort(new Error(name + ' could not start (' + err.code + '). Check its installation or configured executable path.'))
  })
  child.once('exit', (code, exitSignal) => {
    controller.abort(new Error(name + ' stopped (' + (code ?? exitSignal) + ').'))
  })
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', onLine)
  }
}

async function waitFor(description, check, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const result = await check()
    if (result) return result
    await delay(500, undefined, { signal })
  }
  throw new Error('Timed out waiting for ' + description)
}

async function probe(url, options = {}) {
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })
  } catch {
    signal.throwIfAborted()
    return null
  }
}

async function ollamaModels() {
  const response = await probe('http://127.0.0.1:11434/api/tags')
  if (!response?.ok) return null
  const result = await response.json().catch(() => null)
  return Array.isArray(result?.models) ? result.models : null
}

async function launch() {
  const appId = Number(process.env.REVIEW_APP_ID)
  const port = Number(process.env.REVIEW_PORT ?? 8787)
  const secret = process.env.REVIEW_WEBHOOK_SECRET ?? ''
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error('Invalid REVIEW_APP_ID')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REVIEW_PORT')
  if (Buffer.byteLength(secret) < 32) throw new Error('Invalid REVIEW_WEBHOOK_SECRET')
  if (!process.env.REVIEW_APP_PRIVATE_KEY_FILE) throw new Error('Missing REVIEW_APP_PRIVATE_KEY_FILE')
  const privateKey = readFileSync(process.env.REVIEW_APP_PRIVATE_KEY_FILE)
  const model = process.env.REVIEW_OLLAMA_MODEL || 'qwen2.5-coder:7b'
  const modelTag = model.split('/').at(-1).includes(':') ? model : model + ':latest'
  const toolEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^REVIEW_/i.test(key)))
  const installedOllama = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
  const ollama = process.env.REVIEW_OLLAMA_EXE || (installedOllama && existsSync(installedOllama) ? installedOllama : 'ollama')

  console.log('[SafeDeal] Checking Ollama...')
  let models = await ollamaModels()
  if (!models) {
    start('Ollama', ollama, ['serve'], { env: { ...toolEnv, OLLAMA_HOST: '127.0.0.1:11434' } })
    models = await waitFor('Ollama', ollamaModels, 30_000)
  }
  if (!models.some(item => [item.name, item.model].some(name => name === modelTag || name === model))) {
    throw new Error('Ollama model is missing. Install it once with ollama pull ' + model)
  }

  let listening = false
  const review = fileURLToPath(new URL('./main.mjs', import.meta.url))
  start('Review bot', process.execPath, [review, 'serve'], {
    onLine(line) {
      console.log('[Review] ' + line)
      if (line.startsWith('Listening for signed GitHub webhooks on ')) listening = true
    },
  })
  await waitFor('the review bot', () => listening, 20_000)

  console.log('[SafeDeal] Starting Cloudflare Quick Tunnel...')
  let origin
  start('Cloudflare Quick Tunnel', process.env.REVIEW_CLOUDFLARED_EXE || 'cloudflared',
    ['tunnel', '--url', 'http://127.0.0.1:' + port], {
      env: toolEnv,
      onLine(line) {
        origin ??= /https:\/\/[a-z\d-]+\.trycloudflare\.com(?=\s|[|]|$)/i.exec(line)?.[0]
      },
    })
  const target = new URL('/webhook', await waitFor('the Quick Tunnel address', () => origin, 90_000))
  const delivery = randomUUID()
  const body = JSON.stringify({ probe: delivery })
  const headers = {
    'content-type': 'application/json', 'x-github-delivery': delivery,
    'x-github-event': 'ping', 'x-hub-signature-256': signWebhook(secret, Buffer.from(body)),
  }
  await waitFor('the public webhook to reach the review bot',
    async () => (await probe(target, { method: 'POST', headers, body }))?.status === 204, 90_000)
  signal.throwIfAborted()
  await updateQuickWebhook({ appId, privateKey }, target)
  signal.throwIfAborted()
  console.log('[SafeDeal] Ready. GitHub webhook: ' + target.href)
  console.log('[SafeDeal] Keep this window open. Press Ctrl+C to stop.')

  await once(signal, 'abort')
  signal.throwIfAborted()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  await launch()
} catch (err) {
  if (!stopping) {
    console.error('[SafeDeal] ' + (signal.reason ?? err).message)
    process.exitCode = 1
  }
} finally {
  for (const child of children.reverse()) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill()
  }
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
