import type { BetOutcome, Winner } from '../entities'

/** 예측 방향(B/P/T) → Evolution 베팅 spot 평문명. */
export function predResultToSpot(predResult: Winner): 'Banker' | 'Player' | 'Tie' {
  return predResult === 'B' ? 'Banker' : predResult === 'P' ? 'Player' : 'Tie'
}

/**
 * 실배팅 정산 정확도(2026-06-23): Evolution이 내 베팅을 **거절**했는지 판정.
 *
 * 거절(rejectedBets, 예: error '1013' = 최소 배팅금액 미달)된 베팅은 지갑이 움직이지 않았으므로
 * 손익/마틴에 반영하면 안 된다(가짜 정산 = "돈만 나가고 이겨도 안 들어옴"의 원인).
 *
 * 보수적 판정: **명시적 거절만** true. betOutcome이 없거나(히스토리 경유) rejectedBets에 내 spot이
 * 없으면 false → 기존 정산 로직으로 폴백(정상 체결을 잘못 누락하지 않기 위함).
 */
export function isBetRejected(
  betOutcome: BetOutcome | undefined,
  predResult: Winner,
): { rejected: boolean; errorCode?: string } {
  const rejected = betOutcome?.rejectedBets
  if (!rejected) return { rejected: false }
  const spot = predResultToSpot(predResult)
  const entry = rejected[spot]
  if (entry) return { rejected: true, errorCode: entry.error }
  return { rejected: false }
}

/** Returns true only when Evolution explicitly reports a positive accepted amount for this spot. */
export function isBetAccepted(betOutcome: BetOutcome | undefined, predResult: Winner): boolean {
  const accepted = betOutcome?.acceptedBets
  if (!accepted) return false
  const entry = accepted[predResultToSpot(predResult)]
  if (typeof entry === 'number') return entry > 0
  return typeof entry?.amount === 'number' && entry.amount > 0
}
