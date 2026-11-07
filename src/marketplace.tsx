import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowRight, Camera, Headphones, Heart, ImagePlus, Laptop, MapPin, MessageCircle, Package,
  ShieldCheck, Shirt, Sofa, Tent, TrendingUp, Watch, X,
} from 'lucide-react'
import { api } from './api'
import type { Category, ListingSummary, ListingDetail, FavoriteSummary } from './api'
import { useAuth } from './auth'
import './marketplace.css'

type Page<T> = { items: T[]; nextCursor: string | null; hasNext: boolean }
type PageLoader<T> = (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>

const won = new Intl.NumberFormat('ko-KR')
const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' })
const conditionLabels = { NEW: '새 상품', LIKE_NEW: '거의 새것', USED: '사용감 있음', HEAVILY_USED: '사용감 많음' }
const statusLabels: Record<string, string> = {
  ACTIVE: '판매중', SOLD: '판매완료', BLOCKED: '거래 불가', DELETED: '삭제된 매물',
  DRAFT: '작성 중', PENDING_VERIFICATION: '검증 대기',
}
const regions = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시',
  '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도',
  '전라남도', '경상북도', '경상남도', '제주특별자치도',
]

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

function useCategories() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    api.categories(controller.signal).then((items) => {
      if (!controller.signal.aborted) setCategories(items)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [revision])

  return { categories, loading, error, retry: () => {
    setError('')
    setLoading(true)
    setRevision((value) => value + 1)
  } }
}

function useCursorPage<T>(load: PageLoader<T>) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const seen = useRef(new Set<string>())
  const initialLoad = useRef(load)

  function loadPage(nextCursor: string | undefined, loader: PageLoader<T>) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    loader(nextCursor, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      const next = page.hasNext ? page.nextCursor : null
      if (next && (next === nextCursor || seen.current.has(next))) {
        throw new Error('다음 목록을 읽을 수 없습니다.')
      }
      if (nextCursor) seen.current.add(nextCursor)
      setItems((previous) => nextCursor ? [...previous, ...page.items] : page.items)
      setCursor(next ?? undefined)
      setDone(!next)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    }).finally(() => {
      if (request.current === controller) {
        request.current = null
        setPending(false)
      }
    })
  }

  useEffect(() => {
    loadPage(undefined, initialLoad.current)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [])

  return { items, setItems, pending, error, done, next: () => loadPage(cursor, load) }
}

function StatusBadge({ status }: { status: string }) {
  return <span className={status === 'ACTIVE' ? 'mp-status active' : 'mp-status'}>{statusLabels[status] ?? '상태 확인 필요'}</span>
}

function ListingGraphic({ categoryCode }: { categoryCode?: string }) {
  const Icon = categoryCode === 'DIGITAL_AUDIO' ? Headphones
    : categoryCode?.startsWith('DIGITAL') ? Laptop
    : categoryCode?.startsWith('FASHION') ? Shirt
    : categoryCode?.startsWith('FURNITURE') ? Sofa
    : categoryCode?.startsWith('SPORT') ? Tent
    : categoryCode?.startsWith('LUXURY') ? Watch
    : Package
  return <span className="mp-listing-art" aria-hidden="true"><Icon /></span>
}

function ListingCard({ listing, categoryName, children }: {
  listing: Pick<ListingSummary, 'publicId' | 'title' | 'price' | 'status'> & Partial<ListingSummary>
  categoryName?: string
  children?: ReactNode
}) {
  const location = useLocation()
  const canOpen = listing.status === 'ACTIVE' || listing.status === 'SOLD'
  const content = <>
    <ListingGraphic categoryCode={listing.categoryCode} />
    <div className="mp-card-info">
      <div className="mp-card-status"><StatusBadge status={listing.status} />{categoryName && <span>{categoryName}</span>}</div>
      <h3>{listing.title}</h3>
      <strong>{won.format(listing.price)}원</strong>
      {listing.regionSido && <span className="mp-card-region"><MapPin size={14} /> {[listing.regionSido, listing.regionSigungu].filter(Boolean).join(' ')}</span>}
    </div>
  </>
  return <article className="mp-listing-card">
    {canOpen ? <Link className="mp-card-link" to={'/listings/' + encodeURIComponent(listing.publicId)} state={{ from: location.pathname + location.search }}>{content}</Link> : <div>{content}</div>}
    {children}
  </article>
}

