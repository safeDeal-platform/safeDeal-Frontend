import { useCallback, useEffect, useState } from 'react'
import { Bell, ChartNoAxesCombined, Headphones, MessageCircle, Plus, ShoppingCart, Siren } from 'lucide-react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { api, type NotificationItem, type PriceStatistics } from './api'
import { useAuth } from './auth'
import './services.css'

type Loader<T> = (signal: AbortSignal) => Promise<T>

function useServiceData<T>(load: Loader<T> | null) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ loader: Loader<T>; attempt: number; data?: T; error?: string }>()
  useEffect(() => {
    if (!load) return
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ loader: load, attempt, data })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setResult({ loader: load, attempt, error: error instanceof Error ? error.message : '정보를 불러오지 못했어요.' })
      },
    )
    return () => controller.abort()
  }, [load, attempt])

  const current = result?.loader === load && result.attempt === attempt ? result : undefined
  return {
    data: current?.data,
    error: current?.error,
    loading: Boolean(load && !current),
    retry: () => setAttempt((value) => value + 1),
  }
}

const won = new Intl.NumberFormat('ko-KR')
const shortDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

function ServiceHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <header className="service-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {description && <p className="muted">{description}</p>}
    </header>
  )
}

function ServiceError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="service-feedback" role="alert">
      <p>{message}</p>
      <button className="button" type="button" onClick={retry}>다시 시도</button>
    </div>
  )
}

function PriceResult({ stats, category }: { stats: PriceStatistics; category: string }) {
  const { medianPrice, minPrice, maxPrice, calculatedAt } = stats
  const enoughSamples = stats.sampleCount >= 5 && medianPrice != null && minPrice != null && maxPrice != null
  return (
    <section className="service-price-result" aria-live="polite">
      <div className="service-row">
        <div>
          <p className="eyebrow">거래 통계</p>
          <h2>{category}</h2>
        </div>
        <span className="service-badge">최근 {stats.period === '30d' ? 30 : 7}일 · 표본 {stats.sampleCount}건</span>
      </div>
      {enoughSamples ? (
        <>
          <dl className="service-price-metrics">
            <div><dt>중앙값</dt><dd>{won.format(medianPrice)}원</dd></div>
            <div><dt>최저 거래가</dt><dd>{won.format(minPrice)}원</dd></div>
            <div><dt>최고 거래가</dt><dd>{won.format(maxPrice)}원</dd></div>
          </dl>
          {calculatedAt && <p className="muted">집계 시각 {shortDate.format(new Date(calculatedAt))}</p>}
        </>
      ) : (
        <p className="service-notice">{stats.message || '시세를 안내할 거래 표본이 부족합니다.'}</p>
      )}
    </section>
  )
}

