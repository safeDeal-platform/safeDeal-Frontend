import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// 백엔드 #56(카카오 로그인)의 응답을 재현한다. 시작 주소는 원래 카카오 동의 화면으로 302를 보내지만, 테스트에서는
// 카카오를 다녀왔다고 치고 백엔드 콜백이 마지막에 보내는 프런트 주소(/oauth/callback?...)로 바로 보낸다.
const me = { publicId: '01JKAKAO000000000000000001', nickname: '민수네가게', role: 'USER', emailVerified: true, trustScore: 50, accessToken: 'kakao-access', expiresIn: 900 }
const token = { success: true, data: { accessToken: 'kakao-access', expiresIn: 900 } }
const noRefresh = { status: 401, json: { success: false, error: { code: 'AUTH007', message: '인증 정보가 없습니다. 다시 로그인해 주세요.' } } }
const RETURN_KEY = 'safedeal:kakao-return'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: { success: false, error: { code: 'C005', message: '로그인이 필요합니다.' } } }))
  await page.route('**/api/categories', (route) => route.fulfill({ json: { success: true, data: { categories: [] } } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { success: true, data: { unreadCount: 0 } } }))
  await page.route((url) => url.pathname === '/api/listings', (route) => route.fulfill({ json: { success: true, data: { items: [], nextCursor: null, hasNext: false } } }))
  await page.route('**/api/users/me/favorites*', (route) => route.fulfill({ json: { success: true, data: { items: [], nextCursor: null, hasNext: false } } }))
  await page.route((url) => url.pathname === '/api/users/me', (route) => route.fulfill({ json: { success: true, data: me } }))
})

/** 카카오 시작 주소를 누르면 백엔드가 결국 보내는 프런트 주소로 302. 눌렸는지는 반환값으로 본다. */
async function kakaoReturnsTo(page: Page, frontendPath: string) {
  const started = { count: 0 }
  await page.route('**/api/auth/oauth/kakao', (route) => {
    started.count++
    return route.fulfill({ status: 302, headers: { location: frontendPath } })
  })
  return started
}

test('로그인 화면에서 카카오로 로그인하면 떠나기 전에 보던 화면으로 로그인한 채 돌아온다', async ({ page }) => {
  const started = await kakaoReturnsTo(page, '/oauth/callback?result=login')
  // 카카오를 다녀오기 전에는 refresh 쿠키가 없고, 다녀온 뒤에는 백엔드가 심어 둔 쿠키로 재발급된다.
  await page.route('**/api/auth/reissue', (route) => started.count > 0 ? route.fulfill({ json: token }) : route.fulfill(noRefresh))

  await page.goto('/login?returnTo=/favorites')
  const kakao = page.getByRole('link', { name: '카카오로 시작하기' })
  // fetch가 아니라 화면 이동이어야 백엔드가 state 쿠키를 심고 카카오로 302를 보낼 수 있다.
  await expect(kakao).toHaveAttribute('href', '/api/auth/oauth/kakao')
  await kakao.click()

  await expect(page).toHaveURL(/\/favorites$/)
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
  expect(started.count).toBe(1)
  expect(await page.evaluate((key) => sessionStorage.getItem(key), RETURN_KEY)).toBeNull()
})

test('처음 온 사용자는 닉네임만 정해 가입하고, 닉네임이 겹치거나 새로고침해도 같은 화면에서 마칠 수 있다', async ({ page }) => {
  await kakaoReturnsTo(page, '/oauth/callback?result=signup')
  await page.route('**/api/auth/reissue', (route) => route.fulfill(noRefresh))
  const bodies: unknown[] = []
  await page.route('**/api/auth/oauth/kakao/signup', (route) => {
    bodies.push(route.request().postDataJSON())
    return bodies.length === 1
      ? route.fulfill({ status: 409, json: { success: false, error: { code: 'AUTH002', message: '이미 사용 중인 닉네임입니다.' } } })
      : route.fulfill({ status: 201, json: { success: true, data: me } })
  })

  await page.goto('/signup?returnTo=/favorites')
  await page.getByRole('link', { name: '카카오로 시작하기' }).click()
  await expect(page).toHaveURL(/\/oauth\/callback\?result=signup$/)
  await expect(page.getByRole('heading', { name: '닉네임 정하기' })).toBeVisible()

  await page.getByRole('textbox', { name: '닉네임' }).fill('민수네가게')
  await page.getByRole('button', { name: '가입 마치기' }).click()
  await expect(page.getByRole('alert')).toHaveText('이미 사용 중인 닉네임입니다.')

  // 가입 티켓 쿠키는 10분 동안 살아 있으니, 새로고침해도 폼이 다시 떠야 한다.
  await page.reload()
  await expect(page.getByRole('heading', { name: '닉네임 정하기' })).toBeVisible()
  await page.getByRole('textbox', { name: '닉네임' }).fill('민수네가게2')
  await page.getByRole('button', { name: '가입 마치기' }).click()

  await expect(page).toHaveURL(/\/favorites$/)
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
  expect(bodies).toEqual([{ nickname: '민수네가게' }, { nickname: '민수네가게2' }])
})

