import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Siren } from 'lucide-react'
import { api, ApiError } from './api'
import type { ListingReportReason, ReportReceipt } from './api'
import { useAuth } from './auth'

export const DETAIL_LIMIT = 1000

/** 매물에 고를 수 있는 사유. 백엔드 ReportReason의 사유×대상 매트릭스에서 LISTING이 허용된 것만 둔다. */
export const listingReasons: { code: ListingReportReason; label: string; hint: string }[] = [
  { code: 'FRAUD', label: '사기 의심', hint: '선입금 유도, 가품, 실제로 없는 물건 등' },
  { code: 'PROHIBITED', label: '거래 금지 품목', hint: '법이나 운영 정책상 거래할 수 없는 물건' },
  { code: 'SPAM', label: '스팸·광고', hint: '같은 글 반복, 외부 사이트나 업체 홍보' },
  { code: 'IMPERSONATION', label: '사칭', hint: '다른 사람이나 업체인 척하는 판매자' },
  { code: 'ETC', label: '기타', hint: '위에 없는 문제. 아래에 내용을 적어 주세요.' },
]

/** 신고 고유 오류(RPT)는 다음 행동이 보이도록 화면 문구로 바꾸고, 나머지는 서버 문구를 그대로 쓴다. */
const reportErrors: Record<string, string> = {
  RPT001: '이미 같은 사유로 접수한 신고가 있어요. 검토가 끝날 때까지 기다리거나 다른 사유를 골라 주세요.',
  RPT002: '같은 사유의 신고는 이미 처리가 끝났어요. 다른 문제라면 다른 사유를 골라 주세요.',
  RPT003: '신고는 하루 10건까지 할 수 있어요. 내일 다시 시도해 주세요.',
  RPT004: '이 매물에는 고를 수 없는 사유예요. 다른 사유를 골라 주세요.',
  RPT006: '내가 올린 매물은 신고할 수 없어요.',
  RPT007: '이미 제재가 끝난 매물이에요.',
}

export function reportErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code && reportErrors[error.code]) return reportErrors[error.code]
  return error instanceof Error ? error.message : '신고를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'
}

const time = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' })

type Step = { kind: 'closed'; notice?: string } | { kind: 'form' } | { kind: 'sent'; receipt: ReportReceipt }

export function ListingReport({ listingId }: { listingId: string }) {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>({ kind: 'closed' })
  const [reason, setReason] = useState<ListingReportReason | null>(null)
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function open() {
    if (!auth.authenticated) {
      navigate('/login', { state: { from: location.pathname + location.search } })
      return
    }
    setError('')
    setStep({ kind: 'form' })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!reason) {
      setError('신고 사유를 골라 주세요.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const receipt = await api.reportListing(listingId, reason, detail)
      setStep({ kind: 'sent', receipt })
      setReason(null)
      setDetail('')
    } catch (cause) {
      setError(reportErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(reportId: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.cancelReport(reportId)
      setStep({ kind: 'closed', notice: '신고를 취소했어요.' })
    } catch (cause) {
      setError(reportErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (step.kind === 'sent') {
    return <div className="mp-report panel" role="status">
      <strong>신고를 접수했어요</strong>
      <p className="muted">{time.format(new Date(step.receipt.receivedAt))} 접수 · 운영팀이 확인한 뒤 조치해요.</p>
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={() => void cancel(step.receipt.reportId)}>
          {busy ? '취소하는 중' : '신고 취소'}
        </button>
      </div>
      {error && <p className="mp-error" role="alert">{error}</p>}
    </div>
  }

  if (step.kind === 'form') {
    return <form className="mp-report panel" aria-label="매물 신고" onSubmit={submit} noValidate>
      <fieldset>
        <legend>신고 사유</legend>
        {listingReasons.map((item, index) => <label key={item.code} className="mp-report-reason">
          <input type="radio" name="report-reason" value={item.code} checked={reason === item.code} autoFocus={index === 0}
            onChange={() => { setReason(item.code); setError('') }} />
          <span><strong>{item.label}</strong><small>{item.hint}</small></span>
        </label>)}
      </fieldset>
      <label className="stack mp-report-detail">
        <span>자세한 내용 <span className="muted">(선택)</span></span>
        <textarea rows={4} maxLength={DETAIL_LIMIT} value={detail} onChange={(event) => setDetail(event.target.value)}
          placeholder="언제, 어떤 문제가 있었는지 적어 주면 확인이 빨라요." aria-describedby="report-detail-count" />
        <small id="report-detail-count" className="muted">{detail.length.toLocaleString('ko-KR')} / {DETAIL_LIMIT.toLocaleString('ko-KR')}자</small>
      </label>
      {error && <p className="mp-error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" className="button mp-danger" disabled={busy}>{busy ? '접수하는 중' : '신고 접수'}</button>
        <button type="button" className="button" disabled={busy} onClick={() => { setStep({ kind: 'closed' }); setError('') }}>닫기</button>
      </div>
    </form>
  }

  return <div className="mp-report-entry">
    {step.notice && <p className="mp-note" role="status">{step.notice}</p>}
    <button type="button" className="button mp-report-open" disabled={!auth.ready} onClick={open}>
      <Siren size={16} aria-hidden="true" /> 이 매물 신고하기
    </button>
  </div>
}
