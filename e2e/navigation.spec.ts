import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const detail = {
  publicId: '01JABCDEFGHJKMNPQRSTVWXYZ1',
  title: '무선 헤드폰',
  price: 235000,
  category: { code: 'DIGITAL_AUDIO', name: '이어폰·헤드폰', parentName: '디지털기기' },
  region: { sido: '서울', sigungu: '마포구' },
  status: 'ACTIVE',
  itemCondition: 'LIKE_NEW',
  description: '케이스와 충전 케이블이 함께 있어요.',
  createdAt: '2026-11-07T00:00:00Z',
  viewCount: 7,
  version: 0,
  // 백엔드 #54 응답 모양. 이 목업은 로그인 여부와 상관없이 favorited를 null로 준다.
  seller: { publicId: '01JABCDEFGHJKMNPQRSTVWXYZ9', nickname: '헤드폰주인', trustScore: 50 },
  favoriteCount: 2,
  favorited: null,
}
const categories = [
  { code: 'DIGITAL', name: '디지털기기', parentCode: null, depth: 1, sortOrder: 1 },
  { code: 'DIGITAL_AUDIO', name: '이어폰·헤드폰', parentCode: 'DIGITAL', depth: 2, sortOrder: 2 },
]
const listings = [
  { publicId: detail.publicId, title: detail.title, price: detail.price, status: 'ACTIVE', categoryCode: 'DIGITAL_AUDIO', regionSido: '서울', regionSigungu: '마포구', createdAt: detail.createdAt },
  { publicId: '01JABCDEFGHJKMNPQRSTVWXYZ2', title: '원목 라운지 체어', price: 95000, status: 'ACTIVE', categoryCode: 'FURNITURE_CHAIR', regionSido: '서울', regionSigungu: '성동구', createdAt: detail.createdAt },
  { publicId: '01JABCDEFGHJKMNPQRSTVWXYZ3', title: '백패킹 텐트', price: 150000, status: 'ACTIVE', categoryCode: 'SPORTS_CAMPING', regionSido: '경기', regionSigungu: '성남시', createdAt: detail.createdAt },
]

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const data = {
      '/api/categories': { categories },
      '/api/listings': { items: listings, nextCursor: null, hasNext: false },
      ['/api/listings/' + detail.publicId]: detail,
      '/api/price-statistics': { categoryCode: 'DIGITAL_AUDIO', period: '7d', sampleCount: 4, message: '시세 정보가 부족합니다.' },
    }[url.pathname]
    if (data === undefined) {
      await route.fulfill({ status: 401, json: { success: false, code: 'AUTH401', message: '로그인이 필요합니다.' } })
      return
    }
    await route.fulfill({ json: { success: true, data } })
  })
})

test('API 매물 상세에서 시세를 보고 이전 상세로 돌아온다', async ({ page }) => {
  await page.goto('/')
  const listingLink = page.getByRole('link', { name: /무선 헤드폰/ })
  await expect(listingLink).toBeVisible()
  if (process.env.SAFEDEAL_SCREENSHOTS_DIR) {
    await page.screenshot({ path: join(process.env.SAFEDEAL_SCREENSHOTS_DIR, 'safedeal-desktop-home.png'), fullPage: true })
  }
  await listingLink.click()
  await expect(page.getByRole('heading', { name: '무선 헤드폰' })).toBeVisible()
  if (process.env.SAFEDEAL_SCREENSHOTS_DIR) {
    await page.screenshot({ path: join(process.env.SAFEDEAL_SCREENSHOTS_DIR, 'safedeal-desktop-detail.png'), fullPage: true })
  }
  await page.getByRole('link', { name: /시세/ }).click()
  await expect(page.getByText('시세 정보가 부족합니다.')).toBeVisible()
  await page.getByRole('button', { name: /뒤로/ }).click()
  await expect(page.getByRole('heading', { name: '무선 헤드폰' })).toBeVisible()
})

test('검색 대기 상태와 장바구니 대기 상태를 명시한다', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('searchbox', { name: '매물 검색' })).toBeVisible()
  await page.getByRole('link', { name: '장바구니' }).click()
  await expect(page.getByRole('heading', { name: '장바구니' })).toBeVisible()
  await expect(page.getByText(/연동 예정/).first()).toBeVisible()
})

test('로그인 후 같은 매물에서 찜을 추가하고 해제한다', async ({ page }) => {
  const id = detail.publicId
  let favorited = false
  await page.route('**/api/auth/login', (route) => route.fulfill({
    json: { success: true, data: { publicId: '01JABCDEFGHJKMNPQRSTVWXYZ4', nickname: '테스트 사용자', role: 'USER', emailVerified: true, trustScore: 50, accessToken: 'test-access', expiresIn: 900 } },
  }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { success: true, data: { unreadCount: 0 } } }))
  await page.route('**/api/users/me/favorites*', (route) => route.fulfill({
    json: { success: true, data: { items: favorited ? [{ listing: { publicId: id, title: detail.title, price: detail.price, status: 'ACTIVE' }, notifyBasePrice: detail.price, favoritedAt: detail.createdAt }] : [], nextCursor: null, hasNext: false } },
  }))
  await page.route('**/api/listings/' + id + '/favorite', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-access')
    favorited = route.request().method() === 'POST'
    await route.fulfill({ json: { success: true, data: { favorited } } })
  })
  await page.goto('/listings/' + id)
  await page.getByRole('button', { name: '찜하기' }).click()
  await page.getByLabel('이메일').fill('buyer@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page.getByRole('heading', { name: detail.title })).toBeVisible()
  const add = page.getByRole('button', { name: '찜하기' })
  const remove = page.getByRole('button', { name: '찜 해제' })
  const facts = page.locator('.mp-detail-facts')
  await expect(add).toBeEnabled()
  await expect(facts).toContainText('7 · 찜 2')
  await add.click()
  await expect(remove).toHaveAttribute('aria-pressed', 'true')
  // 내가 누른 찜은 다시 불러오지 않아도 수에 바로 반영된다.
  await expect(facts).toContainText('7 · 찜 3')
  await remove.click()
  await expect(add).toHaveAttribute('aria-pressed', 'false')
  await expect(facts).toContainText('7 · 찜 2')
})

test('인증 화면에서 로그인하면 인증 화면 대신 매물 목록으로 가고, 로그인 상태로는 로그인 화면에 머물지 않는다', async ({ page }) => {
  await page.route('**/api/auth/login', (route) => route.fulfill({
    json: { success: true, data: { publicId: '01JABCDEFGHJKMNPQRSTVWXYZ4', nickname: '테스트 사용자', role: 'USER', emailVerified: true, trustScore: 50, accessToken: 'test-access', expiresIn: 900 } },
  }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { success: true, data: { unreadCount: 0 } } }))
  await page.goto('/signup')
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('link', { name: '로그인' }).click()
  // 회원가입 폼에도 같은 이름의 입력칸이 있으므로, 로그인 화면으로 바뀐 뒤에 입력한다.
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: '로그인', level: 1 })).toBeVisible()
  await page.getByLabel('이메일').fill('buyer@example.test')
  await page.getByLabel('비밀번호', { exact: true }).fill('safe-password')
  await page.getByRole('button', { name: '로그인', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '전체 매물' })).toBeVisible()

  // 새로고침해 refresh 쿠키로 세션을 복원한 사용자가 로그인 화면을 열면 매물 목록으로 보낸다.
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: { success: true, data: { accessToken: 'test-access', expiresIn: 900 } } }))
  await page.goto('/login')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '전체 매물' })).toBeVisible()
})
