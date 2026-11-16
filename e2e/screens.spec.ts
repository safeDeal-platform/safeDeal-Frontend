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
