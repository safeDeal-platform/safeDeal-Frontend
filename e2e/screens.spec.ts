import { expect, test } from '@playwright/test'

// 백엔드가 아직 보내지 않는 필드(사진·판매자·검증 배지·favorited)를 보냈을 때의 화면을 확인한다.
const me = { publicId: '01JSELLER00000000000000001', nickname: '안전거래러', role: 'USER', emailVerified: true, trustScore: 50, accessToken: 'test-access', expiresIn: 900 }
const pixel = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="%23ccc"/></svg>'
const detail = {
  publicId: '01JLISTING0000000000000001', title: '소니 WH-1000XM5', price: 235000, status: 'ACTIVE',
  category: { code: 'DIGITAL_AUDIO', name: '이어폰·헤드폰', parentName: '디지털기기' }, itemCondition: 'LIKE_NEW',
  region: { sido: '서울특별시', sigungu: '마포구' }, description: '케이스 포함', createdAt: '2026-11-14T00:00:00Z', viewCount: 152, version: 3,
  images: [{ url: pixel, isPrimary: true }, { url: pixel }], verificationBadge: 'APPROVED', favoriteCount: 8,
  seller: { publicId: me.publicId, nickname: me.nickname, trustScore: 50 },
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { success: false, error: { code: 'C005', message: '로그인이 필요합니다.' } } }))
  await page.route('**/api/categories', (route) => route.fulfill({ json: { success: true, data: { categories: [] } } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { success: true, data: { unreadCount: 0 } } }))
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { success: true, data: { items: [], latestId: null } } }))
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { success: true, data: me } }))
  // 목록 요청이 401로 떨어지면 앱이 세션을 끝내므로, 기본은 빈 목록으로 응답한다.
  await page.route((url) => url.pathname === '/api/listings', (route) => route.fulfill({ json: { success: true, data: { items: [], nextCursor: null, hasNext: false } } }))
})

test('목록 카드는 서버가 준 썸네일과 검증 배지를 보여 주고, 없으면 배지를 만들어 내지 않는다', async ({ page }) => {
  await page.route((url) => url.pathname === '/api/listings', (route) => route.fulfill({ json: { success: true, data: { hasNext: false, nextCursor: null, items: [
    { publicId: detail.publicId, title: '배지 있는 매물', price: 1000, status: 'ACTIVE', categoryCode: 'DIGITAL_AUDIO', regionSido: '서울', regionSigungu: '마포구', createdAt: detail.createdAt, thumbnailUrl: pixel, verificationBadge: 'APPROVED' },
    { publicId: '01JLISTING0000000000000002', title: '배지 없는 매물', price: 2000, status: 'ACTIVE', categoryCode: 'DIGITAL_AUDIO', regionSido: '서울', regionSigungu: '마포구', createdAt: detail.createdAt },
  ] } } }))
  await page.goto('/')
  const withBadge = page.getByRole('article').filter({ hasText: '배지 있는 매물' })
  const withoutBadge = page.getByRole('article').filter({ hasText: '배지 없는 매물' })
  await expect(withBadge.getByText('인증됨')).toBeVisible()
  await expect(withBadge.locator('img')).toHaveCount(1)
  await expect(withoutBadge.getByText(/인증됨|미인증|위조 의심/)).toHaveCount(0)
})

test('좁은 화면에서는 상단 메뉴가 한 줄에서 가로로 밀리고, 배지 안내는 이름만 칩으로 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: '주요 메뉴' })
  const box = await nav.boundingBox()
  expect(box!.height).toBeLessThan(50)
  expect(await nav.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const guide = page.getByRole('list', { name: '검증 배지 안내' })
  await expect(guide.getByText('인증됨')).toBeVisible()
  expect((await guide.boundingBox())!.height).toBeLessThan(90)
  // 375px에서는 세 칩이 한 줄에 놓여야 한다(더 좁은 화면에서는 줄바꿈을 허용한다).
  const tops = await guide.getByRole('listitem').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)))
  expect(tops).toHaveLength(3)
  expect(new Set(tops).size).toBe(1)
})