function CatalogHero() {
  return <section className="mp-hero">
    <div className="mp-hero-copy">
      <p className="mp-hero-kicker"><ShieldCheck size={17} /> SAFEDEAL MARKET</p>
      <h1>좋은 물건을<br />다시 만나는 곳</h1>
      <p>원하는 매물을 찾고, 거래 내역을 바탕으로 시세를 알아보세요.</p>
      <Link className="mp-hero-action" to="/prices" state={{ from: '/' }}><TrendingUp size={16} /> 거래 시세 보기 <ArrowRight size={15} /></Link>
    </div>
    <div className="mp-hero-art" aria-hidden="true">
      <div className="mp-orbit mp-orbit-outer" /><div className="mp-orbit mp-orbit-inner" />
      <div className="mp-hero-emblem"><ShieldCheck /></div>
    </div>
  </section>
}

function CategoryOptions({ categories }: { categories: Category[] }) {
  const roots = categories.filter((category) => category.depth === 1)
  return roots.map((root) => <optgroup key={root.code} label={root.name}>
    <option value={root.code}>{root.name} 전체</option>
    {categories.filter((category) => category.parentCode === root.code).map((category) =>
      <option key={category.code} value={category.code}>{category.name}</option>)}
  </optgroup>)
}

function RegionSuggestions() {
  return <datalist id="market-regions">{regions.map((region) => <option key={region} value={region} />)}</datalist>
}

const filterFields = ['categoryCode', 'regionSido', 'regionSigungu', 'minPrice', 'maxPrice'] as const
type Filters = Partial<Record<typeof filterFields[number], string>>

function CatalogFilters({ filters, categories, update, categoriesLoading }: {
  filters: Filters
  categories: Category[]
  update: (search: URLSearchParams) => void
  categoriesLoading: boolean
}) {
  const [error, setError] = useState('')
  const [categoryCode, setCategoryCode] = useState(filters.categoryCode ?? '')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const minimum = values.get('minPrice') as string
    const maximum = values.get('maxPrice') as string
    if (minimum && maximum && Number(minimum) > Number(maximum)) {
      setError('최소 가격은 최대 가격 이하여야 합니다.')
      return
    }
    const next = new URLSearchParams()
    for (const field of filterFields) {
      const value = field === 'categoryCode' ? categoryCode : String(values.get(field) ?? '').trim()
      if (value) next.set(field, value)
    }
    setError('')
    update(next)
  }
  return <form className="mp-filters panel" aria-label="매물 필터" onSubmit={submit}>
    <div className="mp-filter-grid">
      <label>카테고리<select name="categoryCode" value={categoryCode} onChange={(event) => setCategoryCode(event.target.value)} disabled={categoriesLoading || !categories.length}>
        <option value="">{categoriesLoading ? '카테고리 불러오는 중' : '전체 카테고리'}</option>
        {categoryCode && !categories.some(({ code }) => code === categoryCode) && <option value={categoryCode}>{categoryCode}</option>}
        <CategoryOptions categories={categories} />
      </select></label>
      <label>시·도<input name="regionSido" list="market-regions" maxLength={20} placeholder="예: 서울특별시" defaultValue={filters.regionSido} /></label>
      <label>시·군·구<input name="regionSigungu" maxLength={20} placeholder="예: 강남구" defaultValue={filters.regionSigungu} /></label>
      <label>최소 가격 (원)<input name="minPrice" type="number" min={0} max={100000000} placeholder="최소" defaultValue={filters.minPrice} /></label>
      <label>최대 가격 (원)<input name="maxPrice" type="number" min={0} max={100000000} placeholder="최대" defaultValue={filters.maxPrice} /></label>
      <label>거래 방식<select disabled aria-describedby="mp-trade-help"><option>전체 · 연동 예정</option></select></label>
    </div>
    <RegionSuggestions />
    <div className="mp-filter-footer">
      <small id="mp-trade-help">직거래·안전거래 필터는 API 연동 후 사용할 수 있어요.</small>
      <div className="actions">
        <button className="button" type="button" onClick={(event) => {
          event.currentTarget.form?.reset()
          setCategoryCode('')
          setError('')
          update(new URLSearchParams())
        }}>초기화</button>
        <button className="button primary" type="submit">필터 적용</button>
      </div>
    </div>
    {error && <p className="mp-error" role="alert">{error}</p>}
  </form>
}

