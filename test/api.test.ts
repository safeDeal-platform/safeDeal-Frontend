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

async function freshSession() {
  vi.resetModules();
  return (await import('../src/api')).authSession;
}

test('restoring a session retries a network failure before treating the visitor as signed out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const session = await freshSession();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new TypeError('network down');
      return json({ accessToken: 'restored-token', expiresIn: 1800 });
    });

    const restoring = session.restore();
    await vi.advanceTimersByTimeAsync(2000);
    await restoring;

    assert.equal(attempts, 3);
    assert.equal(session.getSnapshot().authenticated, true);
  } finally {
    vi.useRealTimers();
  }
});

test('a restore that keeps failing on the network is tried again on the next call', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const session = await freshSession();
    let online = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!online) throw new TypeError('network down');
      return json({ accessToken: 'restored-token', expiresIn: 1800 });
    });

    const failing = assert.rejects(session.restore(), { status: 0 });
    await vi.advanceTimersByTimeAsync(2000);
    await failing;
    assert.deepEqual(
      { ready: session.getSnapshot().ready, authenticated: session.getSnapshot().authenticated },
      { ready: true, authenticated: false },
    );

    online = true;
    await session.restore();
    assert.equal(session.getSnapshot().authenticated, true);
  } finally {
    vi.useRealTimers();
  }
});

test('an expired refresh cookie ends the restore without retrying', async () => {
  const session = await freshSession();
  let attempts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    attempts++;
    return Response.json({ success: false, error: { code: 'AUTH007', message: '다시 로그인해 주세요.' } }, { status: 401 });
  });

  await session.restore();
  await session.restore();
  assert.equal(attempts, 1);
  assert.equal(session.getSnapshot().authenticated, false);
});

test('logging out clears the local session even when the server rejects the expired access token', async () => {
  const session = await freshSession();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') {
      return json({
        publicId: '01K1234567890123456789ABCD', nickname: '테스트', role: 'USER',
        emailVerified: true, trustScore: 50, accessToken: 'expired-token', expiresIn: 1,
      });
    }
    return Response.json({ success: false, error: { code: 'AUTH004', message: '만료된 토큰입니다.' } }, { status: 401 });
  });

  await session.login('test@example.test', 'safe-pass');
  await session.logout();
  assert.equal(session.getSnapshot().authenticated, false);
});

test('a logout that cannot reach the server keeps the session so the user can retry', async () => {
  const session = await freshSession();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') {
      return json({
        publicId: '01K1234567890123456789ABCD', nickname: '테스트', role: 'USER',
        emailVerified: true, trustScore: 50, accessToken: 'signed-in-token', expiresIn: 1800,
      });
    }
    throw new TypeError('network down');
  });

  await session.login('test@example.test', 'safe-pass');
  await assert.rejects(session.logout(), { status: 0 });
  assert.equal(session.getSnapshot().authenticated, true);
});

test('listing report sends the LISTING target, omits a blank detail, and cancels by public report id', async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/reports') return json({ reportId: '01JREPORT0000000000000001', status: 'RECEIVED', receivedAt: '2026-11-17T01:00:00Z' }, 201);
    return json(undefined);
  });

  const receipt = await api.reportListing('01JLISTING0000000000000001', 'FRAUD', '   ');
  await api.reportListing('01JLISTING0000000000000001', 'ETC', '가품 같아요');
  await api.cancelReport(receipt.reportId);

  assert.equal(receipt.reportId, '01JREPORT0000000000000001');
  assert.deepEqual(calls, [
    { url: '/api/reports', method: 'POST', body: { targetType: 'LISTING', targetId: '01JLISTING0000000000000001', reasonCode: 'FRAUD' } },
    { url: '/api/reports', method: 'POST', body: { targetType: 'LISTING', targetId: '01JLISTING0000000000000001', reasonCode: 'ETC', detail: '가품 같아요' } },
    { url: '/api/reports/01JREPORT0000000000000001/cancel', method: 'PATCH', body: undefined },
  ]);
});
