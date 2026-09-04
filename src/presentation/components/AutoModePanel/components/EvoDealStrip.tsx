// EvoDealStrip — 배팅 자리와 큰길 사이의 '테이블' 띠.
//   배팅 중: 이전 판 카드·점수(흐리게)  → 마감·딜링: 카드가 오는 순서대로 뒤집히며 점수 상승
//   → 결과: 이긴 쪽이 빛나고, 우리가 걸었으면 적중/미적중과 손익. 다음 배팅창이 열릴 때까지 유지.
// 카드 코드가 없는 피드(프라그마틱 등)는 뒷면 카드 + 점수만으로 같은 흐름을 보여준다.
import { memo } from 'react'
import type { Room } from '../../../../domain/entities'
import type { ManualSide } from '../../../../application/services/ManualBetService'
import { parseCard } from '../utils/cards'
import type { RoomBetLog } from './AutoModeRoomGrid'

/** 수동 모드에서 배팅창이 열린 방: 어디에 걸지 크게 알려주는 배너 입력 */
export interface ManualCta {
  side: ManualSide | null
  betSide: ManualSide | null
  betTotal: number
  secondsLeft: number
  recommended: boolean
  /** 마틴 따라가기일 때 이 방에 올라갈 금액 */
  suggestedAmount?: number | null
  /** 연패 중이면 현재 마틴 단계(1부터) */
  martinStage?: number | null
}

interface EvoDealStripProps {
  room: Room
  /** 이 방의 최근 배팅 로그(최신 먼저) */
  betLogs: RoomBetLog[]
  cta?: ManualCta | null
}

const SIDE_LABEL: Record<ManualSide, string> = { B: '뱅커', P: '플레이어', T: '타이' }

type Mode = 'empty' | 'previous' | 'dealing' | 'result'
const RESULT_HOLD_MS = 25_000

function CardFace({ code, idx, animate }: { code: unknown; idx: number; animate: boolean }) {
  const card = parseCard(code)
  const cls = ['evo-playcard', idx === 2 ? 'is-third' : '', animate ? 'is-flip' : '', card?.red ? 'is-red' : ''].filter(Boolean).join(' ')
  if (!card) return <span className={`${cls} is-back`} aria-hidden="true" />
  return (
    <span className={cls} aria-label={`${card.rank}${card.symbol}`}>
      <span className="evo-playcard__rank">{card.rank}</span>
      <span className="evo-playcard__suit">{card.symbol}</span>
    </span>
  )
}

function Hand({ side, cards, backs, animate }: { side: 'P' | 'B'; cards: unknown[]; backs: number; animate: boolean }) {
  const shown = cards.length > 0 ? cards : Array.from({ length: backs }).map(() => null)
  return (
    <span className={`evo-hand evo-hand--${side.toLowerCase()}`}>
      {shown.map((c, i) => (
        <CardFace key={`${i}:${String(c)}`} code={c} idx={i} animate={animate} />
      ))}
    </span>
  )
}

