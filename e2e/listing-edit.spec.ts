import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// 매물 수정 화면: 백엔드 ListingUpdateRequest(8개 값 + version 전부 덮어쓰기),
// 409 C009(버전 충돌), 400 LST001(하루 2번 넘는 가격 인하), 400 C001(수정할 수 없는 상태) 계약을 따른다.
const sellerId = '01JSELLER00000000000000001'
const profile = { publicId: sellerId, email: 'seller@example.test', nickname: '안전거래러', emailVerified: true, trustScore: 50, createdAt: '2026-08-01T00:00:00Z' }
const categories = [
  { code: 'DIGITAL', name: '디지털기기', parentCode: null, depth: 1, sortOrder: 1 },
  { code: 'DIGITAL_AUDIO', name: '이어폰·헤드폰', parentCode: 'DIGITAL', depth: 2, sortOrder: 1 },
  { code: 'DIGITAL_CAMERA', name: '카메라', parentCode: 'DIGITAL', depth: 2, sortOrder: 2 },
]
const detail = {
  publicId: '01JLISTING0000000000000001', title: '소니 WH-1000XM5', price: 235000, status: 'ACTIVE',
  category: { code: 'DIGITAL_AUDIO', name: '이어폰·헤드폰', parentName: '디지털기기' }, itemCondition: 'LIKE_NEW',
  region: { sido: '서울특별시', sigungu: '마포구' }, description: '케이스 포함', createdAt: '2026-11-14T00:00:00Z', viewCount: 152, version: 3,
  favoriteCount: 2, seller: { publicId: sellerId, nickname: '안전거래러', trustScore: 50 }, favorited: null,
}
type Detail = typeof detail
type Reply = Parameters<Route['fulfill']>[0]
type Body = Record<string, unknown>

const editPath = '/listings/' + detail.publicId + '/edit'
const detailUrl = new RegExp('/listings/' + detail.publicId + '$')
const fail = (status: number, code: string, message: string, fieldErrors?: { field: string; message: string }[]): Reply =>
  ({ status, json: { success: false, error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } } })
const conflict = fail(409, 'C009', '다른 요청이 먼저 처리되었습니다. 다시 시도해 주세요.')

/**
 * 서버 흉내. GET은 지금 저장된 매물(current)을 준다. 로그인 복원 때문에 GET이 몇 번 오는지는 화면마다 달라서
 * 호출 횟수가 아니라 저장 상태로 응답한다. PATCH는 patch가 정하고, 없으면 보낸 값으로 저장하고 version을 올린다.
 */
async function serve(page: Page, options: { initial?: Detail; patch?: (body: Body, index: number, store: Store) => Reply } = {}) {
  const store: Store = {
    current: options.initial ?? detail,
    save(body) {
      const leaf = categories.find((category) => category.code === body.categoryCode)
      this.current = {
        ...this.current, title: String(body.title), price: Number(body.price), description: String(body.description),
        itemCondition: String(body.itemCondition), region: { sido: String(body.regionSido), sigungu: String(body.regionSigungu) },
        category: { code: String(body.categoryCode), name: leaf?.name ?? '', parentName: '디지털기기' }, version: this.current.version + 1,
      }
      return { json: { success: true, data: { publicId: this.current.publicId, status: this.current.status, version: this.current.version } } }
    },
  }
  const sent: Body[] = []
  await page.route('**/api/listings/' + detail.publicId, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: { success: true, data: store.current } })
    const body = route.request().postDataJSON() as Body
    sent.push(body)
    return route.fulfill(options.patch ? options.patch(body, sent.length - 1, store) : store.save(body))
  })
  return { sent, store }
}
type Store = { current: Detail; save: (body: Body) => Reply }

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill(fail(401, 'C005', '로그인이 필요합니다.')))
  await page.route('**/api/categories', (route) => route.fulfill({ json: { success: true, data: { categories } } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { success: true, data: { unreadCount: 0 } } }))
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { success: true, data: { items: [], latestId: null } } }))
  await page.route((url) => url.pathname === '/api/listings', (route) => route.fulfill({ json: { success: true, data: { items: [], nextCursor: null, hasNext: false } } }))
})

async function signIn(page: Page, publicId = sellerId) {
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: { success: true, data: { accessToken: 'test-access', expiresIn: 900 } } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => route.fulfill({ json: { success: true, data: { ...profile, publicId } } }))
}