function ListingResults({ filters, categories }: { filters: Filters; categories: Category[] }) {
  const page = useCursorPage<ListingSummary>((cursor, signal) => api.listings({ ...filters, cursor }, signal))
  return <section className="mp-results" aria-label="매물 목록">
    {page.items.length > 0 && <div className="mp-grid">
      {page.items.map((listing) => <ListingCard key={listing.publicId} listing={listing} categoryName={categories.find(({ code }) => code === listing.categoryCode)?.name} />)}
    </div>}
    {page.pending && <p className="mp-state" role="status">매물을 불러오는 중입니다.</p>}
    {page.error && <div className="mp-state" role="alert"><p>{page.error}</p><button className="button" onClick={page.next}>다시 시도</button></div>}
    {!page.pending && !page.error && !page.items.length && <div className="mp-state"><Package size={27} /><p>조건에 맞는 매물이 없어요.</p><small>필터를 바꿔서 다시 찾아보세요.</small></div>}
    {!page.pending && !page.error && !page.done && <div className="mp-load-more"><button className="button" onClick={page.next}>매물 더 보기</button></div>}
  </section>
}

export function BrowsePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { categories, loading, error, retry } = useCategories()
  const filters: Filters = {}
  for (const field of filterFields) {
    const value = searchParams.get(field)?.trim()
    if (value) filters[field] = value
  }
  const filterKey = JSON.stringify(filters)
  return <>
    <CatalogHero />
    <div className="mp-section-heading">
      <div><p className="eyebrow">BROWSE</p><h2>전체 매물</h2></div>
      <label className="mp-sort">
        <span>정렬</span>
        <select defaultValue="newest">
          <option value="newest">최신순</option>
          <option value="price-low" disabled>낮은 가격순 · 연동 예정</option>
          <option value="price-high" disabled>높은 가격순 · 연동 예정</option>
        </select>
      </label>
    </div>
    <CatalogFilters key={filterKey} filters={filters} categories={categories} update={setSearchParams} categoriesLoading={loading} />
    {error && <div className="mp-inline-alert" role="alert"><span>카테고리를 불러오지 못했습니다.</span><button className="button" onClick={retry}>다시 시도</button></div>}
    <ListingResults key={filterKey} filters={filters} categories={categories} />
  </>
}

type FavoriteState = { value: boolean | null; error: string }

async function findFavorite(id: string, signal: AbortSignal) {
  let cursor: string | undefined
  const visited = new Set<string>()
  do {
    const page = await api.favorites(cursor, signal)
    if (page.items.some((item) => item.listing.publicId === id)) return true
    cursor = page.hasNext ? page.nextCursor ?? undefined : undefined
    if (cursor && visited.has(cursor)) throw new Error('찜 목록의 다음 페이지를 읽을 수 없습니다.')
    if (cursor) visited.add(cursor)
  } while (cursor)
  return false
}