export const EvoDealStrip = memo(function EvoDealStrip({ room, betLogs, cta = null }: EvoDealStripProps) {
  const phase = room.phase

  // 수동 모드 + 배팅창 열림: 이전 판 대신 '어디에 걸지'를 크게 보여준다.
  if (cta) {
    const side = cta.betSide ?? cta.side
    const label = side ? SIDE_LABEL[side] : null
    const hasBet = cta.betTotal > 0
    const amountText = cta.suggestedAmount ? ` ${cta.suggestedAmount.toLocaleString()}원` : ''
    const stageText = cta.martinStage ? ` · 마틴 ${cta.martinStage}단계` : ''
    const title = hasBet
      ? `${label} ${cta.betTotal.toLocaleString()}원 걸림`
      : label ? `${label}에${amountText} 배팅하세요` : '예측 기다리는 중'
    const sub = hasBet
      ? '더 올리려면 같은 자리를 다시 누르세요'
      : label ? `${cta.recommended ? '추천 방 · ' : ''}${label} 자리를 누르면 칩이 올라갑니다${stageText}` : `배팅 가능 · 예측이 오면 자리를 알려드려요${stageText}`
    return (
      <div className={`evo-deal evo-deal--cta side-${side ? side.toLowerCase() : 'none'} ${hasBet ? 'has-bet' : ''}`} role="status" aria-label={title}>
        <div className="evo-deal__cta-main">
          <strong>{title}</strong>
          <span>{sub}</span>
        </div>
        <div className={`evo-deal__cta-timer ${cta.secondsLeft <= 3 ? 'is-urgent' : ''}`}>
          <b>{cta.secondsLeft}</b>초
        </div>
      </div>
    )
  }
  const last = room.history[0]
  const recentResult = !!room.lastResultTime && Date.now() - room.lastResultTime < RESULT_HOLD_MS

  let mode: Mode = 'empty'
  if (phase === 'betting') mode = last ? 'previous' : 'empty'
  else if (phase === 'dealing') mode = 'dealing'
  else if (phase === 'result' || recentResult) mode = 'result'
  else if (last) mode = 'previous'

  // 어댑터가 gameId 전환 시 gameState를 비우고 previousGameState에 직전 판을 둔다 → 배팅 중엔 이전 판,
  // 딜링·결과엔 이번 판 카드만 쓴다(참조 비교 추정 없음 = 옛 카드가 이번 판으로 보이는 불일치 제거).
  const hand = mode === 'previous' ? (room.previousGameState ?? room.gameState) : room.gameState
  const pCards = hand?.playerHand?.cards ?? []
  const bCards = hand?.bankerHand?.cards ?? []
  const dealt = pCards.length > 0 || bCards.length > 0

  const pScore = mode === 'dealing'
    ? (dealt ? hand?.playerHand?.score ?? null : null)
    : (last?.playerScore ?? hand?.playerHand?.score ?? null)
  const bScore = mode === 'dealing'
    ? (dealt ? hand?.bankerHand?.score ?? null : null)
    : (last?.bankerScore ?? hand?.bankerHand?.score ?? null)
  const winner = mode === 'dealing' ? null : (last?.winner ?? null)

  // 우리 배팅 결과(이 라운드에 속하는 최근 정산 로그)
  const ours = betLogs.find(l => l.status === 'win' || l.status === 'loss' || l.status === 'tie')
  const oursRecent = ours && Date.now() - ours.timestamp < 90_000 ? ours : null

  const caption = (() => {
    if (mode === 'dealing') return dealt ? '딜링 중' : '카드 대기'
    if (mode === 'empty') return '첫 판을 기다리는 중'
    const who = winner === 'B' ? '뱅커 승' : winner === 'P' ? '플레이어 승' : winner === 'T' ? '타이' : ''
    if (oursRecent && mode === 'result') {
      if (oursRecent.status === 'tie') return `${who} · 환불`
      const sign = oursRecent.profit > 0 ? '+' : ''
      return `${who} · ${oursRecent.status === 'win' ? '적중' : '미적중'} ${sign}${oursRecent.profit.toLocaleString()}원`
    }
    return mode === 'previous' ? `이전 판 · ${who}` : who
  })()

  const outcomeClass = mode === 'result' && oursRecent
    ? (oursRecent.status === 'win' ? 'is-win' : oursRecent.status === 'loss' ? 'is-loss' : 'is-push')
    : ''

  return (
    <div className={`evo-deal evo-deal--${mode} ${outcomeClass}`} role="status" aria-label={caption}>
      <div className={`evo-deal__side evo-deal__side--p ${winner === 'P' ? 'is-winner' : ''}`}>
        <Hand side="P" cards={pCards} backs={2} animate={mode === 'dealing'} />
      </div>
      <div className="evo-deal__center">
        <div className="evo-deal__score">
          <span className={`evo-deal__num side-p ${winner === 'P' ? 'is-winner' : ''}`}>{pScore ?? '–'}</span>
          <span className="evo-deal__colon">:</span>
          <span className={`evo-deal__num side-b ${winner === 'B' ? 'is-winner' : ''}`}>{bScore ?? '–'}</span>
        </div>
        <div className="evo-deal__caption">{caption}</div>
      </div>
      <div className={`evo-deal__side evo-deal__side--b ${winner === 'B' ? 'is-winner' : ''}`}>
        <Hand side="B" cards={bCards} backs={2} animate={mode === 'dealing'} />
      </div>
    </div>
  )
})

export default EvoDealStrip
