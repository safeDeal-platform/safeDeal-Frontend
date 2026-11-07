import { expect, test } from '@playwright/test'

const catalog = [
  { code: 'DIGITAL', name: '디지털기기', parentCode: null, depth: 1, sortOrder: 1 },
  { code: 'DIGITAL_AUDIO', name: '오디오', parentCode: 'DIGITAL', depth: 2, sortOrder: 1 },
]
const firstListing = {
  publicId: '01JABCDEFGHJKMNPQRSTVWXYZ1',
  title: '무선 헤드폰',
  price: 235000,
  categoryCode: 'DIGITAL_AUDIO',
  regionSido: '서울특별시',
  regionSigungu: '마포구',
  status: 'ACTIVE',
  createdAt: '2026-11-07T00:00:00Z',
}
const secondListing = { ...firstListing, publicId: '01JABCDEFGHJKMNPQRSTVWXYZ2', title: '북셀프 스피커', price: 142000 }
const detail = {
  publicId: firstListing.publicId,
  title: firstListing.title,
  price: firstListing.price,
  status: firstListing.status,
  createdAt: firstListing.createdAt,
  category: { code: 'DIGITAL_AUDIO', name: '오디오', parentName: '디지털기기' },
  region: { sido: firstListing.regionSido, sigungu: firstListing.regionSigungu },
  itemCondition: 'USED',
  description: '케이스를 함께 드려요.',
  viewCount: 3,
  version: 0,
}
const favoriteSummary = (listing: typeof firstListing) => ({
  listing: { publicId: listing.publicId, title: listing.title, price: listing.price, status: listing.status },
  favoritedAt: listing.createdAt,
  notifyBasePrice: listing.price,
})

test('서버 필터를 다음 커서 요청에도 보존한다', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/categories') {
      await route.fulfill({ json: { success: true, data: { categories: catalog } } })
      return
    }
    if (url.pathname === '/api/listings') {
      const next = url.searchParams.has('cursor')
      await route.fulfill({ json: {
        success: true,
        data: { items: next ? [secondListing] : [firstListing], nextCursor: next ? null : 'page-two', hasNext: !next },
      } })
      return
    }
    await route.fulfill({ status: 401, json: { success: false, error: { message: '로그인이 필요합니다.' } } })
  })

  await page.goto('/')
  await page.getByRole('combobox', { name: '카테고리', exact: true }).selectOption('DIGITAL_AUDIO')
  await page.getByLabel('시·도', { exact: true }).fill('서울특별시')
  await page.getByLabel('시·군·구', { exact: true }).fill('마포구')
  await page.getByLabel('최대 가격 (원)').fill('250000')
  await page.getByRole('button', { name: '필터 적용' }).click()
  await expect(page).toHaveURL(/categoryCode=DIGITAL_AUDIO/)
  const nextRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.get('cursor') === 'page-two')
  await page.getByRole('button', { name: '매물 더 보기' }).click()
  const nextUrl = new URL((await nextRequest).url())
  expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
    categoryCode: 'DIGITAL_AUDIO',
    regionSido: '서울특별시',
    regionSigungu: '마포구',
    maxPrice: '250000',
    cursor: 'page-two',
  })
  await expect(page.getByRole('heading', { name: '북셀프 스피커' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '무선 헤드폰' })).toBeVisible()
})

test('두 번째 찜 목록 페이지의 상태를 찾아서 해제한다', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const response = (data: unknown) => route.fulfill({ json: { success: true, data } })
    if (url.pathname === '/api/auth/reissue') return response({ accessToken: 'test-access', expiresIn: 1200 })
    if (url.pathname === '/api/notifications/unread-count') return response({ unreadCount: 0 })
    if (url.pathname === '/api/listings/' + firstListing.publicId) return response(detail)
    if (url.pathname === '/api/users/me/favorites') {
      const next = url.searchParams.has('cursor')
      return response({ items: [favoriteSummary(next ? firstListing : secondListing)], nextCursor: next ? null : 'favorites-next', hasNext: !next })
    }
    if (url.pathname.endsWith('/favorite') && route.request().method() === 'DELETE') return response({ favorited: false })
    return route.fulfill({ status: 404, json: { success: false, error: { message: '경로를 찾을 수 없습니다.' } } })
  })

  await page.goto('/listings/' + firstListing.publicId)
  const removeButton = page.getByRole('button', { name: '찜 해제' })
  await expect(removeButton).toHaveAttribute('aria-pressed', 'true')
  const removal = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().endsWith('/favorite'))
  await removeButton.click()
  expect((await removal).headers().authorization).toBe('Bearer test-access')
  await expect(page.getByRole('button', { name: '찜하기' })).toHaveAttribute('aria-pressed', 'false')
})

test('시세 페이지에서 돌아와도 현재 탭의 임시 매물 정보가 유지된다', async ({ page }) => {
  let listingWrites = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const response = (data: unknown) => route.fulfill({ json: { success: true, data } })
    if (url.pathname === '/api/auth/reissue') return response({ accessToken: 'test-access', expiresIn: 1200 })
    if (url.pathname === '/api/notifications/unread-count') return response({ unreadCount: 0 })
    if (url.pathname === '/api/categories') return response({ categories: catalog })
    if (url.pathname === '/api/price-statistics') return response({ sampleCount: 0, message: '시세 정보가 부족합니다.', period: '7d' })
    if (url.pathname === '/api/listings' && route.request().method() === 'POST') listingWrites++
    return route.fulfill({ status: 404, json: { success: false, error: { message: '경로를 찾을 수 없습니다.' } } })
  })

  await page.goto('/sell')
  await page.getByLabel('상품명').fill('스피커 임시 매물')
  await page.getByLabel('상품군').selectOption('DIGITAL')
  await page.getByLabel('상품 유형').selectOption('DIGITAL_AUDIO')
  await page.getByRole('radio', { name: /안전거래/ }).check()
  await page.getByLabel('택배비').fill('4500')
  await expect(page.getByLabel('택배비')).toHaveValue('4,500')
  await page.getByRole('button', { name: '임시 저장' }).click()
  await page.getByRole('link', { name: '판매 시세 알아보기' }).click()
  await expect(page.getByRole('heading', { name: '매물 시세' })).toBeVisible()
  await page.getByRole('button', { name: '뒤로' }).click()
  await expect(page.getByLabel('상품명')).toHaveValue('스피커 임시 매물')
  await expect(page.getByLabel('택배비')).toHaveValue('4,500')
  await expect(page.getByRole('button', { name: '인증샷 촬영으로' })).toBeDisabled()
  expect(listingWrites).toBe(0)
})
