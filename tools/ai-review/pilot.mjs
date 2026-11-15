export const PILOT_PATH = 'src/review-pilot.ts'

const prelude = [
  'type Order = {', '  id: string', '  ownerId: string', '  deliveryAddress: string', '}', '',
  "// The account's order history must only show the signed-in buyer's orders.",
]

export function checkPilot(files, remaining, overflow) {
  const [file] = files
  if (files.length !== 1 || file.filename !== PILOT_PATH || file.status !== 'added'
    || file.deletions !== 0 || overflow) return null

  const [hunk, ...lines] = file.patch.split('\n')
  if (hunk !== '@@ -0,0 +1,' + lines.length + ' @@'
    || lines.some(line => !line.startsWith('+'))) return null

  const source = lines.map(line => line.slice(1))
  if (!prelude.every((line, index) => source[index] === line)) return null
  const [declaration, body, closing] = source.slice(prelude.length)
  if (!body) return null

  // Recognize the whole fixture before interpreting its comparison. PR code is never executed.
  let comparison
  if (source.length === 9 && declaration === 'export const visibleOrders = (history: readonly Order[], accountId: string): Order[] =>') {
    comparison = /^  history\.filter\(\(\{ ownerId \}\) => accountId (===|!==) ownerId\)$/.exec(body)
  } else if (source.length === 10 && closing === '}'
    && declaration === 'export function visibleOrders(orders: readonly Order[], viewerId: string): Order[] {') {
    comparison = /^  return orders\.filter\(\(order\) => order\.ownerId (===|!==) viewerId\)$/.exec(body)
  }
  if (!comparison || remaining.some(([path, side, evidence]) =>
    path !== PILOT_PATH || side !== 'RIGHT' || !body.includes(evidence))) return null

  const keepsOrder = (account, owner) => comparison[1] === '===' ? account === owner : account !== owner
  const ownOrder = keepsOrder('A', 'A')
  const otherOrder = keepsOrder('A', 'B')
  const findings = ownOrder && !otherOrder ? [] : [{
    severity: 'P1', path: PILOT_PATH, side: 'RIGHT', line: 9, evidence: body.trim(),
    title: '다른 계정의 주문이 노출됩니다',
    detail: '계정 A로 조회하면 소유자 A의 주문은 제외되고 소유자 B의 주문은 반환됩니다.',
  }]
  return {
    verdict: findings.length ? 'BLOCK' : 'PASS',
    findings, pilotChecked: true, p1Verified: findings.length > 0,
  }
}
