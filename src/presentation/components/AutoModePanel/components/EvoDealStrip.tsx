// EvoDealStrip — 배팅 자리와 큰길 사이의 '테이블' 띠.
//   배팅 중: 이전 판 카드·점수(흐리게)  → 마감·딜링: 카드가 오는 순서대로 뒤집히며 점수 상승
//   → 결과: 이긴 쪽이 빛나고, 우리가 걸었으면 적중/미적중과 손익. 다음 배팅창이 열릴 때까지 유지.
// 카드 코드가 없는 피드(프라그마틱 등)는 뒷면 카드 + 점수만으로 같은 흐름을 보여준다.
import { memo } from 'react'
import type { Room } from '../../../../domain/entities'
import { parseCard } from '../utils/cards'
import type { RoomBetLog } from './AutoModeRoomGrid'

interface EvoDealStripProps {
  room: Room
  /** 이 방의 최근 배팅 로그(최신 먼저) */
  betLogs: RoomBetLog[]
}

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

export const EvoDealStrip = memo(function EvoDealStrip({ room, betLogs }: EvoDealStripProps) {
  const phase = room.phase
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
