export type ListingStatus = 'DRAFT' | 'PENDING_VERIFICATION' | 'ACTIVE' | 'SOLD' | 'BLOCKED' | 'DELETED';
export type ItemCondition = 'NEW' | 'LIKE_NEW' | 'USED' | 'HEAVILY_USED';

export interface Category {
  code: string;
  name: string;
  parentCode: string | null;
  depth: number;
  sortOrder: number;
}

export interface ListingInput {
  title: string;
  price: number;
  categoryCode: string;
  description: string;
  itemCondition: ItemCondition;
  regionSido: string;
  regionSigungu: string;
}

interface ListingRef {
  publicId: string;
  title: string;
  price: number;
  status: ListingStatus;
}

export interface ListingSummary extends ListingRef {
  categoryCode: string;
  regionSido: string;
  regionSigungu: string;
  createdAt: string;
}

export interface ListingDetail extends ListingRef {
  description: string;
  category: { code: string; name: string; parentName: string | null };
  itemCondition: ItemCondition;
  region: { sido: string; sigungu: string };
  viewCount: number;
  createdAt: string;
  version: number;
}

export interface ListingFilters {
  categoryCode?: string;
  regionSido?: string;
  regionSigungu?: string;
  minPrice?: string | number;
  maxPrice?: string | number;
  cursor?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
}

export interface FavoriteSummary {
  listing: ListingRef;
  notifyBasePrice: number;
  favoritedAt: string;
}

export interface PriceStatistics {
  categoryCode: string;
  period: string;
  sampleCount: number;
  medianPrice?: number;
  minPrice?: number;
  maxPrice?: number;
  calculatedAt?: string;
  message?: string;
}

export interface NotificationItem {
  notificationId: number;
  type: string;
  title: string;
  body: string;
  targetType?: string;
  targetId?: string;
  isRead: boolean;
  createdAt: string;
}

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AuthResponse extends TokenResponse {
  publicId: string;
  nickname: string;
  role: string;
  emailVerified: boolean;
  trustScore: number;
}

interface ApiFailure {
  code?: string;
  message?: string;
  fieldErrors?: { field: string; message: string }[];
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors: { field: string; message: string }[];
  readonly requestId?: string;

  constructor(status: number, failure: ApiFailure = {}) {
    super(failure.message || '서버 요청을 완료할 수 없습니다.');
    this.name = 'ApiError';
    this.status = status;
    this.code = failure.code;
    this.fieldErrors = failure.fieldErrors ?? [];
    this.requestId = failure.requestId;
  }
}

interface AuthState {
  authenticated: boolean;
  ready: boolean;
  account: (Omit<AuthResponse, 'emailVerified'> & { emailVerified: boolean | null }) | null;
  sessionKey: number;
}

let authState: AuthState = { authenticated: false, ready: false, account: null, sessionKey: 0 };
let accessToken: string | null = null;
let sessionVersion = 0;
let pendingReissue: Promise<string | null> | null = null;
let sessionWork: Promise<unknown> = Promise.resolve();
const authListeners = new Set<() => void>();

function publishSession(token: string | null, account: AuthState['account']) {
  accessToken = token;
  authState = { authenticated: Boolean(token), ready: true, account, sessionKey: sessionVersion };
  authListeners.forEach((listener) => listener());
}

function serializeAuth<T>(work: () => Promise<T>): Promise<T> {
  const result = sessionWork.then(async (): Promise<T> => {
    // A refresh cookie is shared by same-origin tabs and the server rotates it on each use.
    const locks = globalThis.navigator?.locks;
    return locks ? await locks.request('safedeal-session', work) : work();
  });
  sessionWork = result.catch(() => undefined);
  return result;
}

async function send<T>(path: string, options: RequestInit, token: string | null): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, { message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
  }

  if (response.status === 204) return undefined as T;
  const envelope = await response.json().catch(() => null) as
    { success: boolean; data?: T; error?: ApiFailure } | null;
  if (!response.ok || envelope?.success !== true) {
    throw new ApiError(response.status, envelope?.error);
  }
  return envelope.data as T;
}

function json(method: string, body?: object): RequestInit {
  return body
    ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method };
}

function tokenSubject(token: string | null): unknown {
  try {
    const payload = token?.split('.')[1];
    if (payload) return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub;
  } catch {
    // The token remains opaque except for comparing account continuity across refreshes.
  }
  return undefined;
}

function reissue(): Promise<string | null> {
  if (pendingReissue) return pendingReissue;
  const version = sessionVersion;
  pendingReissue = serializeAuth(async () => {
    if (version !== sessionVersion) return null;
    try {
      const token = await send<TokenResponse>('/api/auth/reissue', json('POST'), null);
      const previousSubject = tokenSubject(accessToken);
      const renewedSubject = tokenSubject(token.accessToken);
      if (previousSubject !== undefined && renewedSubject !== undefined && previousSubject !== renewedSubject) {
        sessionVersion++;
        publishSession(null, null);
        return null;
      }
      publishSession(token.accessToken, authState.account ? { ...authState.account, ...token } : null);
      return token.accessToken;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
      sessionVersion++;
      publishSession(null, null);
      return null;
    }
  }).finally(() => { pendingReissue = null; });
  return pendingReissue;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new TypeError('SafeDeal API 경로가 필요합니다.');
  const token = accessToken;
  const version = sessionVersion;
  try {
    return await send<T>(path, options, token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !token || version !== sessionVersion) throw error;
    options.signal?.throwIfAborted();
    const refreshed = accessToken === token ? await reissue() : accessToken;
    if (!refreshed || version !== sessionVersion) throw error;
    options.signal?.throwIfAborted();
    return send<T>(path, options, refreshed);
  }
}

