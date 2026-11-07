import { createHmac, timingSafeEqual } from 'node:crypto'
import { checkPilot, PILOT_PATH } from './pilot.mjs'

export const MAX_FILES = 20
const MAX_PATCH_BYTES = 24_000
const SHA = /^[0-9a-f]{40}$/

export function signWebhook(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

export function verifyWebhook(secret, body, signature) {
  return typeof signature === 'string' && /^sha256=[a-f0-9]{64}$/.test(signature)
    && timingSafeEqual(Buffer.from(signature), Buffer.from(signWebhook(secret, body)))
}

function* patchLines(patch) {
  if (typeof patch !== 'string') throw new Error('Missing patch')
  let left = 0, right = 0
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[2])
    } else if (text.startsWith('+') && right > 0) {
      yield { text, side: 'RIGHT', line: right++ }
      continue
    } else if (text.startsWith('-') && left > 0) {
      yield { text, side: 'LEFT', line: left++ }
      continue
    } else if (text.startsWith(' ')) {
      left++
      right++
    }
    yield { text }
  }
}

export function numberedPatch(patch) {
  return Array.from(patchLines(patch), ({ text, side, line }) =>
    side ? side + ' ' + line + ': ' + text : text).join('\n')
}

function changedLines(file) {
  const lines = new Map()
  let added = 0, deleted = 0
  for (const { text, side, line } of patchLines(file.patch)) {
    if (!side) continue
    lines.set(side + ':' + line, text.slice(1))
    if (side === 'RIGHT') added++
    else deleted++
  }
  if (added !== file.additions || deleted !== file.deletions || !lines.size) {
    throw new Error('Incomplete patch')
  }
  return lines
}

function inspect(pr, files) {
  if (!Array.isArray(files) || files.length !== pr.changed_files || files.length < 1 || files.length > MAX_FILES) {
    throw new Error('Unsupported diff size')
  }
  const anchors = new Map()
  let bytes = 0
  for (const file of files) {
    if (typeof file.filename !== 'string' || anchors.has(file.filename)) throw new Error('Invalid patch path')
    const lines = changedLines(file)
    bytes += Buffer.byteLength(file.patch) + Buffer.byteLength(file.filename)
    if (bytes > MAX_PATCH_BYTES) throw new Error('Diff exceeds model input budget')
    anchors.set(file.filename, lines)
  }
  return anchors
}

const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

function evidenceLine(lines, side, line, evidence) {
  if (lines?.get(side + ':' + line)?.includes(evidence)) return line
  // Only relocate a verbatim full line that occurs once on the same side.
  const matches = [...(lines ?? [])].filter(([key, text]) =>
    key.startsWith(side + ':') && text.trim() === evidence.trim())
  return matches.length === 1 ? Number(matches[0][0].split(':')[1]) : null
}

export function classify(pr, files, result) {
  const anchors = inspect(pr, files)
  if (typeof result?.complete !== 'boolean' || !Array.isArray(result.findings) || result.findings.length > 12) {
    throw new Error('Invalid or incomplete model review')
  }
  const findings = result.findings.map(f => {
    const side = f?.side ?? 'RIGHT'
    if (!['P1', 'P2'].includes(f?.severity) || !['LEFT', 'RIGHT'].includes(side)
      || !Number.isSafeInteger(f.line) || f.line < 1 || !validText(f.evidence, 250)
      || !validText(f.title, 120) || !validText(f.detail, 600)) {
      throw new Error('Finding has no valid changed-line evidence')
    }
    const line = evidenceLine(anchors.get(f.path), side, f.line, f.evidence)
    if (line === null) throw new Error('Finding has no valid changed-line evidence')
    return { ...f, side, line }
  })
  if (new Set(findings.map(f => JSON.stringify([f.path, f.side, f.line]))).size !== findings.length) {
    throw new Error('Duplicate review locations')
  }
  const blocking = findings.some(f => f.severity === 'P1')
  if (!result.complete && !blocking) throw new Error('Invalid or incomplete model review')
  return { verdict: blocking ? 'BLOCK' : 'PASS', findings, partial: !result.complete }
}

function markerMac(route, head, payload, secret) {
  const scope = JSON.stringify(['review-v1', route.number, route.reviewer, head, payload])
  return createHmac('sha256', secret).update(scope).digest('hex')
}