test('판매중인 내 매물은 상세의 수정 버튼으로 열고, 8개 값과 version을 모두 보내 저장한 뒤 상세로 돌아간다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page)

  await page.goto('/listings/' + detail.publicId)
  await page.getByRole('link', { name: '수정' }).click()
  await expect(page).toHaveURL(new RegExp(editPath + '$'))

  // 상세에는 상위 분류 코드가 없으므로 카테고리 목록의 parentCode로 상품군을 채운다.
  await expect(page.getByLabel('상품명')).toHaveValue(detail.title)
  await expect(page.getByLabel('상품군')).toHaveValue('DIGITAL')
  await expect(page.getByLabel('상품 유형')).toHaveValue('DIGITAL_AUDIO')
  await expect(page.getByLabel('상품 상태')).toHaveValue('LIKE_NEW')
  await expect(page.getByLabel('판매 가격')).toHaveValue('235,000')
  await expect(page.getByLabel('시·도')).toHaveValue('서울특별시')
  await expect(page.getByLabel('시·군·구')).toHaveValue('마포구')
  await expect(page.getByText('사진 수정은 업로드 연동 뒤에 열려요.')).toBeVisible()
  await expect(page.getByText('거래 방식')).toHaveCount(0)

  await page.getByLabel('상품명').fill('  소니 WH-1000XM5 블랙 ')
  await page.getByLabel('상품 유형').selectOption('DIGITAL_CAMERA')
  await page.getByLabel('판매 가격').fill('240000')
  // 올리는 건 인하 횟수에 들어가지 않으므로 안내를 보여 주지 않는다.
  await expect(page.getByText('가격 인하는 하루 2번까지 할 수 있어요.')).toHaveCount(0)
  await page.getByRole('button', { name: '수정 저장' }).click()

  await expect(page).toHaveURL(detailUrl)
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  await expect(page.getByRole('heading', { name: '소니 WH-1000XM5 블랙' })).toBeVisible()
  expect(sent).toEqual([{
    title: '소니 WH-1000XM5 블랙', price: 240000, categoryCode: 'DIGITAL_CAMERA', description: '케이스 포함',
    itemCondition: 'LIKE_NEW', regionSido: '서울특별시', regionSigungu: '마포구', version: 3,
  }])
})

test('저장 중에는 입력 칸을 잠가, 보낸 값과 화면 값이 달라져 저장 뒤 입력이 사라지는 일을 막는다', async ({ page }) => {
  await signIn(page)
  const { sent, store } = await serve(page)
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  // 나중에 등록한 route가 먼저 잡는다: PATCH 응답만 붙잡아 두고 GET은 serve로 넘긴다.
  await page.route('**/api/listings/' + detail.publicId, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    sent.push(route.request().postDataJSON())
    await held
    return route.fulfill(store.save(sent[sent.length - 1]))
  })

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('보낸 제목')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.getByRole('button', { name: '저장 중' })).toBeDisabled()
  await expect(page.getByLabel('상품명')).toBeDisabled()
  await expect(page.getByLabel('상품 설명')).toBeDisabled()
  await expect(page.getByLabel('판매 가격')).toBeDisabled()

  release()
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  await expect(page.getByRole('heading', { name: '보낸 제목' })).toBeVisible()
  expect(sent).toHaveLength(1)
})

test('409 뒤 다시 저장하는 중에도 최신 내용으로 바꾸기를 누를 수 없다', async ({ page }) => {
  await signIn(page)
  const { sent, store } = await serve(page, {
    patch: (_, __, s) => {
      s.current = { ...s.current, price: 220000, version: 4 }
      return conflict
    },
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })

  await page.goto(editPath)
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.getByText('다른 곳에서 먼저 수정됐어요.')).toBeVisible()
  await page.route('**/api/listings/' + detail.publicId, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    sent.push(route.request().postDataJSON())
    await held
    return route.fulfill(store.save(sent[sent.length - 1]))
  })
  await page.getByRole('button', { name: '최신 기준으로 다시 저장' }).click()
  await expect(page.getByRole('button', { name: '최신 내용으로 바꾸기' })).toBeDisabled()

  release()
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  expect(sent.map((body) => body.version)).toEqual([3, 4])
})

