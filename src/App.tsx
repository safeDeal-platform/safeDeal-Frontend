import { useEffect, useState } from 'react'
import { ArrowLeft, Heart, MessageCircle, Plus, Search, ShieldCheck, ShoppingCart, UserRound } from 'lucide-react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'
import { AuthPage, useAuth } from './auth'
import { BrowsePage, FavoritesPage, ListingPage, SellPage } from './marketplace'
import { AccountPage, CartPage, ChatPage, PricesPage, SupportPage } from './services'

function Header() {
  const { authenticated, ready, logout } = useAuth()
  const [searchOpen, setSearchOpen] = useState(false)
  const [unread, setUnread] = useState<number | null>(null)
  const [logoutError, setLogoutError] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authenticated) return
    let current: AbortController | undefined
    const refresh = () => {
      current?.abort()
      const controller = new AbortController()
      current = controller
      api.unreadNotifications(controller.signal)
        .then((data) => { if (!controller.signal.aborted) setUnread(data.unreadCount) })
        .catch(() => { if (!controller.signal.aborted) setUnread(null) })
    }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('safedeal:notifications-updated', refresh)
    return () => {
      current?.abort()
      window.clearInterval(timer)
      window.removeEventListener('safedeal:notifications-updated', refresh)
      setUnread(null)
    }
  }, [authenticated])

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
        <div className="header-search" role="search"
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false) }}
          onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false) }}>
          <Search size={18} aria-hidden="true" />
          <input type="search" readOnly aria-label="매물 검색" aria-describedby="search-availability"
            aria-controls="search-availability" placeholder="상품명, 브랜드, 모델명 검색"
            onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)} />
          <span className="availability">연동 예정</span>
          <div id="search-availability" className="search-popover" hidden={!searchOpen}>
            <strong>인기 검색어 · 연동 예정</strong>
            <p>지금은 매물 목록의 카테고리·지역·가격 필터를 이용할 수 있어요.</p>
          </div>
        </div>
        <NavLink to="/sell" className="button primary"><Plus size={18} aria-hidden="true" />매물 등록</NavLink>
      </div>
      <div className="header-nav-wrap">
        <nav className="container header-nav" aria-label="주요 메뉴">
          <NavLink to="/" end>매물 둘러보기</NavLink>
          <NavLink to="/favorites"><Heart size={17} aria-hidden="true" />찜한 매물</NavLink>
          <NavLink to="/cart"><ShoppingCart size={17} aria-hidden="true" />장바구니</NavLink>
          <NavLink to="/chat"><MessageCircle size={17} aria-hidden="true" />채팅</NavLink>
          <NavLink to="/account" className="account-link"><UserRound size={17} aria-hidden="true" />마이페이지
            {authenticated && unread !== null && unread > 0 && <span className="count" aria-label={`읽지 않은 알림 ${unread}개`}>{unread}</span>}
          </NavLink>
          {ready && (authenticated
            ? <button className="nav-button" type="button" disabled={loggingOut} onClick={handleLogout}>로그아웃</button>
            : <NavLink to="/login" state={{ from: location.pathname + location.search }}>로그인</NavLink>)}
        </nav>
      </div>
      {logoutError && <p className="container error" role="alert">로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
    </header>
  )
}

function BackLink() {
  const location = useLocation()
  const navigate = useNavigate()
  if (location.pathname === '/' && !location.search) return null
  const index: unknown = window.history.state?.idx
  return <div className="back-row"><button type="button" className="button"
    onClick={() => typeof index === 'number' && index > 0 ? navigate(-1) : navigate('/', { replace: true })}>
    <ArrowLeft size={17} aria-hidden="true" />뒤로
  </button></div>
}

export function App() {
  const location = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [location.pathname])

  return (
    <>
      <a className="skip-link" href="#main">본문으로 건너뛰기</a>
      <Header />
      <main className="container page" id="main">
        <BackLink />
        <Routes>
          <Route path="/" element={<BrowsePage />} />
          <Route path="/listings/:id" element={<ListingPage />} />
          <Route path="/sell" element={<SellPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/prices" element={<PricesPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/login" element={<AuthPage kind="login" />} />
          <Route path="/signup" element={<AuthPage kind="signup" />} />
          <Route path="/email/verify" element={<AuthPage kind="verify" />} />
          <Route path="/auth/email/verify" element={<AuthPage kind="verify" />} />
          <Route path="/password/reset-request" element={<AuthPage kind="reset-request" />} />
          <Route path="/password/reset" element={<AuthPage kind="reset" />} />
          <Route path="/auth/password/reset" element={<AuthPage kind="reset" />} />
          <Route path="*" element={<section className="panel stack"><h1>페이지를 찾을 수 없어요</h1><Link to="/" className="button">매물 목록으로</Link></section>} />
        </Routes>
      </main>
      <footer className="site-footer"><div className="container"><strong>SafeDeal</strong><Link to="/support">고객센터</Link></div></footer>
    </>
  )
}
