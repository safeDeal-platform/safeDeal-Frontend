import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authSession } from './api';
import { KakaoStartButton, feedback, forgetKakaoReturn, readKakaoReturn, useAuth } from './auth';
import './auth.css';

// 카카오에서 돌아온 백엔드가 붙이는 오류 코드(AuthController.kakaoCallback). 화면 이동이라 JSON 메시지가 없어서
// 문구를 여기서 가진다. 목록에 없는 값은 주소에 무엇이 오든 그대로 보여 주지 않고 서버 오류 문구로 바꾼다.
const KAKAO_ERRORS: Record<string, string> = {
  AUTH011: '로그인 요청이 만료됐어요. 카카오 로그인을 다시 시작해 주세요.',
  AUTH012: '카카오 로그인 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  AUTH013: '카카오 로그인을 취소했어요.',
  AUTH014: '카카오 계정의 이메일 인증이 필요해요. 카카오에서 이메일을 인증한 뒤 다시 시도해 주세요.',
  AUTH015: '이 이메일로 가입된 계정과 카카오 계정을 연결할 수 없어요. 기존 계정으로 로그인해 주세요.',
  AUTH005: '이용이 제한된 계정이에요. 자세한 내용은 고객센터로 문의해 주세요.',
  C009: '다른 요청이 먼저 처리됐어요. 카카오 로그인을 다시 시작해 주세요.',
  C007: '서버에 문제가 생겨 카카오 로그인을 마치지 못했어요. 잠시 후 다시 시도해 주세요.',
};

function kakaoErrorMessage(code: unknown) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(KAKAO_ERRORS, code)
    ? KAKAO_ERRORS[code]
    : KAKAO_ERRORS.C007;
}

/**
 * 카카오 로그인에서 돌아오는 화면(/oauth/callback). 백엔드가 붙이는 값은 셋 중 하나다.
 * - result=login: refresh 쿠키가 이미 심어져 있다. 화면을 처음 여는 AuthProvider가 재발급으로 세션을 살린다.
 * - result=signup: 처음 온 사용자. 가입 티켓 쿠키(10분)가 있어 닉네임만 받는다. 새로고침해도 폼이 다시 뜨도록
 *   가입이 끝날 때까지 주소에 남긴다.
 * - error=코드: 주소에서 지우고(뒤로 가기·새로고침에 다시 처리하지 않게) 코드는 history state로 옮긴다.
 */
export function KakaoCallbackPage() {
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { ready, authenticated, restricted } = useAuth();
  const [target] = useState(readKakaoReturn);
  const result = search.get('result');
  const queryError = search.get('error');
  const stateError: unknown = (location.state as { kakaoError?: unknown } | null)?.kakaoError;

  useEffect(() => {
    if (queryError === null) return;
    navigate({ pathname: location.pathname, search: '' }, { replace: true, state: { kakaoError: queryError } });
  }, [queryError, location.pathname, navigate]);

  useEffect(() => {
    if (result !== 'login' || !ready) return;
    if (authenticated) {
      forgetKakaoReturn();
      navigate(target, { replace: true });
    } else if (restricted) {
      // 로그인 화면이 정지 계정 안내를 맡는다.
      navigate('/login', { replace: true });
    }
  }, [result, ready, authenticated, restricted, target, navigate]);

  if (queryError !== null || stateError !== undefined) {
    return <KakaoProblem code={queryError ?? stateError} target={target} />;
  }
  if (result === 'signup') return <KakaoSignup target={target} />;
  if (result === 'login') {
    if (!ready || authenticated || restricted) {
      return <KakaoPanel><p className="muted" role="status">카카오 로그인을 마무리하고 있어요.</p></KakaoPanel>;
    }
    return <KakaoProblem target={target}
      message="로그인을 마무리하지 못했어요. 연결이 돌아오면 다시 확인하고, 계속 안 되면 카카오 로그인을 다시 시작해 주세요." />;
  }
  return <KakaoProblem target={target} message="카카오 로그인 결과를 확인할 수 없어요. 다시 시작해 주세요." />;
}

function KakaoPanel({ title = '카카오 로그인', children }: { title?: string; children: ReactNode }) {
  return (
    <section className="auth-panel panel stack" aria-labelledby="kakao-title">
      <header>
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1 id="kakao-title">{title}</h1>
      </header>
      {children}
    </section>
  );
}

function KakaoProblem({ code, message, target }: { code?: unknown; message?: string; target: string }) {
  const restrictedAccount = code === 'AUTH005';
  return (
    <KakaoPanel>
      <p className="error" role="alert">{message ?? kakaoErrorMessage(code)}</p>
      <nav className="actions auth-links" aria-label="카카오 로그인 다음 단계">
        {restrictedAccount
          ? <Link className="button" to="/support">고객센터</Link>
          : <KakaoStartButton returnTarget={target} />}
        <Link to="/login" state={{ from: target }}>이메일로 로그인</Link>
      </nav>
    </KakaoPanel>
  );
}

function KakaoSignup({ target }: { target: string }) {
  const { ready, authenticated } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // 가입 티켓이 없어졌거나(AUTH016) 그 사이 같은 이메일로 가입이 생기면(AUTH001) 이 폼으로는 끝낼 수 없다.
  const [dead, setDead] = useState<'expired' | 'email-taken' | null>(null);

  if (!ready) {
    return <KakaoPanel title="닉네임 정하기"><p className="muted" role="status">가입 정보를 확인하고 있어요.</p></KakaoPanel>;
  }
  // 이미 로그인한 사람이 이 주소를 다시 열면 폼을 띄우지 않는다. 티켓이 남아 있으면 계정이 하나 더 생기고
  // 로그인 계정이 바뀌기 때문이다. 제출 중에는 성공한 제출이 직접 이동한다.
  if (authenticated && !pending) return <Navigate to={target} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const nickname = String(new FormData(event.currentTarget).get('nickname') ?? '').trim();
    setPending(true);
    setError('');
    try {
      await authSession.kakaoSignup(nickname);
      forgetKakaoReturn();
      navigate(target, { replace: true });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'AUTH016') setDead('expired');
      else if (failure instanceof ApiError && failure.code === 'AUTH001') setDead('email-taken');
      else setError(feedback(failure));
    } finally {
      setPending(false);
    }
  }

  if (dead === 'expired') {
    return <KakaoProblem target={target} message="가입 요청이 만료됐어요. 카카오 로그인을 다시 시작해 주세요." />;
  }
  if (dead === 'email-taken') {
    return <KakaoProblem target={target} message="그 사이 같은 이메일로 가입된 계정이 생겼어요. 그 계정으로 로그인해 주세요." />;
  }

  return (
    <KakaoPanel title="닉네임 정하기">
      <p className="muted">카카오 계정 확인을 마쳤어요. SafeDeal에서 쓸 닉네임을 정하면 가입이 끝나요.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label>닉네임
          <input name="nickname" required minLength={2} maxLength={20} autoComplete="nickname" />
        </label>
        <button className="button primary" type="submit" disabled={pending}>{pending ? '처리 중…' : '가입 마치기'}</button>
      </form>
      <nav className="actions auth-links" aria-label="카카오 가입 그만두기">
        <Link to="/login" state={{ from: target }}>이메일로 로그인</Link>
      </nav>
    </KakaoPanel>
  );
}
