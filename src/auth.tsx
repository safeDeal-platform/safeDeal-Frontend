import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authSession } from './api';
import './auth.css';

type AuthContextValue = ReturnType<typeof authSession.getSnapshot> & { logout: typeof authSession.logout };
type AuthPageKind = 'login' | 'signup' | 'verify' | 'reset-request' | 'reset';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(authSession.subscribe, authSession.getSnapshot, authSession.getSnapshot);

  useEffect(() => {
    const restore = () => {
      void authSession.restore().catch(() => {
        // Public screens stay available when the server cannot restore a session.
      });
    };
    restore();
    // Retry a restore that failed on the network once the tab regains focus or connectivity.
    window.addEventListener('online', restore);
    window.addEventListener('focus', restore);
    return () => {
      window.removeEventListener('online', restore);
      window.removeEventListener('focus', restore);
    };
  }, []);

  return <AuthContext.Provider value={{ ...state, logout: authSession.logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider가 필요합니다.');
  return value;
}

/** 내 정보(/me)를 읽는 중이면 안내, 읽기에 실패했으면 '다시 불러오기'. 계정이 이미 있어도 실패면 버튼을 보여 준다. */
export function ProfileLoadState() {
  const { profileError } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!profileError) return <p className="muted" role="status">내 정보를 불러오고 있어요.</p>;
  return (
    <p className="muted" role="alert">
      내 정보를 불러오지 못했어요.{' '}
      <button type="button" className="button" disabled={busy} onClick={() => {
        setBusy(true);
        void authSession.reloadProfile().finally(() => setBusy(false));
      }}>{busy ? '불러오는 중' : '다시 불러오기'}</button>
    </p>
  );
}

const titles: Record<AuthPageKind, string> = {
  login: '로그인',
  signup: '회원가입',
  verify: '이메일 인증',
  'reset-request': '비밀번호 찾기',
  reset: '새 비밀번호 설정',
};