export function PricesPage() {
  const [params, setParams] = useSearchParams()
  const requestedCode = params.get('category') ?? ''
  const period = params.get('period') === '30d' ? '30d' : '7d'
  const categories = useServiceData(api.categories)
  const allCategories = categories.data ?? []
  const selected = allCategories.find((item) => item.code === requestedCode && item.depth === 2)
  const loadPrices = useCallback((signal: AbortSignal) => api.priceStatistics(requestedCode, period, signal), [requestedCode, period])
  const prices = useServiceData(selected ? loadPrices : null)

  function changeFilter(key: 'category' | 'period', value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  return (
    <section className="service-page">
      <ServiceHeading eyebrow="PRICE GUIDE" title="매물 시세" description="완료된 거래를 바탕으로 카테고리별 가격을 비교하세요." />
      <div className="service-grid">
        <section className="panel service-panel">
          <h2>시세 조회</h2>
          <div className="service-fields">
            <label>
              상품 유형
              <select value={selected?.code ?? ''} disabled={categories.loading || !!categories.error} onChange={(event) => changeFilter('category', event.target.value)}>
                <option value="">상품 유형을 선택하세요</option>
                {allCategories.filter((item) => item.depth === 1).map((parent) => (
                  <optgroup key={parent.code} label={parent.name}>
                    {allCategories.filter((item) => item.depth === 2 && item.parentCode === parent.code).map((item) => (
                      <option key={item.code} value={item.code}>{item.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              조회 기간
              <select value={period} onChange={(event) => changeFilter('period', event.target.value)}>
                <option value="7d">최근 7일</option>
                <option value="30d">최근 30일</option>
              </select>
            </label>
          </div>
          {categories.error && <ServiceError message={categories.error} retry={categories.retry} />}
          {prices.error && <ServiceError message={prices.error} retry={prices.retry} />}
          {(categories.loading || prices.loading) && <p className="muted" role="status">시세 정보를 불러오는 중이에요.</p>}
          {prices.data && selected && <PriceResult stats={prices.data} category={selected.name} />}
          {!selected && !categories.loading && !categories.error && <p className="muted">상품 유형을 선택하면 거래 표본과 가격을 확인할 수 있어요.</p>}
        </section>
        <aside className="panel service-panel">
          <ChartNoAxesCombined className="service-illustration" aria-hidden="true" />
          <h2>시세를 보는 법</h2>
          <p className="muted">표본이 5건 이상이면 거래 가격의 중앙값과 범위를 보여드려요. 제품 상태와 구성에 따라 거래가는 달라질 수 있어요.</p>
          <div className="service-notice">
            <strong>AI 시세 챗봇</strong>
            <p>상품명으로 질문하는 기능은 연동 예정이에요.</p>
          </div>
        </aside>
      </div>
    </section>
  )
}

function notificationTarget(item: NotificationItem) {
  if (!item.targetId) return null
  if (item.targetType === 'LISTING') return { href: '/listings/' + encodeURIComponent(item.targetId), label: '매물 보기' }
  if (item.targetType === 'CHAT') return { href: '/chat?room=' + encodeURIComponent(item.targetId), label: '채팅 보기' }
  return null
}

function NotificationPanel() {
  const notifications = useServiceData(useCallback((signal: AbortSignal) => api.notifications(undefined, signal), []))
  const unread = useServiceData(api.unreadNotifications)
  const [marking, setMarking] = useState<number | null>(null)
  const [markError, setMarkError] = useState('')
  const [recentlyRead, setRecentlyRead] = useState<Set<number>>(() => new Set())

  async function markRead(id: number) {
    setMarking(id)
    setMarkError('')
    try {
      await api.readNotification(id)
      setRecentlyRead((read) => new Set(read).add(id))
      unread.retry()
      window.dispatchEvent(new Event('safedeal:notifications-updated'))
    } catch (error: unknown) {
      setMarkError(error instanceof Error ? error.message : '알림을 읽음 처리하지 못했어요.')
    } finally {
      setMarking(null)
    }
  }

  return (
    <section className="panel service-panel" aria-labelledby="account-alerts">
      <div className="service-row">
        <h2 id="account-alerts">알림 {unread.data && <span className="service-badge">{unread.data.unreadCount > 99 ? '99+' : unread.data.unreadCount}개 안 읽음</span>}</h2>
        <button className="button" type="button" onClick={() => { notifications.retry(); unread.retry() }} disabled={notifications.loading}>새로고침</button>
      </div>
      {notifications.loading && <p className="muted" role="status">알림을 불러오는 중이에요.</p>}
      {notifications.error && <ServiceError message={notifications.error} retry={notifications.retry} />}
      {unread.error && <ServiceError message={unread.error} retry={unread.retry} />}
      {markError && <p className="service-notice" role="alert">{markError}</p>}
      {notifications.data?.items.length === 0 && <p className="service-empty muted"><Bell aria-hidden="true" />아직 받은 알림이 없어요.</p>}
      {notifications.data && notifications.data.items.length > 0 && (
        <ul className="service-notifications">
          {notifications.data.items.map((item) => {
            const isRead = item.isRead || recentlyRead.has(item.notificationId)
            const target = notificationTarget(item)
            return (
              <li key={item.notificationId}>
                <div>
                  <h3>{item.title} {!isRead && <span className="service-badge">새 알림</span>}</h3>
                  <p>{item.body}</p>
                  <time className="muted" dateTime={item.createdAt}>{shortDate.format(new Date(item.createdAt))}</time>
                </div>
                <div className="actions">
                  {target && <Link className="button" to={target.href}>{target.label}</Link>}
                  {!isRead && <button className="button" type="button" disabled={marking !== null} onClick={() => void markRead(item.notificationId)}>{marking === item.notificationId ? '처리 중' : '읽음 처리'}</button>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const accountTabs = [
  { value: 'alerts', label: '알림' },
  { value: 'selling', label: '판매 관리' },
  { value: 'orders', label: '주문·거래' },
  { value: 'reports', label: '내 신고' },
  { value: 'profile', label: '프로필·신뢰도' },
] as const

export function AccountPage() {
  const auth = useAuth()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const selected = accountTabs.find((tab) => tab.value === params.get('tab')) ?? accountTabs[0]

  if (!auth.ready) return <p className="muted" role="status">로그인 상태를 확인하고 있어요.</p>
  if (!auth.authenticated) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />

  return (
    <section className="service-page">
      <ServiceHeading eyebrow="MY SAFEDEAL" title="마이페이지" description={auth.account ? auth.account.nickname + '님의 SafeDeal' : undefined} />
      <nav className="service-tabs" aria-label="마이페이지 메뉴">
        {accountTabs.map((tab) => (
          <button className="button" type="button" key={tab.value} aria-pressed={selected.value === tab.value} onClick={() => setParams({ tab: tab.value }, { replace: true })}>{tab.label}</button>
        ))}
      </nav>
      {selected.value === 'alerts' && <NotificationPanel />}
      {selected.value === 'selling' && (
        <section className="panel service-panel"><h2>판매 관리</h2><p className="muted">내 매물 목록과 판매 상태 관리는 연동 예정이에요. 매물 등록 화면에서 판매 정보를 준비할 수 있어요.</p><Link className="button" to="/sell">매물 등록 화면</Link></section>
      )}
      {selected.value === 'orders' && (
        <section className="panel service-panel"><h2>주문·거래</h2><p className="muted">안전결제와 주문·배송 내역은 연동 예정이에요.</p><Link className="button" to="/cart">장바구니</Link></section>
      )}
      {selected.value === 'reports' && (
        <section className="panel service-panel"><h2>내 신고</h2><p className="muted">매물·채팅 신고와 처리 내역은 연동 예정이에요.</p><Link className="button" to="/support">고객센터</Link></section>
      )}
      {selected.value === 'profile' && (
        <section className="panel service-panel">
          <h2>프로필·신뢰도</h2>
          {auth.account ? (
            <dl className="service-price-metrics">
              <div><dt>닉네임</dt><dd>{auth.account.nickname}</dd></div>
              <div><dt>이메일 인증</dt><dd>{auth.account.emailVerified === true ? '완료' : auth.account.emailVerified === false ? '대기' : '다시 로그인해 확인'}</dd></div>
              <div><dt>신뢰도</dt><dd>{auth.account.trustScore.toFixed(1)} / 100</dd></div>
            </dl>
          ) : <p className="muted">프로필 재조회는 연동 예정이에요. 계정 정보는 로그인 직후 확인할 수 있어요.</p>}
          {auth.account?.emailVerified === false && <Link className="button" to="/email/verify">이메일 인증</Link>}
        </section>
      )}
    </section>
  )
}

export function ChatPage() {
  const [params] = useSearchParams()
  const location = useLocation()
  const auth = useAuth()
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const room = params.get('room')
  const listing = (location.state as { listing?: { publicId: string; title: string; price: number } } | null)?.listing

  if (!auth.ready) return <p className="muted" role="status">로그인 상태를 확인하고 있어요.</p>
  if (!auth.authenticated) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />

  return (
    <section className="service-page">
      <ServiceHeading eyebrow="MESSAGES" title="채팅" />
      <div className="service-grid service-chat-grid">
        <aside className="panel service-panel">
          <h2>대화 목록</h2>
          <p className="muted">대화 목록은 연동 예정이에요.</p>
          {room && <p className="service-notice">{listing?.title ?? '선택한 매물'} 채팅방</p>}
        </aside>
        <section className="panel service-panel service-chat" aria-label="채팅방">
          <div className="service-row">
            <h2>{room ? '판매자와의 채팅' : '판매자와 대화해 보세요'}</h2>
            {room && <div className="actions">
              <button className="button" type="button" disabled aria-label="채팅 신고 연동 예정"><Siren size={17} aria-hidden="true" /></button>
              <button className="button" type="button" disabled>나가기</button>
            </div>}
          </div>
          {room && listing && (
            <Link className="service-chat-listing" to={'/listings/' + encodeURIComponent(listing.publicId)}>
              <strong>{listing.title}</strong><span>{won.format(listing.price)}원</span>
            </Link>
          )}
          <div className="service-empty muted">
            <MessageCircle aria-hidden="true" />
            <p>{room ? '이 채팅방의 메시지 목록과 전송은 연동 예정이에요.' : '매물 상세에서 판매자와 채팅방을 열 수 있어요.'}</p>
          </div>
          {room ? (
            <div className="service-chat-controls">
              {attachmentsOpen && <div className="actions" id="chat-attachments">
                <button className="button" type="button" disabled>위치 지정</button>
                <button className="button" type="button" disabled>사진 촬영·첨부</button>
                <Link className="button" to="/support">고객센터</Link>
              </div>}
              <div className="service-chat-compose">
                <button className="button" type="button" aria-expanded={attachmentsOpen} aria-controls={attachmentsOpen ? 'chat-attachments' : undefined} aria-label="채팅 첨부 메뉴" onClick={() => setAttachmentsOpen((open) => !open)}><Plus size={18} aria-hidden="true" /></button>
                <input aria-label="메시지 입력" placeholder="메시지 전송 연동 예정" disabled />
                <button className="button primary" type="button" disabled>보내기</button>
              </div>
            </div>
          ) : <Link className="button" to="/">매물 둘러보기</Link>}
        </section>
      </div>
    </section>
  )
}

export function CartPage() {
  return (
    <section className="service-page">
      <ServiceHeading eyebrow="CART" title="장바구니" />
      <div className="service-grid">
        <section className="panel service-panel service-empty muted">
          <ShoppingCart aria-hidden="true" />
          <p>장바구니에 담기와 안전결제는 연동 예정이에요.</p>
          <Link className="button primary" to="/">매물 둘러보기</Link>
        </section>
        <aside className="panel service-panel">
          <h2>주문 요약</h2>
          <p className="muted">결제 가능한 매물이 담기면 상품 금액과 배송비를 각각 표시해요.</p>
          <button className="button primary" type="button" disabled>주문 확인</button>
        </aside>
      </div>
    </section>
  )
}

export function SupportPage() {
  return (
    <section className="service-page">
      <ServiceHeading eyebrow="SAFEDEAL HELP" title="고객센터" />
      <div className="panel service-panel service-help">
        <Headphones className="service-illustration" aria-hidden="true" />
        <h2>거래 도움말</h2>
        <details><summary>거래 시세는 어떻게 확인하나요?</summary><p>매물 상세에서 시세를 열거나 상품 유형과 조회 기간을 선택해 거래 통계를 확인할 수 있어요.</p><Link to="/prices">매물 시세 조회</Link></details>
        <details><summary>채팅에서 위치나 사진을 공유할 수 있나요?</summary><p>채팅방을 열 수 있어요. 메시지, 만날 장소와 사진 공유는 연동 예정이에요.</p></details>
        <details><summary>문제가 있는 매물과 대화는 어떻게 신고하나요?</summary><p>앱에서 매물과 채팅을 신고하는 기능은 연동 예정이에요.</p></details>
      </div>
    </section>
  )
}