function priorResult(review, route, secret) {
  if (!SHA.test(review?.commit_id)) return null
  const match = /<!-- safedeal-ai-review:([a-zA-Z0-9_-]{1,20000}):([0-9a-f]{64}) -->/.exec(review.body ?? '')
  if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(markerMac(route, review.commit_id, match[1], secret)))) {
    return null
  }
  return JSON.parse(Buffer.from(match[1], 'base64url').toString())
}

function clean(value) {
  return value.replace(/[\r\n]+/g, ' ').replaceAll('@', '＠')
    .replace(/[\\<>&`*_\[\]~]/g, char => '\\' + char)
}

export function makeReview(pr, route, result, opts) {
  const { verdict, findings, reason } = result
  const event = reason ? 'COMMENT' : verdict === 'BLOCK' ? 'REQUEST_CHANGES'
    : opts.autoApprove ? 'APPROVE' : 'COMMENT'
  const p1 = findings.filter(f => f.severity === 'P1').length
  const unique = new Map([
    ...(result.blockers ?? []),
    ...findings.filter(f => f.severity === 'P1').map(({ path, side, evidence }) => [path, side, evidence]),
  ].map(blocker => [JSON.stringify(blocker), blocker]))
  const metadata = Buffer.from(JSON.stringify({
    base: pr.base.sha, retry: !!reason, overflow: !!result.overflow || unique.size > 24,
    p1Verified: result.p1Verified === true,
    pilotChecked: result.pilotChecked === true,
    blockers: [...unique.values()].slice(0, 24),
  })).toString('base64url')
  return {
    commit_id: pr.head.sha,
    event,
    body: '**' + verdict + '** · SafeDeal AI 위임 리뷰\n\n'
      + (reason ?? ('P1 ' + p1 + '건 · P2 ' + (findings.length - p1) + '건'
        + (result.pilotChecked ? ' · 시범 코드 계정 일치·불일치 검증' : '')
        + (event === 'COMMENT' ? ' · 자동 승인 비활성' : '')
        + (result.partial ? '\n\n검토가 일부만 완료됐으며, 확인된 P1 때문에 변경을 요청합니다.' : '')))
      + '\n\n<!-- safedeal-ai-review:' + metadata + ':' + markerMac(route, pr.head.sha, metadata, opts.secret) + ' -->',
    comments: findings.map(f => ({
      path: f.path, line: f.line, side: f.side,
      body: '**[' + f.severity + '] ' + clean(f.title) + '**\n\n' + clean(f.detail),
    })),
  }
}

export function eligible(pr, route, repoId) {
  return pr?.state === 'open' && pr.draft === false && pr.user?.id !== route.reviewer
    && pr.base?.repo?.id === repoId && pr.head?.repo?.id === repoId
    && pr.base.ref === 'dev' && SHA.test(pr.base.sha) && SHA.test(pr.head.sha)
}

function allowedPath(path) {
  return typeof path === 'string' && /^src\/.+\.(?:[cm]?[jt]sx?|css|scss)$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..')
}

async function reviewState(io, pr, route, secret) {
  const [users, reviews] = await Promise.all([io.requested(route.number), io.reviews(route.number)])
  const latest = reviews.filter(r => r.user?.id === route.reviewer && r.state !== 'PENDING').at(-1)
  const previous = priorResult(latest, route, secret)
  const requested = users.some(user => user.id === route.reviewer)
  const legacyPilotBlock = !previous?.pilotChecked && previous?.blockers?.some(([path]) => path === PILOT_PATH)
  const legacyBlock = latest?.state === 'CHANGES_REQUESTED' && (!previous?.p1Verified || legacyPilotBlock)
  if (previous?.base === pr.base.sha && latest.commit_id === pr.head.sha
    && !(requested && (previous.retry || legacyBlock))) return null
  return requested || (previous && ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(latest.state))
    ? { previous, latest } : null
}

function openBlockers(previous, files, base) {
  const prior = previous?.blockers ?? []
  if (previous?.base !== base) return prior
  return prior.filter(([path, side, evidence]) => files.some(file =>
    (file.filename === path || file.previous_filename === path)
    && file.patch.split('\n').some(line =>
      (line.startsWith(side === 'RIGHT' ? '+' : '-') || (side === 'RIGHT' && line.startsWith(' ')))
      && line.slice(1).includes(evidence))))
}

async function verifyBlockers(io, route, pr, files, result, previous, latest) {
  const remaining = openBlockers(previous, files, pr.base.sha)
  const candidates = result.findings.filter(f => f.severity === 'P1').map(finding => ({ finding }))
  if (remaining.length && previous.base === pr.base.sha && latest?.commit_id === pr.head.sha
    && Number.isSafeInteger(latest.id)) {
    const comments = await io.reviewComments(route.number, latest.id)
    const anchors = inspect(pr, files)
    for (const blocker of remaining) {
      const [path, side, evidence] = blocker
      const matches = comments.filter(comment => comment.path === path && comment.side === side
        && comment.body?.startsWith('**[P1]')
        && anchors.get(path)?.get(side + ':' + comment.line)?.includes(evidence))
      if (matches.length === 1) {
        const comment = matches[0]
        candidates.push({ blocker, finding: { path, side, line: comment.line, evidence, detail: comment.body.slice(0, 750) } })
      }
    }
  }
  const refuted = new Set()
  const confirmed = new Set()
  if (candidates.length) {
    const anchors = inspect(pr, files)
    const input = candidates.map(({ finding }, id) => ({
      ...finding, id, code: anchors.get(finding.path).get(finding.side + ':' + finding.line),
    }))
    const checks = await io.verifyP1(files, input)
    if (Array.isArray(checks) && checks.length === candidates.length
      && new Set(checks.map(check => check?.id)).size === candidates.length) {
      for (const check of checks) {
        const candidate = input[check?.id]
        if (!Number.isSafeInteger(check?.id) || !candidate || !validText(check.reason, 600)
          || !validText(check.evidence, 250) || check.evidence.trim().length < 5
          || !candidate.code.includes(check.evidence)) continue
        if (check.verdict === 'confirmed') confirmed.add(candidates[check.id].finding)
        if (check.verdict === 'refuted') refuted.add(candidates[check.id])
      }
    }
  }
  const cleared = new Set([...refuted].map(candidate => candidate.blocker))
  result.blockers = remaining.filter(blocker => !cleared.has(blocker))
  result.overflow = previous?.overflow
  result.findings = result.findings.filter(f => f.severity === 'P2' || confirmed.has(f))
  result.p1Verified = result.findings.some(f => f.severity === 'P1')
  if (result.p1Verified) return
  const uncertain = candidates.some(candidate => !candidate.blocker && !refuted.has(candidate))
  if (uncertain || result.partial || result.blockers.length || result.overflow) {
    result.verdict = 'BLOCK'
    result.reason = 'P1의 근거 또는 전체 검토를 확인할 수 없어 팀원 검토가 필요합니다.'
    return
  }
  result.verdict = 'PASS'
}

export async function reviewRoute(io, route, opts) {
  if (!io.active(route)) return 'inactive'
  const pr = await io.pr(route.number)
  if (!eligible(pr, route, opts.repoId)) return 'ineligible'
  const start = await reviewState(io, pr, route, opts.secret)
  if (!start) return 'ineligible'
  if (!await io.grant(route.reviewer)) return 'not-enrolled'
  const { previous, latest } = start
  const hold = reason => ({
    verdict: 'BLOCK', findings: [], reason, blockers: previous?.blockers, overflow: previous?.overflow,
  })
  let result
  if (pr.changed_files > MAX_FILES) {
    result = hold('변경 파일이 너무 많습니다. 팀원 검토가 필요합니다.')
  } else {
    const files = await io.files(route.number, pr)
    if (files.some(file => !allowedPath(file.filename) || (file.previous_filename && !allowedPath(file.previous_filename)))) {
      result = hold('자동 승인 범위를 벗어난 파일입니다. 팀원 검토가 필요합니다.')
    } else {
      try {
        inspect(pr, files)
        result = checkPilot(files, openBlockers(previous, files, pr.base.sha), previous?.overflow)
        if (!result) {
          try {
            result = classify(pr, files, await io.analyze(files))
          } catch {
            if (!io.active(route)) return 'superseded'
            result = classify(pr, files, await io.analyze(files, true))
          }
          if (!io.active(route)) return 'superseded'
          await verifyBlockers(io, route, pr, files, result, previous, latest)
        }
      } catch {
        result = hold('변경분 또는 모델 응답을 검증할 수 없습니다. 팀원 검토가 필요합니다.')
      }
    }
  }
  if (result.findings.length) result.findings = await io.localize(result.findings)
  const token = await io.grant(route.reviewer)
  if (!token) return 'not-enrolled'
  const end = await reviewState(io, pr, route, opts.secret)
  if (!end || end.latest?.id !== start.latest?.id) return 'superseded'
  const current = await io.pr(route.number)
  if (!eligible(current, route, opts.repoId) || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha
    || !io.active(route)) {
    return 'superseded'
  }
  await io.submit(token, route.number, makeReview(pr, route, result, opts))
  return result.verdict
}
