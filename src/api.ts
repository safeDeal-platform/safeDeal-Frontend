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

/** 찜 목록의 매물. 제재·삭제 매물이면 백엔드가 제목·가격을 비워 보낼 수 있다(요청 중). 프런트는 값이 와도 보여 주지 않는다. */
interface FavoriteListingRef extends Omit<ListingRef, 'title' | 'price'> {
  title: string | null;
  price: number | null;
}

// Fields marked "requested" are in the API spec but not yet returned by the backend.
// Screens render them only when the server sends them and never fill them in.
export interface ListingSummary extends ListingRef {
  categoryCode: string;
  regionSido: string;
  regionSigungu: string;
  createdAt: string;
  thumbnailUrl?: string | null; // requested
  verificationBadge?: string | null; // requested
}

export interface ListingSeller {
  publicId: string;
  nickname: string;
  trustScore: number;
}

export interface ListingDetail extends ListingRef {
  description: string;
  category: { code: string; name: string; parentName: string | null };
  itemCondition: ItemCondition;
  region: { sido: string; sigungu: string };
  viewCount: number;
  createdAt: string;
  version: number;
  images?: { url: string; isPrimary?: boolean }[]; // requested
  verificationBadge?: string | null; // requested
  seller: ListingSeller | null; // null when the seller withdrew or the row is missing
  favoriteCount: number; // 0 when nobody favorited it; includes the seller's own favorite
  favorited: boolean | null; // null whenever the server treated the request as anonymous
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
  listing: FavoriteListingRef;
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

/** GET /api/users/me. 본인 조회라 이메일 원문이 온다. 역할(role)은 이 응답에 없다. */
export interface MyProfile {
  publicId: string;
  email: string;
  nickname: string;
  emailVerified: boolean;
  trustScore: number;
  createdAt: string;
}

/** 로그인 응답과 /me 응답을 합친 계정. 어느 쪽에서 왔는지에 따라 빠지는 필드가 있다. */
export interface Account {
  publicId: string;
  nickname: string;
  trustScore: number;
  /** null = 확인하지 못함(다른 계정의 인증 링크를 연 직후 등) */
  emailVerified: boolean | null;
  role?: string;
  email?: string;
  createdAt?: string;
}

interface AuthState {
  authenticated: boolean;
  ready: boolean;
  account: Account | null;
  sessionKey: number;
  /** 로그인은 됐는데 /me를 불러오지 못함(네트워크·서버 오류). 다시 불러오기를 보여 준다. */
  profileError: boolean;
  /** /me가 정지 계정(403)이라 세션을 끝냈음. 다음 로그인 시도 전까지 로그인 화면에 이유를 보여 준다. */
  restricted: boolean;
}

let authState: AuthState = {
  authenticated: false, ready: false, account: null, sessionKey: 0, profileError: false, restricted: false,
};
let accessToken: string | null = null;
let sessionVersion = 0;
let pendingReissue: Promise<string | null> | null = null;
let sessionWork: Promise<unknown> = Promise.resolve();
// True while the last restore attempt ended on a network or server failure rather than an auth answer.
let restoreUnresolved = false;
// 내 정보 조회 순번. 늦게 도착한 옛 응답이 최신 응답을 덮지 않게 한다.
let profileTicket = 0;
const RESTORE_RETRY_DELAYS_MS = [500, 1500];
const authListeners = new Set<() => void>();

function publishSession(
  token: string | null,
  account: Account | null,
  flags: { profileError?: boolean; restricted?: boolean } = {},
) {
  accessToken = token;
  authState = {
    authenticated: Boolean(token), ready: true, account, sessionKey: sessionVersion,
    profileError: flags.profileError ?? false,
    // 정지 안내는 다음 로그인 시도까지 남긴다. 세션이 다시 생기면 지운다.
    restricted: token ? false : (flags.restricted ?? authState.restricted),
  };
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
      // 기다리는 사이 /me가 세션을 끝냈을 수 있다(정지·탈퇴). 끝난 세션의 토큰은 되살리지 않는다.
      if (version !== sessionVersion) return null;
      const previousSubject = tokenSubject(accessToken);
      const renewedSubject = tokenSubject(token.accessToken);
      if (previousSubject !== undefined && renewedSubject !== undefined && previousSubject !== renewedSubject) {
        sessionVersion++;
        publishSession(null, null);
        return null;
      }
      // 같은 세션의 토큰만 바뀐 것이라, 내 정보 조회 실패 표시(재시도 버튼)는 그대로 둔다.
      publishSession(token.accessToken, authState.account ? { ...authState.account, ...token } : null,
        { profileError: authState.profileError });
      return token.accessToken;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
      if (version !== sessionVersion) return null;
      sessionVersion++;
      // 정지 계정(AUTH005)이면 로그인 화면에 이유를 남긴다. 그 밖의 401·403은 조용히 끝낸다.
      publishSession(null, null, { restricted: error.code === 'AUTH005' });
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

/**
 * 지금 세션의 내 정보를 불러와 계정에 합친다. 새로고침 뒤에는 재발급 응답에 계정이 없어서 이것으로 채운다.
 * - 응답이 오기 전에 로그아웃·다른 계정 로그인이 끼면 그 응답은 버린다(sessionVersion·토큰 비교).
 * - 401은 request()가 재발급까지 해 보고도 안 된 것이라 세션을 끝낸다(탈퇴 직후 남은 토큰, AUTH004).
 * - 403 + AUTH005(정지 계정): 세션을 끝내고 로그인 화면에 이유를 남긴다(reissue와 같은 기준).
 * - 그 밖의 실패(다른 403, 네트워크·5xx)는 로그인을 유지하고 profileError만 켠다.
 */
async function loadProfile(): Promise<void> {
  const version = sessionVersion;
  // 조회가 겹치면(복구와 포커스 복구, 인증 직후 재조회) 마지막에 보낸 요청의 답만 반영한다.
  const ticket = ++profileTicket;
  const stale = () => version !== sessionVersion || ticket !== profileTicket || !accessToken;
  if (!accessToken) return;
  try {
    const me = await request<MyProfile>('/api/users/me');
    if (stale()) return;
    publishSession(accessToken, { ...authState.account, ...me });
  } catch (error) {
    if (stale()) return;
    const suspended = error instanceof ApiError && error.status === 403 && error.code === 'AUTH005';
    if (suspended || (error instanceof ApiError && error.status === 401)) {
      sessionVersion++;
      publishSession(null, null, { restricted: suspended });
      return;
    }
    publishSession(accessToken, authState.account, { profileError: true });
  }
}

function signIn(path: '/api/auth/login' | '/api/auth/signup', credentials: object) {
  return serializeAuth(async () => {
    const account = await send<AuthResponse>(path, json('POST', credentials), null);
    sessionVersion++;
    restoreUnresolved = false;
    publishSession(account.accessToken, account);
  });
}

export const authSession = {
  getSnapshot: () => authState,
  subscribe(listener: () => void) {
    authListeners.add(listener);
    return () => { authListeners.delete(listener); };
  },
  /**
   * Restores the session from the refresh cookie. A network or server failure is retried briefly;
   * if it still fails, the screen continues signed out and a later call (on focus or reconnect) tries again.
   */
  async restore() {
    if (authState.ready && !restoreUnresolved) return;
    const version = sessionVersion;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await reissue();
          restoreUnresolved = false;
          // 재발급 응답에는 계정이 없다. 새로고침 직후(account 없음)에만 /me로 채운다.
          if (accessToken && !authState.account) await loadProfile();
          return;
        } catch (error) {
          if (attempt >= RESTORE_RETRY_DELAYS_MS.length) {
            restoreUnresolved = true;
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, RESTORE_RETRY_DELAYS_MS[attempt]));
        if (version !== sessionVersion) {
          restoreUnresolved = false;
          return;
        }
      }
    } finally {
      if (!authState.ready) publishSession(null, null);
    }
  },
  login: (email: string, password: string) => signIn('/api/auth/login', { email, password }),
  signup: (email: string, password: string, nickname: string) =>
    signIn('/api/auth/signup', { email, password, nickname }),
  logout() {
    return serializeAuth(async () => {
      try {
        await send<void>('/api/auth/logout', json('POST'), accessToken);
      } catch (error) {
        // The server already treats this session as ended; only a network or server failure keeps it.
        if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
      }
      sessionVersion++;
      restoreUnresolved = false;
      publishSession(null, null);
    });
  },
  async verify(token: string) {
    const version = sessionVersion;
    await send<void>('/api/auth/email/verify', json('POST', { token }), null);
    // A public token can verify a different account than the one signed in here.
    if (version === sessionVersion && accessToken) {
      if (authState.account?.emailVerified === false) {
        publishSession(accessToken, { ...authState.account, emailVerified: null });
      }
      // 어느 계정이 인증됐는지는 서버만 안다. 계정을 아직 못 읽었어도 다시 읽고,
      // 인증 전에 보낸 조회의 답은 순번으로 버린다.
      await loadProfile();
    }
  },
  /** 마이페이지의 '다시 불러오기'. 로그인 상태가 아니면 아무것도 하지 않는다. */
  reloadProfile: () => loadProfile(),
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

/** 매물에 붙일 수 있는 신고 사유. ABUSE(욕설)는 채팅 전용이라 매물 신고에는 없다. */
export type ListingReportReason = 'FRAUD' | 'PROHIBITED' | 'SPAM' | 'IMPERSONATION' | 'ETC';
export type ReportStatus = 'RECEIVED' | 'REVIEWING' | 'RESOLVED' | 'REJECTED' | 'CANCELLED';
export interface ReportReceipt {
  reportId: string;
  status: ReportStatus;
  receivedAt: string;
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
  reportListing(listingId: string, reasonCode: ListingReportReason, detail: string) {
    const body = { targetType: 'LISTING', targetId: listingId, reasonCode, ...(detail.trim() ? { detail } : {}) };
    return request<ReportReceipt>('/api/reports', json('POST', body));
  },
  cancelReport(reportId: string) {
    return request<void>(`/api/reports/${encodeURIComponent(reportId)}/cancel`, json('PATCH'));
  },
};