function ListingDetailContent({ listing }: { listing: ListingDetail }) {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [favorite, setFavorite] = useState<FavoriteState>({ value: null, error: '' })
  const [favoriteRetry, setFavoriteRetry] = useState(0)
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState('')
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!auth.authenticated) return
    const controller = new AbortController()
    findFavorite(listing.publicId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setFavorite({ value, error: '' })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setFavorite({ value: null, error: errorMessage(cause) })
    })
    return () => controller.abort()
  }, [auth.authenticated, listing.publicId, favoriteRetry])

  const from = location.pathname + location.search
  const signIn = () => navigate('/login', { state: { from } })

  async function toggleFavorite() {
    if (!auth.authenticated) {
      signIn()
      return
    }
    if (favorite.value === null || favoriteBusy) return
    setFavoriteBusy(true)
    setFavorite((current) => ({ ...current, error: '' }))
    try {
      const result = await api.favorite(listing.publicId, !favorite.value)
      setFavorite({ value: result.favorited, error: '' })
    } catch (cause) {
      setFavorite((current) => ({ ...current, error: errorMessage(cause) }))
    } finally {
      setFavoriteBusy(false)
    }
  }

  async function openChat() {
    if (!auth.authenticated) {
      signIn()
      return
    }
    if (chatBusy) return
    setChatBusy(true)
    setChatError('')
    try {
      const result = await api.createChat(listing.publicId)
      if (!mounted.current) return
      navigate('/chat?room=' + encodeURIComponent(result.roomId), { state: {
        from, listing: { publicId: listing.publicId, title: listing.title, price: listing.price },
      } })
    } catch (cause) {
      setChatError(errorMessage(cause))
    } finally {
      setChatBusy(false)
    }
  }

  const favorited = auth.authenticated && favorite.value === true
  return <div className="mp-detail-grid">
    <div className="mp-detail-media panel">
      <ListingGraphic categoryCode={listing.category.code} />
      <p><Camera size={16} /> 사진 및 확대 보기는 이미지 API 연동 예정</p>
    </div>
    <div className="mp-detail-body panel">
      <p className="eyebrow">{[listing.category.parentName, listing.category.name].filter(Boolean).join(' / ')}</p>
      <StatusBadge status={listing.status} />
      <h1>{listing.title}</h1>
      <strong className="mp-detail-price">{won.format(listing.price)}원</strong>
      <dl className="mp-detail-facts">
        <div><dt>상품 상태</dt><dd>{conditionLabels[listing.itemCondition]}</dd></div>
        <div><dt>등록 지역</dt><dd>{[listing.region.sido, listing.region.sigungu].filter(Boolean).join(' ')}</dd></div>
        <div><dt>등록일</dt><dd>{date.format(new Date(listing.createdAt))}</dd></div>
        <div><dt>조회</dt><dd>{won.format(listing.viewCount)}</dd></div>
      </dl>
      <div className="mp-detail-description"><h2>상품 설명</h2><p>{listing.description}</p></div>
      <div className="actions">
        <button type="button" className="button mp-heart-button" aria-pressed={favorited}
          disabled={!auth.ready || favoriteBusy || (auth.authenticated && favorite.value === null) || (listing.status !== 'ACTIVE' && !favorited)}
          onClick={toggleFavorite}><Heart size={17} fill={favorited ? 'currentColor' : 'none'} /> {favorited ? '찜 해제' : '찜하기'}</button>
        <button type="button" className="button primary" disabled={!auth.ready || chatBusy} onClick={openChat}>
          <MessageCircle size={17} /> {chatBusy ? '연결 중' : listing.status === 'SOLD' ? '기존 채팅 열기' : '채팅방 열기'}
        </button>
        <Link className="button" to={'/prices?category=' + encodeURIComponent(listing.category.code)} state={{ from }}><TrendingUp size={17} /> 시세 보기</Link>
      </div>
      {favorite.error && <div className="mp-inline-alert" role="alert">{favorite.error}
        {favorite.value === null && <button className="button" onClick={() => {
          setFavorite({ value: null, error: '' })
          setFavoriteRetry((value) => value + 1)
        }}>찜 상태 다시 확인</button>}
      </div>}
      {chatError && <p className="mp-error" role="alert">{chatError}</p>}
      <p className="mp-note">검증 배지, 거래 방식, 택배비와 신고는 연동 예정이에요.</p>
    </div>
  </div>
}

function ListingRequest({ id }: { id: string }) {
  const auth = useAuth()
  const [listing, setListing] = useState<ListingDetail | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    api.listing(id, controller.signal).then((data) => {
      if (!controller.signal.aborted) setListing(data)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    })
    return () => controller.abort()
  }, [id, revision])

  if (error) return <div className="mp-state" role="alert"><p>{error}</p><button className="button" onClick={() => {
    setError('')
    setRevision((value) => value + 1)
  }}>다시 시도</button></div>
  if (!listing) return <p className="mp-state" role="status">매물 정보를 불러오는 중입니다.</p>
  return <ListingDetailContent key={auth.sessionKey} listing={listing} />
}

export function ListingPage() {
  const { id } = useParams()
  return id ? <ListingRequest key={id} id={id} /> : <p className="mp-state">매물을 찾을 수 없습니다.</p>
}

