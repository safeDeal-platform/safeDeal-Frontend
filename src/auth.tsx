import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authSession } from './api';
import './auth.css';

type AuthContextValue = ReturnType<typeof authSession.getSnapshot> & { logout: typeof authSession.logout };
type AuthPageKind = 'login' | 'signup' | 'verify' | 'reset-request' | 'reset';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(authSession.subscribe, authSession.getSnapshot, authSession.getSnapshot);

  useEffect(() => {
    void authSession.restore().catch(() => {
      // Public screens stay available when the server cannot restore a session.
    });
  }, []);

  return <AuthContext.Provider value={{ ...state, logout: authSession.logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider가 필요합니다.');
  return value;
}

const titles: Record<AuthPageKind, string> = {
  login: '로그인',
  signup: '회원가입',
  verify: '이메일 인증',
  'reset-request': '비밀번호 찾기',
  reset: '새 비밀번호 설정',
};

function safeReturnTarget(from: unknown, queryTarget: string | null) {
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
  return target;
}

function feedback(error: unknown) {
  if (error instanceof ApiError) return error.fieldErrors[0]?.message || error.message;
  if (error instanceof Error) return error.message;
  return '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function AuthPage({ kind }: { kind: AuthPageKind }) {
  return <AuthScreen key={kind} kind={kind} />;
}

function AuthScreen({ kind }: { kind: AuthPageKind }) {
  const { authenticated, account } = useAuth();
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
      {kind === 'verify' && account?.emailVerified === null && (
        <p className="muted">현재 로그인한 계정의 인증 상태를 확인하려면 다시 로그인해 주세요.</p>
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
          ) : authenticated && account?.emailVerified !== null && account?.emailVerified !== true && (
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
            <p className="muted">소셜 로그인 · API 연동 대기</p>
            <button className="button" type="button" disabled>Google로 계속하기</button>
            <button className="button" type="button" disabled>카카오로 계속하기</button>
          </div>
        </>
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