test('목록 화면은 필터를 바꿔도 React key 경고 없이 다시 그려진다', async ({ page }) => {
  const keyWarnings: string[] = []
  page.on('console', (message) => { if (message.text().includes('same key')) keyWarnings.push(message.text()) })
  await page.goto('/')
  await expect(page.getByText('조건에 맞는 매물이 없어요.')).toBeVisible()
  await page.getByLabel('최소 가격 (원)').fill('1000')
  await page.getByRole('button', { name: '필터 적용' }).click()
  await expect(page).toHaveURL(/minPrice=1000/)
  await expect(page.getByLabel('최소 가격 (원)')).toHaveValue('1000')
  await expect(page.getByText('조건에 맞는 매물이 없어요.')).toBeVisible()
  expect(keyWarnings).toEqual([])
})

test('판매자 본인은 상세에서 채팅 대신 판매완료·삭제를 쓰고, 삭제하면 마이페이지로 돌아간다', async ({ page }) => {
  const calls: string[] = []
  await page.route('**/api/listings/' + detail.publicId, async (route) => {
    calls.push(route.request().method())
    if (route.request().method() === 'DELETE') return route.fulfill({ json: { success: true } })
    return route.fulfill({ json: { success: true, data: detail } })
  })
  await page.route('**/api/listings/' + detail.publicId + '/status', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: 'MARK_SOLD' })
    await route.fulfill({ json: { success: true, data: { status: 'SOLD', soldSource: 'MANUAL' } } })
  })

  await page.goto('/login')
  await page.getByLabel('이메일').fill('seller@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate((id) => { window.history.pushState({}, '', '/listings/' + id); window.dispatchEvent(new PopStateEvent('popstate')) }, detail.publicId)

  await expect(page.getByRole('heading', { name: detail.title })).toBeVisible()
  await expect(page.getByText('내가 올린 매물이에요')).toBeVisible()
  await expect(page.getByRole('button', { name: /채팅방 열기/ })).toHaveCount(0)
  await expect(page.getByText('신뢰도 50.0')).toBeVisible()
  await expect(page.getByText(/찜 8/)).toBeVisible()
  await page.getByRole('button', { name: '사진 2 보기' }).click()
  await expect(page.getByRole('button', { name: '사진 2 보기' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '판매완료로 바꾸기' }).click()
  await expect(page.getByRole('button', { name: '판매중으로 되돌리기' })).toBeVisible()

  await page.getByRole('button', { name: '삭제' }).click()
  await expect(page.getByText('삭제할까요?')).toBeVisible()
  await page.getByRole('alert').getByRole('button', { name: '삭제' }).click()
  await expect(page).toHaveURL(/\/account\?tab=selling$/)
  await expect(page.getByText(`'${detail.title}' 매물을 삭제했어요.`)).toBeVisible()
  expect(calls).toContain('DELETE')
})