export function safeReturnTarget(from: unknown, queryTarget: string | null) {
  let target: unknown = from;
  if (from && typeof from === 'object' && 'pathname' in from) {
    const pathname = typeof from.pathname === 'string' ? from.pathname : '';
    const search = 'search' in from && typeof from.search === 'string' ? from.search : '';
    const hash = 'hash' in from && typeof from.hash === 'string' ? from.hash : '';
    target = pathname + search + hash;
  }
  if (typeof target !== 'string') target = queryTarget;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return '/';
  if (Array.from(target).some((character) => character === '\\' || character.charCodeAt(0) < 32)) return '/';
  // Returning to an account screen after signing in would only show the form again.
  if (AUTH_PATHS.has(target.split(/[?#]/)[0].replace(/\/+$/, '') || '/')) return '/';
  return target;
}

const AUTH_PATHS = new Set([
  '/login', '/signup', '/email/verify', '/auth/email/verify',
  '/password/reset-request', '/password/reset', '/auth/password/reset', '/oauth/callback',
]);

// 백엔드는 카카오에서 돌아올 주소를 /oauth/callback 하나로 고정한다(요청값으로 받으면 오픈 리다이렉트 통로가 된다).
// 그래서 떠나기 전에 보던 화면을 이 탭의 저장소에 적어 두고, 돌아와서 safeReturnTarget으로 다시 검사해 쓴다.
const KAKAO_RETURN_KEY = 'safedeal:kakao-return';

export function readKakaoReturn() {
  try {
    return safeReturnTarget(sessionStorage.getItem(KAKAO_RETURN_KEY), null);
  } catch {
    return '/';
  }
}

export function forgetKakaoReturn() {
  try {
    sessionStorage.removeItem(KAKAO_RETURN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the screen then returns home.
  }
}

/**
 * 카카오 로그인 시작. fetch가 아니라 화면 이동이어야 한다: 백엔드가 state 쿠키를 심고 카카오 동의 화면으로
 * 302를 보내는데, fetch는 그 302를 따라 kauth.kakao.com까지 가다 CORS로 막힌다.
 */
export function KakaoStartButton({ returnTarget }: { returnTarget: string }) {
  return (
    <a className="button kakao" href="/api/auth/oauth/kakao" onClick={() => {
      try {
        sessionStorage.setItem(KAKAO_RETURN_KEY, returnTarget);
      } catch {
        // Without storage the login still works and lands on the home screen.
      }
    }}>카카오로 시작하기</a>
  );
}

export function feedback(error: unknown) {
  if (error instanceof ApiError) return error.fieldErrors[0]?.message || error.message;
  if (error instanceof Error) return error.message;
  return '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function AuthPage({ kind }: { kind: AuthPageKind }) {
  return <AuthScreen key={kind} kind={kind} />;
}

function AuthScreen({ kind }: { kind: AuthPageKind }) {
  const { authenticated, account, restricted, profileError } = useAuth();
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTarget = safeReturnTarget(location.state?.from, search.get('returnTo'));
  const returnState = { from: returnTarget };
  const token = search.get('token')?.trim() || '';
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);

  function clearTokenFromUrl() {
    const next = new URLSearchParams(search);
    next.delete('token');
    const query = next.toString();
    navigate({ pathname: location.pathname, search: query ? `?${query}` : '' }, {
      replace: true,
      state: location.state,
    });
  }

  async function act(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setMessage('');
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(feedback(failure));
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const nickname = String(data.get('nickname') ?? '').trim();

    await act(async () => {
      if (kind === 'signup' || kind === 'reset') {
        if (password !== data.get('passwordConfirmation')) throw new Error('비밀번호 확인이 일치하지 않습니다.');
        if (new TextEncoder().encode(password).length > 72) throw new Error('비밀번호는 UTF-8 기준 72바이트까지 입력할 수 있습니다.');
      }
      switch (kind) {
        case 'login':
          await authSession.login(email, password);
          navigate(returnTarget, { replace: true });
          break;
        case 'signup':
          await authSession.signup(email, password, nickname);
          navigate('/email/verify', { replace: true, state: returnState });
          break;
        case 'reset-request':
          await authSession.requestReset(email);
          setMessage('등록된 이메일이라면 비밀번호 재설정 링크를 보내드립니다.');
          setCompleted(true);
          break;
        case 'reset':
          await authSession.reset(token, password);
          setMessage('새 비밀번호를 저장했습니다. 로그인해 주세요.');
          setCompleted(true);
          clearTokenFromUrl();
          break;
        case 'verify':
          break;
      }
    });
  }

  async function verify() {
    await act(async () => {
      await authSession.verify(token);
      setMessage('이메일 인증을 완료했습니다.');
      setCompleted(true);
      clearTokenFromUrl();
    });
  }

  async function resend() {
    await act(async () => {
      await authSession.resend();
      setMessage('인증 메일을 다시 보냈습니다.');
    });
  }

  // A signed-in visitor has nothing to do on these forms. While a submit is pending the form
  // navigates on its own (signup continues to email verification), so the redirect waits.
  if (authenticated && !pending && (kind === 'login' || kind === 'signup')) {
    return <Navigate to={returnTarget} replace />;
  }

  const passwordFields = kind === 'signup' || kind === 'reset';
  const showsForm = kind !== 'verify' && !completed && (kind !== 'reset' || Boolean(token));

  return (
    <section className="auth-panel panel stack" aria-labelledby="auth-title">
      <header>
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1 id="auth-title">{titles[kind]}</h1>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="auth-message" role="status">{message}</p>}
      {kind === 'login' && restricted && !error && (
        <p className="error" role="alert">이용이 제한된 계정이라 로그인 상태를 끝냈어요. 자세한 내용은 고객센터로 문의해 주세요.</p>
      )}
      {kind === 'verify' && authenticated && (account === null || account.emailVerified === null) && (
        profileError
          ? <ProfileLoadState />
          : <p className="muted" role="status">로그인한 계정의 인증 상태를 확인하고 있어요.</p>
      )}
      {showsForm && (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {kind !== 'reset' && (
            <label>이메일
              <input name="email" type="email" required maxLength={255} autoComplete={kind === 'login' ? 'username' : 'email'} />
            </label>
          )}
          {kind === 'signup' && (
            <label>닉네임
              <input name="nickname" required minLength={2} maxLength={20} autoComplete="nickname" />
            </label>
          )}
          {kind !== 'reset-request' && (
            <label>{kind === 'reset' ? '새 비밀번호' : '비밀번호'}
              <input name="password" type="password" required minLength={passwordFields ? 8 : undefined}
                maxLength={passwordFields ? 64 : undefined} autoComplete={passwordFields ? 'new-password' : 'current-password'}
                aria-describedby={passwordFields ? 'password-hint' : undefined} />
              {passwordFields && <small id="password-hint" className="muted">8~64자, UTF-8 기준 최대 72바이트</small>}
            </label>
          )}
          {passwordFields && (
            <label>비밀번호 확인
              <input name="passwordConfirmation" type="password" required minLength={8} maxLength={64} autoComplete="new-password" />
            </label>
          )}
          <button className="button primary" type="submit" disabled={pending}>
            {pending ? '처리 중…' : kind === 'reset-request' ? '재설정 링크 받기' : kind === 'reset' ? '비밀번호 저장' : titles[kind]}
          </button>
        </form>
      )}
      {kind === 'verify' && !completed && (
        <>
          <p className="muted">{token ? '이메일 주소를 확인하려면 인증을 완료해 주세요.' : '가입한 이메일에서 인증 링크를 열어 주세요.'}</p>
          {token ? (
            <button className="button primary" type="button" disabled={pending} onClick={() => void verify()}>
              {pending ? '인증 중…' : '이메일 인증 완료'}
            </button>
          ) : authenticated && account?.emailVerified === false && (
            <button className="button" type="button" disabled={pending} onClick={() => void resend()}>
              {pending ? '발송 중…' : '인증 메일 다시 받기'}
            </button>
          )}
        </>
      )}
      {kind === 'reset' && !token && !completed && (
        <p className="muted">비밀번호를 재설정하려면 이메일로 받은 링크를 열어 주세요.</p>
      )}
      {kind === 'login' && (
        <>
          <nav className="actions auth-links" aria-label="계정 관련 메뉴">
            <Link to="/signup" state={returnState}>회원가입</Link>
            <Link to="/password/reset-request" state={returnState}>비밀번호 찾기</Link>
          </nav>
          <div className="auth-social stack">
            <KakaoStartButton returnTarget={returnTarget} />
            <button className="button" type="button" disabled>Google로 계속하기</button>
            <p className="muted">Google 로그인 · API 연동 대기</p>
          </div>
        </>
      )}
      {kind === 'signup' && (
        <div className="auth-social stack">
          <KakaoStartButton returnTarget={returnTarget} />
        </div>
      )}
      {kind !== 'login' && (
        <nav className="actions auth-links" aria-label="계정 화면 이동">
          {kind === 'verify' && authenticated
            ? <Link className="button primary" to={returnTarget} replace>계속하기</Link>
            : <Link to="/login" state={returnState}>로그인으로 돌아가기</Link>}
          {kind === 'reset' && !token && !completed && <Link to="/password/reset-request">새 링크 받기</Link>}
        </nav>
      )}
    </section>
  );
}