test('가입 티켓이 만료되면 폼을 닫고 카카오 로그인을 다시 시작하게 한다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill(noRefresh))
  await page.route('**/api/auth/oauth/kakao/signup', (route) => route.fulfill({ status: 400, json: { success: false, error: { code: 'AUTH016', message: '가입 요청이 만료되었습니다. 카카오 로그인을 다시 진행해 주세요.' } } }))

  await page.goto('/oauth/callback?result=signup')
  await page.getByRole('textbox', { name: '닉네임' }).fill('민수네가게')
  await page.getByRole('button', { name: '가입 마치기' }).click()

  await expect(page.getByRole('alert')).toHaveText('가입 요청이 만료됐어요. 카카오 로그인을 다시 시작해 주세요.')
  await expect(page.getByRole('textbox', { name: '닉네임' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '카카오로 시작하기' })).toBeVisible()
})

test('이미 로그인한 사람이 가입 주소를 다시 열면 폼을 띄우지 않고 가입 요청도 보내지 않는다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: token }))
  let signups = 0
  await page.route('**/api/auth/oauth/kakao/signup', (route) => { signups++; return route.fulfill({ status: 201, json: { success: true, data: me } }) })

  await page.goto('/oauth/callback?result=signup')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '닉네임' })).toHaveCount(0)
  expect(signups).toBe(0)
})

test('카카오 화면에서 취소하면 이유를 안내하고 주소에서 오류 코드를 지워도 새로고침에 안내가 남는다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill(noRefresh))
  await page.goto('/oauth/callback?error=AUTH013')

  await expect(page.getByRole('alert')).toHaveText('카카오 로그인을 취소했어요.')
  await expect(page).toHaveURL(/\/oauth\/callback$/)
  await page.reload()
  await expect(page.getByRole('alert')).toHaveText('카카오 로그인을 취소했어요.')
  await expect(page.getByRole('link', { name: '카카오로 시작하기' })).toBeVisible()
  await expect(page.getByRole('link', { name: '이메일로 로그인' })).toBeVisible()
})

test('같은 이메일 계정에 연결할 수 없으면 기존 계정 로그인으로 안내하고, 모르는 코드는 그대로 보여 주지 않는다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill(noRefresh))
  await page.goto('/oauth/callback?error=AUTH015')
  await expect(page.getByRole('alert')).toHaveText('이 이메일로 가입된 계정과 카카오 계정을 연결할 수 없어요. 기존 계정으로 로그인해 주세요.')

  await page.goto('/oauth/callback?error=' + encodeURIComponent('<b>가짜 안내</b>'))
  await expect(page.getByRole('alert')).toHaveText('서버에 문제가 생겨 카카오 로그인을 마치지 못했어요. 잠시 후 다시 시도해 주세요.')
  await expect(page.getByText('가짜 안내')).toHaveCount(0)
})

test('돌아온 뒤 재발급이 안 되면 로그인된 척하지 않고 다시 시작하게 한다', async ({ page }) => {
  await page.route('**/api/auth/reissue', (route) => route.fulfill(noRefresh))
  await page.goto('/oauth/callback?result=login')

  await expect(page.getByRole('alert')).toContainText('로그인을 마무리하지 못했어요.')
  await expect(page.getByRole('link', { name: '카카오로 시작하기' })).toBeVisible()
  await expect(page.getByRole('link', { name: '로그인', exact: true })).toBeVisible()
})

test('저장해 둔 돌아갈 주소가 다른 사이트를 가리키면 홈으로 보낸다', async ({ page }) => {
  await page.addInitScript((key) => sessionStorage.setItem(key, '//evil.example/steal'), RETURN_KEY)
  await page.route('**/api/auth/reissue', (route) => route.fulfill({ json: token }))
  await page.goto('/oauth/callback?result=login')

  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4173\/$/)
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
})
