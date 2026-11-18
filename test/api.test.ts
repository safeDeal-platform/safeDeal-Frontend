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

async function freshModule() {
  vi.resetModules();
  return import('../src/api');
}

async function freshSession() {
  vi.resetModules();
  return (await import('../src/api')).authSession;
}

test('restoring a session retries a network failure before treating the visitor as signed out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const session = await freshSession();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/users/me') return json({ publicId: '01K1234567890123456789ABCD', nickname: '테스트', emailVerified: true, trustScore: 50 });
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!online) throw new TypeError('network down');
      if (url === '/api/users/me') return json({ publicId: '01K1234567890123456789ABCD', nickname: '테스트', emailVerified: true, trustScore: 50 });
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

const signedInProfile = {
  publicId: '01K1234567890123456789ABCD', email: 'seller@example.test', nickname: '판매자',
  emailVerified: true, trustScore: 72.5, createdAt: '2026-08-01T00:00:00Z',
};

test('a restored session loads the profile so the account survives a page refresh', async () => {
  const session = await freshSession();
  const meTokens: (string | null)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    if (url === '/api/users/me') {
      meTokens.push(new Headers(init?.headers).get('Authorization'));
      return json(signedInProfile);
    }
    throw new Error(`unexpected ${String(url)}`);
  });

  await session.restore();
  const snapshot = session.getSnapshot();
  assert.deepEqual(meTokens, ['Bearer restored-token']);
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.account?.publicId, signedInProfile.publicId);
  assert.equal(snapshot.account?.email, 'seller@example.test');
  assert.equal(snapshot.profileError, false);
});

test('a profile that cannot be loaded keeps the session and can be loaded again', async () => {
  const session = await freshSession();
  let online = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    if (!online) throw new TypeError('network down');
    return json(signedInProfile);
  });

  await session.restore();
  assert.equal(session.getSnapshot().authenticated, true);
  assert.equal(session.getSnapshot().account, null);
  assert.equal(session.getSnapshot().profileError, true);

  online = true;
  await session.reloadProfile();
  assert.equal(session.getSnapshot().account?.nickname, '판매자');
  assert.equal(session.getSnapshot().profileError, false);
});

test('a suspended account found while loading the profile ends the session and says why', async () => {
  const session = await freshSession();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    return Response.json({ success: false, error: { code: 'AUTH005', message: '이용이 제한된 계정입니다.' } }, { status: 403 });
  });

  await session.restore();
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().restricted, true);
});

test('a profile answer that arrives after logging out is discarded', async () => {
  const session = await freshSession();
  let answerProfile: (response: Response) => void = () => {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    if (url === '/api/auth/logout') return json(undefined);
    return new Promise<Response>((resolve) => { answerProfile = resolve; });
  });

  const restoring = session.restore();
  await vi.waitFor(() => assert.equal(session.getSnapshot().authenticated, true));
  await session.logout();
  answerProfile(json(signedInProfile));
  await restoring;
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().account, null);
});

test('verifying the signed-in account email reloads the profile instead of leaving it unknown', async () => {
  const session = await freshSession();
  let verified = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') {
      return json({ ...signedInProfile, role: 'USER', emailVerified: false, accessToken: 'signed-in-token', expiresIn: 1800 });
    }
    if (url === '/api/auth/email/verify') { verified = true; return json(undefined); }
    if (url === '/api/users/me') return json({ ...signedInProfile, emailVerified: verified });
    return json(undefined);
  });

  await session.login('seller@example.test', 'safe-pass');
  await session.verify('mail-token');
  assert.equal(session.getSnapshot().account?.emailVerified, true);
});

const loginAccount = { ...signedInProfile, role: 'USER', accessToken: 'signed-in-token', expiresIn: 1800 };
const deferred = () => { let resolve: (r: Response) => void = () => {}; const promise = new Promise<Response>((r) => { resolve = r; }); return { promise, resolve }; };
const failure = (status: number, code: string) => Response.json({ success: false, error: { code, message: code } }, { status });

