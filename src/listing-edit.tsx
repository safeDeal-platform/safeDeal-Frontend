import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, authSession } from './api'
import type { ItemCondition, ListingDetail, ListingInput } from './api'
import { ProfileLoadState, useAuth } from './auth'
import { conditionLabels, errorMessage, formatMoneyInput, regions, useCategories, won } from './marketplace'

/** The backend replaces every field on PATCH, so the form always carries all of them. */
type EditDraft = {
  title: string
  description: string
  /** null until the seller picks a group; until then the group comes from the category list. */
  categoryRoot: string | null
  categoryCode: string
  condition: ItemCondition
  price: string
  province: string
  district: string
}
type Field = 'title' | 'price' | 'categoryCode' | 'description' | 'itemCondition' | 'regionSido' | 'regionSigungu'
type FieldErrors = Partial<Record<Field, string>>
type Conflict = { latest: ListingDetail; changed: Field[] }

const MIN_PRICE = 1_000 // ListingUpdateRequest @Min(1000)
const MAX_PRICE = 100_000_000 // ListingUpdateRequest @Max(100_000_000)
const fieldLabels: Record<Field, string> = {
  title: '상품명', price: '가격', categoryCode: '상품 유형', description: '상품 설명',
  itemCondition: '상품 상태', regionSido: '시·도', regionSigungu: '시·군·구',
}

/** The request fields each form input feeds, so editing an input clears the errors it caused. */
const draftFields: Record<keyof EditDraft, Field[]> = {
  title: ['title'], description: ['description'], categoryRoot: ['categoryCode'], categoryCode: ['categoryCode'],
  condition: ['itemCondition'], price: ['price'], province: ['regionSido', 'regionSigungu'], district: ['regionSigungu'],
}

function draftOf(listing: ListingDetail): EditDraft {
  return {
    title: listing.title, description: listing.description, categoryRoot: null, categoryCode: listing.category.code,
    condition: listing.itemCondition, price: won.format(listing.price),
    province: listing.region.sido, district: listing.region.sigungu,
  }
}

function priceOf(draft: EditDraft) {
  return Number(draft.price.replace(/,/g, ''))
}

/** What the server would store, field by field, so a conflict can name the fields that moved. */
function storedValues(listing: ListingDetail): Record<Field, string> {
  return {
    title: listing.title, price: won.format(listing.price) + '원', categoryCode: listing.category.name,
    description: listing.description, itemCondition: conditionLabels[listing.itemCondition],
    regionSido: listing.region.sido, regionSigungu: listing.region.sigungu,
  }
}

function changedFields(before: ListingDetail, after: ListingDetail): Field[] {
  const a = { ...storedValues(before), categoryCode: before.category.code }
  const b = { ...storedValues(after), categoryCode: after.category.code }
  return (Object.keys(a) as Field[]).filter((field) => a[field] !== b[field])
}

function BackToDetail({ id, children }: { id: string; children: string }) {
  return <div className="mp-state" role="alert">
    <p>{children}</p>
    <Link className="button" to={'/listings/' + encodeURIComponent(id)}>상세로 돌아가기</Link>
  </div>
}