test('판매완료 매물에는 수정 버튼이 없고, 수정 주소로 들어와도 폼 대신 이유를 보여 준다', async ({ page }) => {
  await signIn(page)
  await serve(page, { initial: { ...detail, status: 'SOLD' } })

  await page.goto('/listings/' + detail.publicId)
  await expect(page.getByRole('button', { name: '판매중으로 되돌리기' })).toBeVisible()
  await expect(page.getByRole('link', { name: '수정' })).toHaveCount(0)

  await page.goto(editPath)
  await expect(page.getByText('판매중인 매물만 수정할 수 있어요.')).toBeVisible()
  await expect(page.getByLabel('상품명')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '상세로 돌아가기' })).toHaveAttribute('href', '/listings/' + detail.publicId)
})

test('다른 곳에서 먼저 수정돼 409 C009가 오면 내 입력은 두고 바뀐 칸을 알린 뒤 최신 version으로 다시 저장한다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page, {
    patch: (body, index, store) => {
      if (index > 0) return store.save(body)
      store.current = { ...store.current, price: 220000, version: 4 } // 노트북에서 먼저 가격을 내림
      return conflict
    },
  })

  await page.goto(editPath)
  await page.getByLabel('상품 설명').fill('케이스와 충전 케이블 포함')
  await page.getByRole('button', { name: '수정 저장' }).click()

  await expect(page.getByText('다른 곳에서 먼저 수정됐어요.')).toBeVisible()
  await expect(page.getByText('지금 저장된 값: 220,000원')).toBeVisible()
  // 409를 받았다고 저절로 다시 보내지 않는다. 내 입력(설명·옛 가격)은 그대로 남는다.
  expect(sent).toHaveLength(1)
  await expect(page.getByLabel('상품 설명')).toHaveValue('케이스와 충전 케이블 포함')
  await expect(page.getByLabel('판매 가격')).toHaveValue('235,000')

  await page.getByRole('button', { name: '최신 기준으로 다시 저장' }).click()
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  expect(sent.map((body) => body.version)).toEqual([3, 4])
  expect(sent[1]).toMatchObject({ description: '케이스와 충전 케이블 포함', price: 235000 })
})

test('409 뒤 최신 내용으로 바꾸기를 고르면 내 입력을 버리고 서버 값으로 다시 채운다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page, {
    patch: (body, index, store) => {
      if (index > 0) return store.save(body)
      store.current = { ...store.current, price: 220000, description: '노트북에서 고친 설명', version: 4 }
      return conflict
    },
  })

  await page.goto(editPath)
  await page.getByLabel('상품 설명').fill('휴대폰에서 고친 설명')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await page.getByRole('button', { name: '최신 내용으로 바꾸기' }).click()

  await expect(page.getByLabel('상품 설명')).toHaveValue('노트북에서 고친 설명')
  await expect(page.getByLabel('판매 가격')).toHaveValue('220,000')
  await expect(page.getByText('다른 곳에서 먼저 수정됐어요.')).toHaveCount(0)
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  expect(sent[1]).toMatchObject({ version: 4, price: 220000, description: '노트북에서 고친 설명' })
})

test('가격을 내리면 하루 2번 제한을 미리 알리고, LST001로 거절되면 가격 칸에 이유를 보여 주며 입력은 남긴다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page, { patch: () => fail(400, 'LST001', '가격 인하는 하루 2회까지 가능합니다.') })

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('소니 헤드폰 급처')
  await page.getByLabel('판매 가격').fill('200000')
  await expect(page.getByText('가격 인하는 하루 2번까지 할 수 있어요.')).toBeVisible()
  await page.getByRole('button', { name: '수정 저장' }).click()

  const price = page.getByLabel('판매 가격')
  await expect(page.locator('#edit-price-error')).toHaveText('가격 인하는 하루 2회까지 가능합니다.')
  await expect(price).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('상품명')).toHaveValue('소니 헤드폰 급처')
  await expect(price).toHaveValue('200,000')
  await expect(page).toHaveURL(new RegExp(editPath + '$'))
  expect(sent).toHaveLength(1)

  // 가격을 다시 고치면 거절 이유는 지난 값에 대한 것이라 지운다.
  await price.fill('235000')
  await expect(page.locator('#edit-price-error')).toHaveCount(0)
  await expect(price).not.toHaveAttribute('aria-invalid', 'true')
})