function FavoriteResults() {
  const page = useCursorPage<FavoriteSummary>((cursor, signal) => api.favorites(cursor, signal))
  const [removing, setRemoving] = useState<string[]>([])
  const [removeError, setRemoveError] = useState('')
  const removed = useRef(new Set<string>())

  async function remove(id: string) {
    setRemoving((previous) => [...previous, id])
    setRemoveError('')
    try {
      const result = await api.favorite(id, false)
      if (!result.favorited) {
        removed.current.add(id)
        page.setItems((items) => items.filter((item) => item.listing.publicId !== id))
      }
    } catch (cause) {
      setRemoveError(errorMessage(cause))
    } finally {
      setRemoving((previous) => previous.filter((value) => value !== id))
    }
  }

  return <>
    {removeError && <p className="mp-error" role="alert">{removeError}</p>}
    {page.items.length > 0 && <div className="mp-grid">
      {page.items.filter(({ listing }) => !removed.current.has(listing.publicId)).map(({ listing }) => (
        <ListingCard key={listing.publicId} listing={listing}>
          <div className="mp-card-actions"><button type="button" className="button mp-heart-button" aria-pressed="true"
            disabled={removing.includes(listing.publicId)} aria-label={listing.title + ' 찜 해제'}
            onClick={() => void remove(listing.publicId)}><Heart size={16} fill="currentColor" /> 찜 해제</button></div>
        </ListingCard>
      ))}
    </div>}
    {page.pending && <p className="mp-state" role="status">찜 목록을 불러오는 중입니다.</p>}
    {page.error && <div className="mp-state" role="alert"><p>{page.error}</p><button className="button" onClick={page.next}>다시 시도</button></div>}
    {!page.pending && !page.error && !page.items.length && <div className="mp-state"><Heart size={27} /><p>찜한 매물이 없어요.</p><Link className="button" to="/">매물 둘러보기</Link></div>}
    {!page.pending && !page.error && !page.done && <div className="mp-load-more"><button className="button" onClick={page.next}>찜 목록 더 보기</button></div>}
  </>
}

export function FavoritesPage() {
  const auth = useAuth()
  return <section>
    <div className="mp-page-heading"><p className="eyebrow">FAVORITES</p><h1>찜한 매물</h1><p>다시 보고 싶은 매물을 모아볼 수 있어요.</p></div>
    {!auth.ready ? <p className="mp-state" role="status">로그인 상태를 확인하는 중입니다.</p> : auth.authenticated
      ? <FavoriteResults key={auth.sessionKey} />
      : <div className="mp-state"><p>로그인하면 찜한 매물을 볼 수 있어요.</p><Link className="button primary" to="/login" state={{ from: '/favorites' }}>로그인</Link></div>}
  </section>
}


type SaleDraft = {
  title: string
  description: string
  categoryRoot: string
  categoryCode: string
  condition: keyof typeof conditionLabels | ''
  price: string
  tradeMethod: '' | 'DIRECT' | 'SAFE'
  province: string
  district: string
  meeting: string
  shipping: string
  photos: File[]
}

const emptyDraft: SaleDraft = {
  title: '', description: '', categoryRoot: '', categoryCode: '', condition: '', price: '',
  tradeMethod: '', province: '', district: '', meeting: '', shipping: '', photos: [],
}

// Keep unsent locations and photos only in the current tab's memory.
let rememberedDraft: { owner: number; value: SaleDraft } | undefined

function DraftPhoto({ photo, label, remove }: { photo: File; label: string; remove: () => void }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    const url = URL.createObjectURL(photo)
    setSource(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])
  return <div className="mp-draft-photo">
    {source && <img src={source} alt={label} />}
    <button type="button" aria-label={label + ' 삭제'} onClick={remove}><X size={15} /></button>
  </div>
}

function formatMoneyInput(value: string, limit: number) {
  const digits = value.replace(/[^0-9]/g, '').slice(0, String(limit).length)
  if (!digits) return ''
  const parsed = Number(digits)
  return parsed <= limit ? won.format(parsed) : null
}