function signIn(path: '/api/auth/login' | '/api/auth/signup', credentials: object) {
  return serializeAuth(async () => {
    const account = await send<AuthResponse>(path, json('POST', credentials), null);
    sessionVersion++;
    publishSession(account.accessToken, account);
  });
}

export const authSession = {
  getSnapshot: () => authState,
  subscribe(listener: () => void) {
    authListeners.add(listener);
    return () => { authListeners.delete(listener); };
  },
  async restore() {
    if (authState.ready) return;
    try {
      await reissue();
    } finally {
      if (!authState.ready) publishSession(null, null);
    }
  },
  login: (email: string, password: string) => signIn('/api/auth/login', { email, password }),
  signup: (email: string, password: string, nickname: string) =>
    signIn('/api/auth/signup', { email, password, nickname }),
  logout() {
    return serializeAuth(async () => {
      await send<void>('/api/auth/logout', json('POST'), accessToken);
      sessionVersion++;
      publishSession(null, null);
    });
  },
  async verify(token: string) {
    const version = sessionVersion;
    await send<void>('/api/auth/email/verify', json('POST', { token }), null);
    // A public token can verify a different account than the one signed in here.
    if (version === sessionVersion && authState.account?.emailVerified === false) {
      publishSession(accessToken, { ...authState.account, emailVerified: null });
    }
  },
  resend: () => request<void>('/api/auth/email/verify/resend', json('POST')),
  requestReset: (email: string) =>
    send<void>('/api/auth/password/reset-request', json('POST', { email }), null),
  reset: (token: string, newPassword: string) =>
    send<void>('/api/auth/password/reset', json('POST', { token, newPassword }), null),
};

function queryPath(path: string, filters: Record<string, string | number | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  }
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

const listingPath = (id: string) => `/api/listings/${encodeURIComponent(id)}`;

export const api = {
  async categories(signal?: AbortSignal) {
    const result = await request<{ categories: Category[] }>('/api/categories', { signal });
    return result.categories;
  },
  listings(filters: ListingFilters = {}, signal?: AbortSignal) {
    return request<CursorPage<ListingSummary>>(queryPath('/api/listings', { ...filters }), { signal });
  },
  listing(id: string, signal?: AbortSignal) {
    return request<ListingDetail>(listingPath(id), { signal });
  },
  createListing(input: ListingInput) {
    return request<{ publicId: string; status: ListingStatus }>('/api/listings', json('POST', input));
  },
  updateListing(id: string, input: ListingInput & { version: number }) {
    return request<{ publicId: string; status: ListingStatus; version: number }>(listingPath(id), json('PATCH', input));
  },
  changeListingStatus(id: string, action: 'MARK_SOLD' | 'RESTORE_MANUAL_SOLD') {
    return request<{ status: ListingStatus; soldSource: string | null }>(`${listingPath(id)}/status`, json('PATCH', { action }));
  },
  deleteListing(id: string) {
    return request<void>(listingPath(id), json('DELETE'));
  },
  favorites(cursor?: string, signal?: AbortSignal) {
    return request<CursorPage<FavoriteSummary>>(queryPath('/api/users/me/favorites', { cursor }), { signal });
  },
  favorite(id: string, enabled: boolean) {
    return request<{ favorited: boolean }>(`${listingPath(id)}/favorite`, json(enabled ? 'POST' : 'DELETE'));
  },
  createChat(id: string) {
    return request<{ roomId: string; created: boolean; status: ListingStatus }>('/api/chat/rooms', json('POST', { listingId: id }));
  },
  readChat(roomId: string, lastReadMessageId: number) {
    return request<{ lastReadMessageId: number }>(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, json('PATCH', { lastReadMessageId }));
  },
  priceStatistics(categoryCode: string, period: '7d' | '30d', signal?: AbortSignal) {
    return request<PriceStatistics>(queryPath('/api/price-statistics', { categoryCode, period }), { signal });
  },
  notifications(sinceId?: number, signal?: AbortSignal) {
    return request<{ items: NotificationItem[]; latestId: number | null }>(
      queryPath('/api/notifications', { sinceId }), { signal },
    );
  },
  unreadNotifications(signal?: AbortSignal) {
    return request<{ unreadCount: number }>('/api/notifications/unread-count', { signal });
  },
  readNotification(id: number) {
    return request<void>(`/api/notifications/${encodeURIComponent(id)}/read`, json('PATCH'));
  },
};