test('a token reissue that finishes after the session ended does not bring the session back', async () => {
  const { authSession: session, request: freshRequest } = await freshModule();
  const reissue = deferred();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') return json(loginAccount);
    if (url === '/api/auth/reissue') return reissue.promise;
    if (url === '/api/users/me') return failure(403, 'AUTH005');
    return failure(401, 'AUTH001');
  });

  await session.login('seller@example.test', 'safe-pass');
  const pending = freshRequest('/api/notifications').catch(() => undefined);
  await vi.waitFor(() => assert.ok(vi.mocked(fetch).mock.calls.some(([u]) => u === '/api/auth/reissue')));
  await session.reloadProfile();
  reissue.resolve(json({ accessToken: 'late-token', expiresIn: 1800 }));
  await pending;
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().restricted, true);
});

test('a reissue refused for a suspended account records why the session ended', async () => {
  const { authSession: session, request: freshRequest } = await freshModule();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') return json(loginAccount);
    if (url === '/api/auth/reissue') return failure(403, 'AUTH005');
    return failure(401, 'AUTH001');
  });

  await session.login('seller@example.test', 'safe-pass');
  await assert.rejects(freshRequest('/api/notifications'), { status: 401 });
  assert.equal(session.getSnapshot().authenticated, false);
  assert.equal(session.getSnapshot().restricted, true);
});

test('a token reissue keeps the profile error so the retry button stays', async () => {
  const { authSession: session, request: freshRequest } = await freshModule();
  let reissued = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === '/api/auth/reissue') return json({ accessToken: `token-${++reissued}`, expiresIn: 1800 });
    if (url === '/api/users/me') return failure(503, 'C500');
    const token = new Headers(init?.headers).get('Authorization');
    return token === 'Bearer token-1' ? failure(401, 'AUTH001') : json([]);
  });

  await session.restore();
  assert.equal(session.getSnapshot().profileError, true);
  await freshRequest('/api/notifications');
  assert.equal(reissued, 2);
  assert.equal(session.getSnapshot().profileError, true);
});

test('only the latest profile answer is kept when two profile reads overlap', async () => {
  const session = await freshSession();
  const first = deferred();
  let reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/login') return json({ ...loginAccount, emailVerified: false });
    if (url === '/api/users/me') return ++reads === 1 ? first.promise : json({ ...signedInProfile, emailVerified: true });
    return json(undefined);
  });

  await session.login('seller@example.test', 'safe-pass');
  const older = session.reloadProfile();
  await session.reloadProfile();
  first.resolve(json({ ...signedInProfile, emailVerified: false }));
  await older;
  assert.equal(session.getSnapshot().account?.emailVerified, true);
});

test('verifying email while the first profile read is still pending reloads the profile anyway', async () => {
  const session = await freshSession();
  const first = deferred();
  let reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    if (url === '/api/auth/email/verify') return json(undefined);
    if (url === '/api/users/me') return ++reads === 1 ? first.promise : json({ ...signedInProfile, emailVerified: true });
    return json(undefined);
  });

  const restoring = session.restore();
  await vi.waitFor(() => assert.equal(reads, 1));
  await session.verify('mail-token');
  first.resolve(json({ ...signedInProfile, emailVerified: false }));
  await restoring;
  assert.equal(session.getSnapshot().account?.emailVerified, true);
});

test('a 403 on the profile that is not a suspension keeps the session and offers a retry', async () => {
  const session = await freshSession();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/auth/reissue') return json({ accessToken: 'restored-token', expiresIn: 1800 });
    return failure(403, 'C006');
  });

  await session.restore();
  assert.equal(session.getSnapshot().authenticated, true);
  assert.equal(session.getSnapshot().restricted, false);
  assert.equal(session.getSnapshot().profileError, true);
});
