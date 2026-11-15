export type BadgeTone = 'verified' | 'unverified' | 'suspected';

export interface Badge {
  tone: BadgeTone;
  label: string;
  description: string;
}

export const badges: Record<BadgeTone, Badge> = {
  verified: { tone: 'verified', label: '인증됨', description: '챌린지 코드와 실물이 인증샷으로 확인됐어요.' },
  unverified: { tone: 'unverified', label: '미인증', description: '아직 인증샷 검증을 받지 않은 매물이에요.' },
  suspected: { tone: 'suspected', label: '위조 의심', description: '인증샷에서 위조 신호가 발견돼 검수 중이에요.' },
};

const toneByCode: Record<string, BadgeTone> = {
  APPROVED: 'verified',
  VERIFIED: 'verified',
  NONE: 'unverified',
  UNVERIFIED: 'unverified',
  PENDING: 'unverified',
  SUSPECTED: 'suspected',
  FORGERY_SUSPECTED: 'suspected',
  REJECTED: 'suspected',
};

/** Maps the server's verificationBadge code to a badge, or null when there is nothing to show. */
export function badgeFor(code: string | null | undefined): Badge | null {
  if (!code) return null;
  const tone = toneByCode[code.toUpperCase()];
  return tone ? badges[tone] : null;
}
