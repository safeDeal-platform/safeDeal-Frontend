import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { api, authSession, request } from '../src/api';

afterEach(() => vi.restoreAllMocks());

const json = (data: unknown, status = 200) =>
  Response.json({ success: status < 400, data }, { status });

test('listing filters keep the server cursor opaque and omit empty parameters', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    assert.equal(url, '/api/listings?regionSido=%EC%84%9C%EC%9A%B8&minPrice=1000&cursor=A%2B%2F%3D');
    return json({ items: [], nextCursor: null, hasNext: false });
  });

  const page = await api.listings({ regionSido: '서울', regionSigungu: '', minPrice: '1000', cursor: 'A+/=' });
  assert.deepEqual(page, { items: [], nextCursor: null, hasNext: false });
});

test('two requests rejected for an expired access token share one cookie rotation', async () => {
  const signIn = {
    publicId: '01K1234567890123456789ABCD', nickname: '테스트', role: 'USER',
    emailVerified: true, trustScore: 50, accessToken: 'expired-token', expiresIn: 1,
  };
  let rotations = 0;
  const retries: string[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const token = new Headers(init?.headers).get('Authorization');
    if (url === '/api/auth/login') return json(signIn);
    if (url === '/api/auth/logout') return json(undefined);
    if (url === '/api/auth/reissue') {
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(token, null);
      rotations++;
      return json({ accessToken: 'fresh-token', expiresIn: 1800 });
    }
    if (token === 'Bearer expired-token') return json(null, 401);
    assert.equal(token, 'Bearer fresh-token');
    retries.push(url);
    return json(url);
  });

  await authSession.login('test@example.test', 'safe-pass');
  try {
    const results = await Promise.all([request<string>('/api/one'), request<string>('/api/two')]);
    assert.deepEqual(results, ['/api/one', '/api/two']);
    assert.deepEqual(retries.sort(), ['/api/one', '/api/two']);
    assert.equal(rotations, 1);
    assert.equal(authSession.getSnapshot().account?.nickname, '테스트');
  } finally {
    await authSession.logout();
  }
});

test('an anonymous 401 reports the error without attempting cookie rotation', async () => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(String(url));
    return Response.json({ success: false, error: { code: 'AUTH007', message: '다시 로그인해 주세요.' } }, { status: 401 });
  });

  await assert.rejects(request('/api/users/me/favorites'), { status: 401, code: 'AUTH007' });
  assert.deepEqual(urls, ['/api/users/me/favorites']);
});

test('verifying a public email token leaves the signed-in account verification status unknown', async () => {
  const account = {
    publicId: '01K1234567890123456789ABCD', nickname: '테스트', role: 'USER',
    emailVerified: false, trustScore: 50, accessToken: 'signed-in-token', expiresIn: 1800,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') return json(account);
    return json(undefined);
  });

  await authSession.login('test@example.test', 'safe-pass');
  try {
    await authSession.verify('public-token');
    const snapshot = authSession.getSnapshot();
    assert.equal(snapshot.authenticated, true);
    assert.equal(snapshot.account?.nickname, '테스트');
    assert.equal(snapshot.account?.emailVerified, null);
  } finally {
    await authSession.logout();
  }
});