function DraftForm({ owner }: { owner: number }) {
  const { categories, loading, error: categoryError, retry } = useCategories()
  const [draft, setDraft] = useState<SaleDraft>(() =>
    rememberedDraft?.owner === owner ? rememberedDraft.value : emptyDraft)
  const [photoError, setPhotoError] = useState('')
  const [saved, setSaved] = useState(false)

  function update<K extends keyof SaleDraft>(field: K, value: SaleDraft[K]) {
    const next = { ...draft, [field]: value }
    if (field === 'categoryRoot') next.categoryCode = ''
    if (field === 'province') {
      next.district = ''
      next.meeting = ''
    }
    if (field === 'tradeMethod') {
      if (value === 'DIRECT') next.shipping = ''
      if (value === 'SAFE') next.meeting = ''
    }
    setDraft(next)
    rememberedDraft = { owner, value: next }
    setSaved(false)
  }

  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.currentTarget.files ?? [])
    const accepted = picked.filter((photo) => ['image/jpeg', 'image/png', 'image/webp'].includes(photo.type))
    const room = 5 - draft.photos.length
    if (picked.length !== accepted.length) setPhotoError('JPG, PNG, WEBP 사진만 추가할 수 있어요.')
    else if (accepted.length > room) setPhotoError('상품 사진은 최대 5장까지 추가할 수 있어요.')
    else setPhotoError('')
    update('photos', [...draft.photos, ...accepted.slice(0, room)])
    event.currentTarget.value = ''
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    rememberedDraft = { owner, value: draft }
    setSaved(true)
  }

  const leafCategories = categories.filter((category) => category.parentCode === draft.categoryRoot)
  return <form className="mp-sale-grid" onSubmit={save}>
    <div className="mp-sale-sections">
      <section className="panel mp-sale-panel">
        <div className="mp-sale-panel-header"><div><h2>상품 사진</h2><p>구매자가 확인할 상품 사진을 최대 5장 준비하세요.</p></div><span className="mp-status">{draft.photos.length} / 5</span></div>
        <div className="mp-photo-grid">
          {draft.photos.map((photo, index) => <DraftPhoto key={photo.name + ':' + photo.lastModified + ':' + index}
            photo={photo} label={index === 0 ? '대표 사진' : '상품 사진 ' + (index + 1)}
            remove={() => { setPhotoError(''); update('photos', draft.photos.filter((_, position) => position !== index)) }} />)}
          {draft.photos.length < 5 && <label className="mp-photo-picker">
            <ImagePlus size={23} /><span>사진 추가</span><input aria-label="상품 사진 추가" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addPhotos} />
          </label>}
        </div>
        {photoError && <p className="mp-error" role="alert">{photoError}</p>}
        <p className="mp-note">선택한 사진은 이 화면에서 미리 볼 수 있어요. 업로드는 연동 예정이에요.</p>
      </section>
      <section className="panel mp-sale-panel">
        <div className="mp-sale-panel-header"><div><h2>상품 정보</h2><p>상품명과 상태를 알아보기 쉽게 작성해 주세요.</p></div></div>
        <label>상품명<input value={draft.title} maxLength={100} placeholder="예: 소니 WH-1000XM5 무선 헤드폰" onChange={(event) => update('title', event.target.value)} /></label>
        <div className="mp-fields-two">
          <label>상품군<select disabled={loading || !categories.length} value={draft.categoryRoot} onChange={(event) => update('categoryRoot', event.target.value)}>
            <option value="">상품군 선택</option>
            {categories.filter((category) => category.depth === 1).map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
          </select></label>
          <label>상품 유형<select disabled={!leafCategories.length} value={draft.categoryCode} onChange={(event) => update('categoryCode', event.target.value)}>
            <option value="">상품 유형 선택</option>
            {leafCategories.map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
          </select></label>
        </div>
        {categoryError && <div className="mp-inline-alert" role="alert"><span>카테고리를 불러오지 못했습니다.</span><button type="button" className="button" onClick={retry}>다시 시도</button></div>}
        <label>상품 상태<select value={draft.condition} onChange={(event) => update('condition', event.target.value as SaleDraft['condition'])}>
          <option value="">상품 상태 선택</option>
          {Object.entries(conditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>상품 설명<textarea value={draft.description} rows={5} maxLength={2000} placeholder="사용 기간, 구성품, 하자 여부를 알려주세요." onChange={(event) => update('description', event.target.value)} /></label>
      </section>
      <section className="panel mp-sale-panel">
        <div className="mp-sale-panel-header"><div><h2>가격과 거래 방식</h2><p>판매 가격과 거래 방법을 정하세요.</p></div></div>
        <label>판매 가격 <span className="mp-money-field"><input value={draft.price} inputMode="numeric" placeholder="0"
          onChange={(event) => { const value = formatMoneyInput(event.target.value, 100000000); if (value !== null) update('price', value) }} /><span>원</span></span></label>
        <fieldset className="mp-trade-choice">
          <legend>거래 방식</legend>
          <label className={draft.tradeMethod === 'DIRECT' ? 'selected' : ''}><input type="radio" name="tradeMethod"
            checked={draft.tradeMethod === 'DIRECT'} onChange={() => update('tradeMethod', 'DIRECT')} /> <span>직거래<small>구매자와 만나 물건을 전달해요.</small></span></label>
          <label className={draft.tradeMethod === 'SAFE' ? 'selected' : ''}><input type="radio" name="tradeMethod"
            checked={draft.tradeMethod === 'SAFE'} onChange={() => update('tradeMethod', 'SAFE')} /> <span>안전거래<small>안전결제로 온라인에서 거래해요.</small></span></label>
        </fieldset>
        {draft.tradeMethod === 'SAFE' && <label>택배비 <span className="mp-money-field"><input value={draft.shipping} inputMode="numeric" placeholder="무료배송은 0"
          onChange={(event) => { const value = formatMoneyInput(event.target.value, 100000000); if (value !== null) update('shipping', value) }} /><span>원</span></span></label>}
        {draft.tradeMethod && <>
          <h3>거래 지역 <small className="mp-note">{draft.tradeMethod === 'DIRECT' ? '직거래 시 필요' : '선택'}</small></h3>
          <div className="mp-fields-two">
            <label>시·도<select value={draft.province} onChange={(event) => update('province', event.target.value)}>
              <option value="">시·도 선택</option>
              {regions.map((region) => <option key={region} value={region}>{region}</option>)}
            </select></label>
            <label>시·군·구<input disabled={!draft.province} value={draft.district} maxLength={20} placeholder="예: 강남구"
              onChange={(event) => update('district', event.target.value)} /></label>
          </div>
        </>}
        {draft.tradeMethod === 'DIRECT' && <label>만날 장소·상세 주소 <span className="mp-note">(선택)</span>
          <input value={draft.meeting} maxLength={120} placeholder="예: 강남역 2번 출구"
            onChange={(event) => update('meeting', event.target.value)} />
          <small>상세 주소는 공개 매물에 표시하지 않아요.</small>
        </label>}
      </section>
    </div>
    <aside className="mp-sale-aside">
      <section className="panel mp-sale-panel">
        <p className="eyebrow">등록 진행</p><h2>게시까지 3단계</h2>
        <ol className="mp-sale-steps">
          <li aria-current="step"><span>1</span><div><strong>상품 정보 작성</strong><small>사진, 가격, 거래 방식 입력</small></div></li>
          <li><span>2</span><div><strong>인증샷 제출</strong><small>검증 API 연동 예정</small></div></li>
          <li><span>3</span><div><strong>검수 결과 확인</strong><small>승인 후 매물 공개</small></div></li>
        </ol>
      </section>
      <section className="panel mp-sale-panel">
        <p className="eyebrow">작성 중인 매물</p><h2>{draft.title || '상품명을 입력해 주세요'}</h2>
        <strong className="mp-draft-price">{draft.price ? draft.price + '원' : '가격 미입력'}</strong>
        <p className="mp-note">{[draft.tradeMethod === 'DIRECT' ? '직거래' : draft.tradeMethod === 'SAFE' ? '안전거래' : '',
          draft.province, draft.district].filter(Boolean).join(' · ')}</p>
        <Link className="button" to={draft.categoryCode ? '/prices?category=' + encodeURIComponent(draft.categoryCode) : '/prices'}
          state={{ from: '/sell' }}><TrendingUp size={16} /> 판매 시세 알아보기</Link>
      </section>
      <section className="panel mp-sale-panel mp-sale-end">
        <p className="mp-note">인증샷 검수 연동이 완료되면 상품 정보를 제출할 수 있어요.</p>
        <button className="button primary" type="button" disabled>인증샷 촬영으로 <ArrowRight size={16} /></button>
        <button className="button" type="submit">임시 저장</button>
        {saved && <p className="mp-note" role="status">현재 탭에 임시 저장했어요.</p>}
      </section>
    </aside>
  </form>
}

export function SellPage() {
  const auth = useAuth()
  const owner = auth.sessionKey
  return <section>
    <div className="mp-page-heading"><p className="eyebrow">판매하기</p><h1>매물 등록</h1><p>상품 정보를 작성하고 인증샷 검증을 통과하면 매물이 공개돼요.</p></div>
    {!auth.ready ? <p className="mp-state" role="status">로그인 상태를 확인하는 중입니다.</p> : auth.authenticated
      ? <DraftForm key={owner} owner={owner} />
      : <div className="mp-state"><p>로그인하면 상품 정보를 작성할 수 있어요.</p><Link className="button primary" to="/login" state={{ from: '/sell' }}>로그인</Link></div>}
  </section>
}