test('서버 기준과 같은 범위를 먼저 검사해 보내지 않고, 서버가 칸 오류를 주면 그 칸 아래에 보여 준다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page, { patch: () => fail(400, 'C001', '입력값이 올바르지 않습니다.', [{ field: 'regionSigungu', message: '시군구는 20자 이하여야 합니다.' }]) })

  await page.goto(editPath)
  await page.getByLabel('판매 가격').fill('500')
  await page.getByLabel('상품명').fill('   ')
  await page.getByLabel('상품 설명').fill('')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.locator('#edit-price-error')).toHaveText('1,000원부터 100,000,000원까지 입력할 수 있어요.')
  await expect(page.locator('#edit-title-error')).toHaveText('상품명을 입력해 주세요.')
  await expect(page.locator('#edit-description-error')).toHaveText('상품 설명을 입력해 주세요.')
  expect(sent).toHaveLength(0)

  await page.getByLabel('판매 가격').fill('235000')
  await page.getByLabel('상품명').fill(detail.title)
  await page.getByLabel('상품 설명').fill('케이스 포함')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.locator('#edit-regionSigungu-error')).toHaveText('시군구는 20자 이하여야 합니다.')
  await expect(page.getByLabel('시·군·구')).toHaveAttribute('aria-invalid', 'true')
  expect(sent).toHaveLength(1)
})

test('쓰지 않게 된 분류에 있던 매물은 상품 유형을 비우고 다시 고르게 한다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page, { initial: { ...detail, category: { code: 'RETIRED_CODE', name: '없어진 분류', parentName: '디지털기기' } } })

  await page.goto(editPath)
  await expect(page.getByText('지금은 쓰지 않는 분류예요. 상품군과 상품 유형을 다시 골라 주세요.')).toBeVisible()
  await expect(page.getByLabel('상품 유형')).toHaveValue('')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.locator('#edit-categoryCode-error')).toHaveText('상품 유형을 골라 주세요.')
  expect(sent).toHaveLength(0)
})

test('열어 둔 사이 판매완료가 돼 저장이 거절되면 폼을 닫고 서버가 준 이유와 돌아가기를 보여 준다', async ({ page }) => {
  await signIn(page)
  await serve(page, {
    patch: (_, __, store) => {
      store.current = { ...store.current, status: 'SOLD', version: 4 } // 그사이 거래가 끝남
      return fail(400, 'C001', '지금 상태에서는 수정할 수 없습니다.')
    },
  })

  await page.goto(editPath)
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.getByText('지금 상태에서는 수정할 수 없습니다.')).toBeVisible()
  await expect(page.getByRole('button', { name: '수정 저장' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '상세로 돌아가기' })).toBeVisible()
})

test('로그인 전에는 로그인을 안내하고, 남의 매물 수정 주소는 폼 없이 막는다', async ({ page }) => {
  await serve(page)
  await page.goto(editPath)
  await expect(page.getByText('로그인하면 내 매물을 수정할 수 있어요.')).toBeVisible()
  await expect(page.getByLabel('상품명')).toHaveCount(0)

  await signIn(page, '01JOTHER000000000000000001')
  await page.goto(editPath)
  await expect(page.getByText('내가 올린 매물만 수정할 수 있어요.')).toBeVisible()
  await expect(page.getByLabel('상품명')).toHaveCount(0)
})

test('고친 내용이 있으면 취소할 때 한 번 묻고, 계속 고치기를 고르면 입력을 그대로 둔다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page)

  await page.goto(editPath)
  // 고친 게 없으면 묻지 않고 상세로 간다.
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page).toHaveURL(detailUrl)

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('바꾸던 제목')
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByText('고친 내용을 버릴까요?')).toBeVisible()
  await page.getByRole('button', { name: '계속 고치기' }).click()
  await expect(page.getByLabel('상품명')).toHaveValue('바꾸던 제목')

  await page.getByRole('button', { name: '취소' }).click()
  await page.getByRole('button', { name: '버리고 나가기' }).click()
  await expect(page).toHaveURL(detailUrl)
  expect(sent).toHaveLength(0)
})

