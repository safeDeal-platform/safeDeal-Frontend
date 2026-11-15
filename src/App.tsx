import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthPage, useAuth } from './auth'

// 매물·서비스 화면은 이어지는 PR에서 연결한다.
function Header() {
  const { authenticated, ready, logout } = useAuth()
  const [logoutError, setLogoutError] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  async function handleLogout() {
    setLoggingOut(true)
    setLogoutError(false)
    try {
      await logout()
      navigate('/', { replace: true })
    } catch {
      setLogoutError(true)
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <header className="site-header">
      <div className="container header-main">
        <Link to="/" className="brand" aria-label="SafeDeal 홈">
          <span className="brand-symbol"><ShieldCheck size={23} aria-hidden="true" /></span>SafeDeal
        </Link>
        <nav className="header-nav" aria-label="주요 메뉴">
          {ready && (authenticated
            ? <button className="nav-button" type="button" disabled={loggingOut} onClick={handleLogout}>로그아웃</button>
            : <NavLink to="/login" state={{ from: location.pathname + location.search }}>로그인</NavLink>)}
        </nav>
      </div>
      {logoutError && <p className="container error" role="alert">로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
    </header>
  )
}

export function App() {
  return (
    <>
      <Header />
      <main className="container page" id="main">
        <Routes>
          <Route path="/" element={<section className="panel stack"><h1>SafeDeal</h1><p>매물 화면을 준비하고 있어요.</p></section>} />
          <Route path="/login" element={<AuthPage kind="login" />} />
          <Route path="/signup" element={<AuthPage kind="signup" />} />
          <Route path="/email/verify" element={<AuthPage kind="verify" />} />
          <Route path="/auth/email/verify" element={<AuthPage kind="verify" />} />
          <Route path="/password/reset-request" element={<AuthPage kind="reset-request" />} />
          <Route path="/password/reset" element={<AuthPage kind="reset" />} />
          <Route path="/auth/password/reset" element={<AuthPage kind="reset" />} />
          <Route path="*" element={<section className="panel stack"><h1>페이지를 찾을 수 없어요</h1><Link to="/" className="button">처음으로</Link></section>} />
        </Routes>
      </main>
    </>
  )
}