function EditForm({ base, session }: { base: ListingDetail; session: number }) {
  const navigate = useNavigate()
  const { categories, loading, error: categoryError, retry } = useCategories()
  const [initial, setInitial] = useState(() => draftOf(base))
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  // The version the next save is checked against: the loaded one, or the latest after a conflict.
  const [version, setVersion] = useState(base.version)
  const [reference, setReference] = useState(base)
  const [closed, setClosed] = useState('')
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const leaf = categories.find((category) => category.code === draft.categoryCode && category.parentCode !== null)
  const categoriesReady = !loading && !categoryError
  // A category the backend retired is missing from the list; sending it back would be rejected.
  const retired = categoriesReady && draft.categoryCode !== '' && !leaf
  const root = draft.categoryRoot ?? leaf?.parentCode ?? ''
  const categoryCode = leaf ? leaf.code : ''
  const leafCategories = categories.filter((category) => category.parentCode === root)
  const dirty = JSON.stringify({ ...draft, categoryRoot: null }) !== JSON.stringify({ ...initial, categoryRoot: null })
  const lowering = draft.price !== '' && priceOf(draft) < reference.price

  useEffect(() => {
    if (!dirty || closed) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, closed])

  function update<K extends keyof EditDraft>(field: K, value: EditDraft[K]) {
    setDraft((previous) => {
      const next = { ...previous, [field]: value }
      if (field === 'categoryRoot') next.categoryCode = ''
      if (field === 'province') next.district = ''
      return next
    })
    // An error describes the value that was refused; once that field changes it no longer applies.
    const touched = draftFields[field]
    setErrors((previous) => {
      const next = { ...previous }
      for (const key of touched) delete next[key]
      return next
    })
    setLeaving(false)
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {}
    const price = priceOf(draft)
    if (!draft.title.trim()) found.title = '상품명을 입력해 주세요.'
    if (!categoryCode) found.categoryCode = '상품 유형을 골라 주세요.'
    if (!draft.description.trim()) found.description = '상품 설명을 입력해 주세요.'
    if (!draft.price || price < MIN_PRICE || price > MAX_PRICE) found.price = '1,000원부터 100,000,000원까지 입력할 수 있어요.'
    if (!draft.province) found.regionSido = '시·도를 골라 주세요.'
    if (!draft.district.trim()) found.regionSigungu = '시·군·구를 입력해 주세요.'
    return found
  }

  /** Reload after a refusal: a listing that left ACTIVE can no longer be edited, so the form closes. */
  async function reload(): Promise<ListingDetail | null> {
    const latest = await api.listing(base.publicId)
    if (latest.status !== 'ACTIVE') return null
    return latest
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const found = validate()
    setErrors(found)
    setFormError('')
    if (Object.keys(found).length) return
    const input: ListingInput & { version: number } = {
      title: draft.title.trim(),
      price: priceOf(draft),
      categoryCode,
      description: draft.description,
      itemCondition: draft.condition,
      regionSido: draft.province,
      regionSigungu: draft.district.trim(),
      version,
    }
    setBusy(true)
    try {
      await api.updateListing(base.publicId, input)
      if (!mounted.current || authSession.getSnapshot().sessionKey !== session) return
      navigate('/listings/' + encodeURIComponent(base.publicId), { replace: true, state: { edited: true } })
    } catch (cause) {
      if (!mounted.current || authSession.getSnapshot().sessionKey !== session) return
      await explain(cause)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function explain(cause: unknown) {
    if (!(cause instanceof ApiError)) return setFormError(errorMessage(cause))
    if (cause.status === 404) return setClosed('매물을 찾을 수 없어요. 이미 삭제됐을 수 있어요.')
    if (cause.status === 403) return setClosed(cause.message)
    if (cause.code === 'LST001') return setErrors({ price: cause.message })
    if (cause.fieldErrors.length) {
      const next: FieldErrors = {}
      for (const { field, message } of cause.fieldErrors) if (field in fieldLabels) next[field as Field] ??= message
      setErrors(next)
      return setFormError(Object.keys(next).length ? '' : cause.fieldErrors[0].message)
    }
    const retriable = cause.status === 409 && cause.code === 'C009'
    if (!retriable && cause.status !== 400) return setFormError(cause.message)
    // Optimistic-lock conflict, or a refusal that may mean the listing left ACTIVE: read the latest.
    let latest: ListingDetail | null
    try {
      latest = await reload()
    } catch {
      return setFormError(retriable
        ? '다른 곳에서 먼저 수정됐는데 최신 내용을 불러오지 못했어요. 잠시 후 다시 저장해 주세요.'
        : cause.message)
    }
    if (!mounted.current) return
    if (!latest) return setClosed(cause.message)
    if (!retriable) return setFormError(cause.message)
    setConflict({ latest, changed: changedFields(reference, latest) })
    setVersion(latest.version)
    setReference(latest)
  }

  function takeLatest() {
    if (!conflict) return
    const next = draftOf(conflict.latest)
    setInitial(next)
    setDraft(next)
    setErrors({})
    setConflict(null)
  }

  if (closed) return <BackToDetail id={base.publicId}>{closed}</BackToDetail>

  const stored = conflict ? storedValues(conflict.latest) : null
  const note = (field: Field) => conflict?.changed.includes(field) && stored
    ? <small className="mp-note">지금 저장된 값: {stored[field]}</small> : null
  const fieldProps = (field: Field) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? 'edit-' + field + '-error' : undefined,
  })
  const fieldError = (field: Field) => errors[field]
    ? <small id={'edit-' + field + '-error'} className="mp-error">{errors[field]}</small> : null
  const detailPath = '/listings/' + encodeURIComponent(base.publicId)
  const provinces = regions.includes(draft.province) || !draft.province ? regions : [draft.province, ...regions]

  return <form className="mp-sale-grid" noValidate onSubmit={(event) => void save(event)}>
    {/* Saving sends the values shown at the click; locking the fields keeps the screen equal to what was sent. */}
    <fieldset className="mp-sale-sections mp-edit-fields" disabled={busy}>
      {conflict && <div className="mp-inline-alert" role="alert">
        <span><strong>다른 곳에서 먼저 수정됐어요.</strong>{' '}
          {conflict.changed.length
            ? '바뀐 칸: ' + conflict.changed.map((field) => fieldLabels[field]).join(', ') + '. 내가 고친 내용은 그대로 두었어요.'
            : '바뀐 칸은 없어요. 내가 고친 내용으로 다시 저장할 수 있어요.'}</span>
        <div className="actions">
          <button type="button" className="button" onClick={takeLatest}>최신 내용으로 바꾸기</button>
        </div>
      </div>}
      {formError && <p className="mp-error" role="alert">{formError}</p>}
      <section className="panel mp-sale-panel">
        <div className="mp-sale-panel-header"><div><h2>상품 정보</h2><p>구매자가 보는 내용이 바로 바뀌어요.</p></div></div>
        <label>상품명<input value={draft.title} maxLength={100} {...fieldProps('title')}
          onChange={(event) => update('title', event.target.value)} />{note('title')}{fieldError('title')}</label>
        <div className="mp-fields-two">
          <label>상품군<select disabled={loading || !categories.length} value={root}
            onChange={(event) => update('categoryRoot', event.target.value)}>
            <option value="">상품군 선택</option>
            {categories.filter((category) => category.depth === 1).map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
          </select></label>
          <label>상품 유형<select disabled={!leafCategories.length} value={categoryCode} {...fieldProps('categoryCode')}
            onChange={(event) => update('categoryCode', event.target.value)}>
            <option value="">상품 유형 선택</option>
            {leafCategories.map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
          </select>{note('categoryCode')}{fieldError('categoryCode')}</label>
        </div>
        {retired && <p className="mp-note" role="status">지금은 쓰지 않는 분류예요. 상품군과 상품 유형을 다시 골라 주세요.</p>}
        {categoryError && <div className="mp-inline-alert" role="alert"><span>카테고리를 불러오지 못했습니다.</span><button type="button" className="button" onClick={retry}>다시 시도</button></div>}
        <label>상품 상태<select value={draft.condition} {...fieldProps('itemCondition')}
          onChange={(event) => update('condition', event.target.value as ItemCondition)}>
          {Object.entries(conditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>{note('itemCondition')}{fieldError('itemCondition')}</label>
        <label>상품 설명<textarea value={draft.description} rows={5} maxLength={2000} {...fieldProps('description')}
          onChange={(event) => update('description', event.target.value)} />{note('description')}{fieldError('description')}</label>
        <p className="mp-note">사진 수정은 업로드 연동 뒤에 열려요.</p>
      </section>
      <section className="panel mp-sale-panel">
        <div className="mp-sale-panel-header"><div><h2>가격과 지역</h2><p>지역은 시·군·구까지만 공개돼요.</p></div></div>
        <label>판매 가격 <span className="mp-money-field"><input value={draft.price} inputMode="numeric" {...fieldProps('price')}
          onChange={(event) => { const value = formatMoneyInput(event.target.value, MAX_PRICE); if (value !== null) update('price', value) }} /><span>원</span></span>
          {lowering && !errors.price && <small className="mp-note">가격 인하는 하루 2번까지 할 수 있어요.</small>}
          {note('price')}{fieldError('price')}</label>
        <div className="mp-fields-two">
          <label>시·도<select value={draft.province} {...fieldProps('regionSido')} onChange={(event) => update('province', event.target.value)}>
            <option value="">시·도 선택</option>
            {provinces.map((region) => <option key={region} value={region}>{region}</option>)}
          </select>{note('regionSido')}{fieldError('regionSido')}</label>
          <label>시·군·구<input disabled={!draft.province} value={draft.district} maxLength={20} placeholder="예: 강남구" {...fieldProps('regionSigungu')}
            onChange={(event) => update('district', event.target.value)} />{note('regionSigungu')}{fieldError('regionSigungu')}</label>
        </div>
      </section>
    </fieldset>
    <aside className="mp-sale-aside">
      <section className="panel mp-sale-panel mp-sale-end">
        <p className="eyebrow">수정 중인 매물</p><h2>{draft.title || '상품명을 입력해 주세요'}</h2>
        <strong className="mp-draft-price">{draft.price ? draft.price + '원' : '가격 미입력'}</strong>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? '저장 중' : conflict ? '최신 기준으로 다시 저장' : '수정 저장'}</button>
        {leaving ? <div className="mp-inline-alert" role="alert">
          <span>고친 내용을 버릴까요?</span>
          <div className="actions">
            <button type="button" className="button mp-danger" onClick={() => navigate(detailPath)}>버리고 나가기</button>
            <button type="button" className="button" onClick={() => setLeaving(false)}>계속 고치기</button>
          </div>
        </div> : <button type="button" className="button" disabled={busy}
          onClick={() => { if (dirty) setLeaving(true); else navigate(detailPath) }}>취소</button>}
      </section>
    </aside>
  </form>
}

function EditRequest({ id, session }: { id: string; session: number }) {
  const auth = useAuth()
  const [listing, setListing] = useState<ListingDetail | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
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
  if (!auth.account) return <ProfileLoadState />
  if (!listing.seller || listing.seller.publicId !== auth.account.publicId) {
    return <BackToDetail id={id}>내가 올린 매물만 수정할 수 있어요.</BackToDetail>
  }
  if (listing.status !== 'ACTIVE') return <BackToDetail id={id}>판매중인 매물만 수정할 수 있어요.</BackToDetail>
  return <EditForm base={listing} session={session} />
}

export function ListingEditPage() {
  const { id } = useParams()
  const auth = useAuth()
  const location = useLocation()
  return <section>
    <div className="mp-page-heading"><p className="eyebrow">내 매물</p><h1>매물 수정</h1><p>바꾼 내용은 저장하면 바로 공개돼요.</p></div>
    {!id ? <p className="mp-state">매물을 찾을 수 없습니다.</p>
      : !auth.ready ? <p className="mp-state" role="status">로그인 상태를 확인하는 중입니다.</p>
      : !auth.authenticated ? <div className="mp-state"><p>로그인하면 내 매물을 수정할 수 있어요.</p>
        <Link className="button primary" to="/login" state={{ from: location }}>로그인</Link></div>
      // A new session (logout, another account) starts from a fresh load: no draft or version carries over.
      : <EditRequest key={id + ':' + auth.sessionKey} id={id} session={auth.sessionKey} />}
  </section>
}
