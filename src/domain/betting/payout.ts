// Baccarat payout — single source of truth for win/loss/push money math.
//
// 이 모듈은 바카라 손익 계산을 한 곳에 모은다. 이전에는 AutoModeService / VirtualBettingService /
// SemiAutoService / AutoBettingService / ResultProcessor 가 각자 뱅커 5% 수수료를
// round / floor / 무반올림으로 제각각 계산해 엔진 간 손익이 미세하게 어긋났다(dup-1, calc-1, calc-2).
//
// 배당 규칙:
//   - 플레이어 승리: 1:1
//   - 뱅커 승리:    0.95:1 (5% 수수료)
//   - 타이 적중:    8:1
//   - 타이 결과 + B/P 베팅: PUSH (환불, 손익 0)
// 반올림 정책: Math.round (라이브 AutoMode/VirtualBetting의 기존 관례와 동일 → 라운드 금액엔 영향 없음).

import { TIE_PAYOUT_MULTIPLIER } from '../entities'

/** 뱅커 승리 시 차감되는 수수료 비율 (5%) */
export const BANKER_COMMISSION = 0.05

/** 베팅/예측한 쪽 또는 실제 결과 */
export type BetSide = 'B' | 'P' | 'T'

/** 뱅커 승리 순이익: 5% 수수료 적용 후 반올림 */
export function bankerWinProfit(stake: number): number {
  return Math.round(stake * (1 - BANKER_COMMISSION))
}

/**
 * 승리 시 순이익(net profit)을 단일 정책으로 계산한다.
 * @param betSide 베팅한 쪽 ('B' | 'P' | 'T')
 * @param stake   배팅 금액
 */
export function winProfit(betSide: BetSide, stake: number): number {
  if (betSide === 'T') return Math.round(stake * TIE_PAYOUT_MULTIPLIER)
  if (betSide === 'B') return bankerWinProfit(stake)
  return Math.round(stake) // 플레이어 1:1
}

/**
 * 한 판의 순손익(net profit)을 단일 정책으로 계산한다.
 * @param betSide 베팅한 쪽 ('B' | 'P' | 'T')
 * @param winner  실제 결과 ('B' | 'P' | 'T')
 * @param stake   배팅 금액
 * @returns 승=양수, 패=-stake, 무(B/P 베팅 + T 결과)=0(환불)
 */
export function computeNetProfit(betSide: BetSide, winner: BetSide, stake: number): number {
  if (betSide === winner) return winProfit(betSide, stake)
  if (winner === 'T') return 0 // B/P 베팅인데 타이 → PUSH(환불)
  return -stake
}