test('다른 사람의 매물은 구매자 버튼을 보여 주고, 서버가 준 favorited로 찜 상태를 바로 표시한다', async ({ page }) => {
  let favoritesRead = false
  await page.route('**/api/users/me/favorites*', (route) => { favoritesRead = true; return route.fulfill({ json: { success: true, data: { items: [], nextCursor: null, hasNext: false } } }) })
  await page.route('**/api/listings/' + detail.publicId, (route) => route.fulfill({ json: { success: true, data: {
    ...detail, seller: { publicId: '01JOTHER000000000000000001', nickname: '다른사람', trustScore: 72.5 }, favorited: true,
  } } }))
  await page.goto('/login')
  await page.getByLabel('이메일').fill('buyer@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate((id) => { window.history.pushState({}, '', '/listings/' + id); window.dispatchEvent(new PopStateEvent('popstate')) }, detail.publicId)

  await expect(page.getByRole('button', { name: /채팅방 열기/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /찜 해제/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('신뢰도 72.5')).toBeVisible()
  expect(favoritesRead).toBe(false)
})

test('다른 사람의 매물을 사유와 함께 신고하고, 서버가 거절하면 이유를 안내하고, 접수한 신고는 취소할 수 있다', async ({ page }) => {
  const bodies: unknown[] = []
  let cancelled = ''
  await page.route('**/api/listings/' + detail.publicId, (route) => route.fulfill({ json: { success: true, data: {
    ...detail, seller: { publicId: '01JOTHER000000000000000001', nickname: '다른사람', trustScore: 72.5 }, favorited: false,
  } } }))
  await page.route('**/api/reports', (route) => {
    bodies.push(route.request().postDataJSON())
    if (bodies.length === 1) return route.fulfill({ status: 409, json: { success: false, error: { code: 'RPT001', message: '이미 같은 사유로 접수된 신고가 있습니다.' } } })
    return route.fulfill({ status: 201, json: { success: true, data: { reportId: '01JREPORT0000000000000001', status: 'RECEIVED', receivedAt: '2026-11-17T01:00:00Z' } } })
  })
  await page.route('**/api/reports/*/cancel', (route) => { cancelled = route.request().url(); return route.fulfill({ json: { success: true } }) })

  await page.goto('/login')
  await page.getByLabel('이메일').fill('buyer@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate((id) => { window.history.pushState({}, '', '/listings/' + id); window.dispatchEvent(new PopStateEvent('popstate')) }, detail.publicId)

  await page.getByRole('button', { name: '이 매물 신고하기' }).click()
  const form = page.getByRole('form', { name: '매물 신고' })
  await form.getByRole('button', { name: '신고 접수' }).click()
  await expect(form.getByRole('alert')).toHaveText('신고 사유를 골라 주세요.')
  expect(bodies).toHaveLength(0)

  await form.getByRole('radio', { name: /사기 의심/ }).check()
  await form.getByLabel(/자세한 내용/).fill('선입금을 요구해요')
  await expect(form.getByText('9 / 1,000자')).toBeVisible()
  await form.getByRole('button', { name: '신고 접수' }).click()
  await expect(form.getByRole('alert')).toContainText('이미 같은 사유로 접수한 신고가 있어요')

  await form.getByRole('radio', { name: /스팸·광고/ }).check()
  await form.getByRole('button', { name: '신고 접수' }).click()
  await expect(page.getByRole('status').filter({ hasText: '신고를 접수했어요' })).toBeVisible()
  expect(bodies).toEqual([
    { targetType: 'LISTING', targetId: detail.publicId, reasonCode: 'FRAUD', detail: '선입금을 요구해요' },
    { targetType: 'LISTING', targetId: detail.publicId, reasonCode: 'SPAM', detail: '선입금을 요구해요' },
  ])

  await page.getByRole('button', { name: '신고 취소' }).click()
  await expect(page.getByText('신고를 취소했어요.')).toBeVisible()
  expect(cancelled).toContain('/api/reports/01JREPORT0000000000000001/cancel')
  await expect(page.getByRole('button', { name: '이 매물 신고하기' })).toBeVisible()
})

test('로그인하지 않고 신고하기를 누르면 로그인 화면으로 보낸다', async ({ page }) => {
  await page.route('**/api/listings/' + detail.publicId, (route) => route.fulfill({ json: { success: true, data: {
    ...detail, seller: { publicId: '01JOTHER000000000000000001', nickname: '다른사람', trustScore: 72.5 },
  } } }))
  await page.goto('/listings/' + detail.publicId)
  await page.getByRole('button', { name: '이 매물 신고하기' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('찜한 매물이 제재·삭제되면 제목과 가격 대신 볼 수 없는 매물로 보여 주고, 찜은 해제할 수 있다', async ({ page }) => {
  const ref = (publicId: string, title: string | null, price: number | null, status: string) => ({ listing: { publicId, title, price, status }, notifyBasePrice: 1, favoritedAt: '2026-11-18T00:00:00Z' })
  let removed = ''
  await page.route('**/api/users/me/favorites*', (route) => route.fulfill({ json: { success: true, data: { hasNext: false, nextCursor: null, items: [
    ref('01JLISTING0000000000000011', '판매 중인 헤드폰', 950000, 'ACTIVE'),
    ref('01JLISTING0000000000000012', '제재된 아이폰', 111000, 'BLOCKED'),
    ref('01JLISTING0000000000000013', null, null, 'DELETED'),
    // 상태와 상관없이 제목·가격이 비어 오면 가리는 분기를 따로 확인한다(백엔드가 비워 보내는 경우).
    ref('01JLISTING0000000000000014', null, 222000, 'ACTIVE'),
    ref('01JLISTING0000000000000015', '가격 빠진 매물', null, 'ACTIVE'),
  ] } } }))
  await page.route('**/api/listings/*/favorite', (route) => { removed = route.request().url(); return route.fulfill({ json: { success: true, data: { favorited: false } } }) })

  await page.goto('/login')
  await page.getByLabel('이메일').fill('buyer@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate(() => { window.history.pushState({}, '', '/favorites'); window.dispatchEvent(new PopStateEvent('popstate')) })

  await expect(page.getByText('판매 중인 헤드폰')).toBeVisible()
  await expect(page.getByText('950,000원')).toBeVisible()
  const hidden = page.getByRole('article').filter({ hasText: '더 이상 볼 수 없는 매물' })
  await expect(hidden).toHaveCount(4)
  // 가린 카드에는 원래 제목·가격·낙인 문구·상세 링크가 없고, 찜 해제 버튼만 있다.
  for (const leaked of ['제재된 아이폰', '가격 빠진 매물', '111,000원', '222,000원', '거래 불가']) {
    await expect(page.getByText(leaked)).toHaveCount(0)
  }
  await expect(hidden.getByRole('link')).toHaveCount(0)
  await expect(hidden.getByRole('button', { name: '볼 수 없는 매물 찜 해제' })).toHaveCount(4)

  await hidden.first().getByRole('button', { name: '볼 수 없는 매물 찜 해제' }).click()
  await expect(hidden).toHaveCount(3)
  expect(removed).toContain('01JLISTING0000000000000012')
})

const profile = { publicId: me.publicId, email: 'seller@example.test', nickname: me.nickname, emailVerified: true, trustScore: 50, createdAt: '2026-08-01T00:00:00Z' }

test('새로고침으로 다시 열어도 내 정보를 불러와 내 매물에는 신고 대신 판매자 버튼을 보여 준다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: { success: true, data: { accessToken: 'test-access', expiresIn: 900 } } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => route.fulfill({ json: { success: true, data: profile } }))
  await page.route('**/api/listings/' + detail.publicId, (route) => route.fulfill({ json: { success: true, data: detail } }))

  await page.goto('/listings/' + detail.publicId)
  await expect(page.getByText('내가 올린 매물이에요')).toBeVisible()
  await expect(page.getByRole('button', { name: /이 매물 신고하기/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '판매완료로 바꾸기' })).toBeVisible()

  await page.goto('/account?tab=profile')
  await expect(page.getByRole('heading', { name: '안전거래러님' })).toBeVisible()
  await expect(page.getByText('seller@example.test · 이메일 인증 완료 · 2026년 8월 가입')).toBeVisible()
})

test('내 정보를 못 불러오면 로그인은 유지하고 다시 불러오기로 채운다', async ({ page }) => {
  let online = false
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: { success: true, data: { accessToken: 'test-access', expiresIn: 900 } } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => online
    ? route.fulfill({ json: { success: true, data: profile } })
    : route.fulfill({ status: 503, json: { success: false, error: { code: 'C500', message: '잠시 후 다시 시도해 주세요.' } } }))

  await page.goto('/account')
  await expect(page.getByText('내 정보를 불러오지 못했어요.')).toBeVisible()
  online = true
  await page.getByRole('button', { name: '다시 불러오기' }).click()
  await expect(page.getByRole('heading', { name: '안전거래러님' })).toBeVisible()
})

test('정지된 계정으로 확인되면 로그인 상태를 끝내고 이유를 알린다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: { success: true, data: { accessToken: 'test-access', expiresIn: 900 } } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => route.fulfill({ status: 403, json: { success: false, error: { code: 'AUTH005', message: '이용이 제한된 계정입니다.' } } }))

  await page.goto('/')
  await expect(page.getByRole('alert').filter({ hasText: '이용이 제한된 계정이라 로그인 상태를 끝냈어요.' })).toBeVisible()
  await expect(page.getByRole('link', { name: '로그인' })).toBeVisible()
})

test('이메일 인증 직후 내 정보를 다시 못 읽어도 다시 불러오기로 인증 상태를 확인할 수 있다', async ({ page }) => {
  let online = false
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { success: true, data: { ...me, emailVerified: false } } }))
  await page.route('**/api/auth/email/verify', (route) => route.fulfill({ json: { success: true } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => online
    ? route.fulfill({ json: { success: true, data: profile } })
    : route.fulfill({ status: 503, json: { success: false, error: { code: 'C500', message: '잠시 후 다시 시도해 주세요.' } } }))

  await page.goto('/login')
  await page.getByLabel('이메일').fill('seller@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.evaluate(() => { window.history.pushState({}, '', '/email/verify?token=mail-token'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await page.getByRole('button', { name: '이메일 인증 완료' }).click()
  await expect(page.getByText('이메일 인증을 완료했습니다.')).toBeVisible()

  online = true
  await page.getByRole('button', { name: '다시 불러오기' }).click()
  await page.evaluate(() => { window.history.pushState({}, '', '/account'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page.getByText(/이메일 인증 완료/)).toBeVisible()
  await expect(page.getByRole('button', { name: '다시 불러오기' })).toHaveCount(0)
})