test('고친 내용이 있으면 머리글 메뉴로 나갈 때도 같은 확인을 띄우고, 고른 대로 머물거나 나간다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page)
  const favorites = page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('link', { name: '찜한 매물' })

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('바꾸던 제목')
  await favorites.click()
  // 앱 안 이동은 beforeunload가 잡지 못한다. useBlocker가 이동을 붙잡아 주소가 그대로여야 한다.
  await expect(page.getByText('고친 내용을 버릴까요?')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(editPath + '$'))

  await page.getByRole('button', { name: '계속 고치기' }).click()
  await expect(page.getByText('고친 내용을 버릴까요?')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(editPath + '$'))
  await expect(page.getByLabel('상품명')).toHaveValue('바꾸던 제목')

  // 화면 위 뒤로 버튼도 앱 안 이동이라 같은 확인을 거친다.
  await page.getByRole('button', { name: '뒤로' }).click()
  await expect(page.getByText('고친 내용을 버릴까요?')).toBeVisible()
  await page.getByRole('button', { name: '계속 고치기' }).click()
  await expect(page).toHaveURL(new RegExp(editPath + '$'))

  await favorites.click()
  await page.getByRole('button', { name: '버리고 나가기' }).click()
  await expect(page).toHaveURL(/\/favorites$/)
  expect(sent).toHaveLength(0)
})

test('고친 내용이 없으면 머리글 메뉴로 묻지 않고 나간다', async ({ page }) => {
  await signIn(page)
  await serve(page)

  await page.goto(editPath)
  await expect(page.getByLabel('상품명')).toHaveValue(detail.title)
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('link', { name: '찜한 매물' }).click()
  await expect(page).toHaveURL(/\/favorites$/)
  await expect(page.getByText('고친 내용을 버릴까요?')).toHaveCount(0)
})

test('저장에 성공하면 고친 내용이 있어도 묻지 않고 상세로 옮겨 수정 완료를 알린다', async ({ page }) => {
  await signIn(page)
  const { sent } = await serve(page)

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('새 제목')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page).toHaveURL(detailUrl)
  await expect(page.getByText('고친 내용을 버릴까요?')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '새 제목' })).toBeVisible()
  expect(sent).toHaveLength(1)
})

test('저장 응답을 기다리는 중에 머리글 메뉴로 나가도 묻고, 저장이 실패하면 입력과 이유를 그대로 보여 준다', async ({ page }) => {
  await signIn(page)
  const { sent, store } = await serve(page)
  const holds: (() => void)[] = []
  let failNext = true
  // 나중에 등록한 route가 먼저 잡는다: PATCH 응답을 붙잡아 두었다가 첫 번째는 실패, 두 번째는 저장으로 돌려준다.
  await page.route('**/api/listings/' + detail.publicId, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const body = route.request().postDataJSON() as Body
    sent.push(body)
    await new Promise<void>((resolve) => holds.push(resolve))
    if (failNext) { failNext = false; return route.fulfill(fail(500, 'C000', '잠시 후 다시 시도해 주세요.')) }
    return route.fulfill(store.save(body))
  })
  const favorites = page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('link', { name: '찜한 매물' })

  await page.goto(editPath)
  await page.getByLabel('상품명').fill('보낸 제목')
  await page.getByRole('button', { name: '수정 저장' }).click()
  await expect(page.getByRole('button', { name: '저장 중' })).toBeDisabled()
  // 저장이 끝나기 전에는 실패할 수 있으므로, 나가려 하면 확인을 거친다.
  await favorites.click()
  await expect(page.getByText('고친 내용을 버릴까요?')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(editPath + '$'))
  await page.getByRole('button', { name: '계속 고치기' }).click()

  holds.shift()?.()
  await expect(page.getByText('잠시 후 다시 시도해 주세요.')).toBeVisible()
  await expect(page.getByLabel('상품명')).toHaveValue('보낸 제목')
  await expect(page).toHaveURL(new RegExp(editPath + '$'))

  // 확인이 떠 있는 동안 저장이 성공하면, 그 이동은 묻지 않고 상세로 간다.
  await page.getByRole('button', { name: '수정 저장' }).click()
  await favorites.click()
  await expect(page.getByText('고친 내용을 버릴까요?')).toBeVisible()
  await expect.poll(() => holds.length).toBe(1)
  holds.shift()?.()
  await expect(page).toHaveURL(detailUrl)
  await expect(page.getByText('매물 정보를 수정했어요.')).toBeVisible()
  expect(sent).toHaveLength(2)
})
