// EvoRoomCard — 자동배팅 방 카드, Evolution 멀티위젯 타일 레이아웃.
//   [₩배팅금] [테이블 이름] [라운드 진행]
//   [플레이어 페어][플레이어][무][뱅커][뱅커 페어]  ← 프로그램이 건 자리에 금액 칩
//   [큰길 SVG]                                       ← 승/패 결과 오버레이
//   [P? ○●/ B? ○●/]                    [P n B n T n]
// 메모리/성능: memo + 큰길 모델을 history 참조로 메모. 카드 재렌더는 그 방 데이터가 바뀔 때만.
import { memo, useEffect, useMemo, useState } from 'react'
import type { Room, RoomFilterType, Prediction } from '../../../../domain/entities'
import type { RoomBettingState, AutoModeSettings } from '../../../../application/services/AutoModeService'
import type { ManualRoomBet, ManualSide } from '../../../../application/services/ManualBetService'
import { buildBigRoad, predictDerived, type DerivedMark, type DerivedPrediction } from '../../../../domain/roads/bigRoad'
import { getRoomStatusChip, getFilterShortLabel, getRoomProgressionDisplay, isTieFilterLabel } from '../utils/autoModeStatus'
import { RoundProgress } from './RoundProgress'
import { EvoBigRoad } from './EvoBigRoad'
import { EvoChip } from './EvoChip'
import { EvoDealStrip } from './EvoDealStrip'
import type { RoomBetLog } from './AutoModeRoomGrid'
import './EvoRoomCard.css'

export interface EvoRoomCardProps {
  room: Room
  autoState: RoomBettingState | null
  isEnabled: boolean
  isAutoEnabled: boolean
  isFlashing: boolean
  betLogs: RoomBetLog[]
  timer: number
  settings: AutoModeSettings
  activeFilters?: RoomFilterType[]
  /** 수동(반자동) 모드: 자리를 눌러 칩을 올린다 */
  manualActive?: boolean
  manualBet?: ManualRoomBet | null
  /** AI 예측(수동 모드에서 추천 자리 표시) */
  prediction?: Prediction | null
  onManualSpot?: (room: Room, side: ManualSide) => void
  onManualUndo?: (room: Room) => void
  onManualClear?: (room: Room) => void
}

const RESULT_OVERLAY_MS = 4000
const MANUAL_MIN_LEAD_MS = 1200
const RECOMMEND_CONFIDENCE = 0.65

function markClass(m: DerivedMark | null): string {
  return m === 'R' ? 'mark-r' : m === 'B' ? 'mark-b' : 'mark-none'
}

/** 파생로드 3종 예측 글리프: 빅아이보이(링) · 스몰로드(점) · 바퀴벌레(사선) */
function DerivedMarks({ pred }: { pred: DerivedPrediction }) {
  return (
    <svg className="evo-ask__marks" viewBox="0 0 42 14" width="42" height="14" aria-hidden="true">
      <circle className={`evo-mark ${markClass(pred.bigEye)}`} cx="7" cy="7" r="4.6" fill="none" />
      <circle className={`evo-mark evo-mark--solid ${markClass(pred.small)}`} cx="21" cy="7" r="4.6" />
      <line className={`evo-mark evo-mark--slash ${markClass(pred.cockroach)}`} x1="31" y1="12" x2="39" y2="2" />
    </svg>
  )
}

export const EvoRoomCard = memo(function EvoRoomCard({
  room,
  autoState,
  isEnabled,
  isAutoEnabled,
  isFlashing: _isFlashing, // 플래시 연출 제거 — 프롭은 호환용
  betLogs,
  timer,
  settings,
  activeFilters,
  manualActive = false,
  manualBet = null,
  prediction = null,
  onManualSpot,
  onManualUndo,
  onManualClear,
}: EvoRoomCardProps) {
  const model = useMemo(() => buildBigRoad(room.history), [room.history])
  const asks = useMemo(
    () => ({ P: predictDerived(model.columns, 'P'), B: predictDerived(model.columns, 'B') }),
    [model],
  )

  // 수동 모드: 걸린 자리(칩) 또는 AI 추천 자리(점선). 자동 모드: 자동배팅 상태.
  const predSide: ManualSide | null = manualActive && prediction && !prediction.isSkip && prediction.prediction
    ? (prediction.prediction as ManualSide)
    : null
  const predConf = Math.round((prediction?.confidence ?? 0) * 100)
  const isRecommended = manualActive && !!predSide && (prediction?.confidence ?? 0) >= RECOMMEND_CONFIDENCE
  const isBetting = manualActive ? !!manualBet : autoState?.waitingForResult === true
  const activeSide: ManualSide | null = manualActive
    ? (manualBet?.side ?? predSide)
    : (isAutoEnabled ? (autoState?.lastPrediction?.prediction ?? autoState?.martinRecoveryPrediction?.prediction ?? null) : null)
  const windowOpen = room.phase === 'betting'
    && (room.bettingDeadlineAt === undefined || room.bettingDeadlineAt - Date.now() >= MANUAL_MIN_LEAD_MS)

  const statusChip = useMemo(
    () => getRoomStatusChip(autoState, settings, isEnabled, isAutoEnabled),
    [autoState, settings, isEnabled, isAutoEnabled],
  )
  const filterLabel = useMemo(() => getFilterShortLabel(activeFilters), [activeFilters])
  const isTieFilter = isTieFilterLabel(filterLabel)
  const progression = useMemo(
    () => getRoomProgressionDisplay(settings, autoState, { isTieBet: isTieFilter }),
    [settings, autoState, isTieFilter],
  )
  const amount = manualActive
    ? (manualBet?.total ?? 0)
    : (isBetting && (autoState?.lastBetAmount ?? 0) > 0 ? autoState!.lastBetAmount : progression.amount)
  const stageRisk = progression.stage >= Math.max(3, progression.maxStage - 1)
  const stageWarn = progression.stage > 1

  const roomProfit = useMemo(() => betLogs.reduce((sum, l) => sum + (l.profit || 0), 0), [betLogs])

  // 최근 승/패 — 카드 테두리 플래시(4초). 결과 자체는 딜링 스트립이 다음 배팅창까지 보여준다.
  const recentResult = useMemo(() => {
    const now = Date.now()
    return betLogs.slice(0, 2).find(l => (l.status === 'win' || l.status === 'loss') && now - l.timestamp < RESULT_OVERLAY_MS) ?? null
  }, [betLogs])
  const [, bump] = useState(0)
  useEffect(() => {
    if (!recentResult) return
    const remain = RESULT_OVERLAY_MS - (Date.now() - recentResult.timestamp)
    const id = setTimeout(() => bump(v => v + 1), Math.max(0, remain) + 20)
    return () => clearTimeout(id)
  }, [recentResult])
  const flashClass = recentResult && Date.now() - recentResult.timestamp < RESULT_OVERLAY_MS
    ? (recentResult.status === 'win' ? 'is-won' : 'is-lost')
    : ''

  const statusClass = manualActive
    ? (manualBet ? 'betting' : predSide ? 'armed' : 'idle')
    : (!isEnabled ? 'disabled' : isBetting ? 'betting' : activeSide ? 'armed' : 'idle')
  const sideClass = activeSide === 'B' ? 'side-b' : activeSide === 'P' ? 'side-p' : activeSide === 'T' ? 'side-t' : ''
  const name = room.koreanName || room.name

  const spot = (side: 'P' | 'T' | 'B', label: string) => {
    const on = activeSide === side
    const hasManualChips = manualActive && manualBet?.side === side
    const predictedHere = manualActive && !manualBet && predSide === side
    const cls = [
      'evo-spot', `evo-spot--${side.toLowerCase()}`,
      on ? (isBetting ? 'is-betting' : 'is-armed') : '',
      manualActive ? 'is-clickable' : '',
      manualActive && !windowOpen ? 'is-closed' : '',
      predictedHere ? 'is-predicted' : '',
    ].filter(Boolean).join(' ')
    const chip = hasManualChips
      ? <EvoChip amount={manualBet!.total} stack={manualBet!.chips.length} size={34} />
      : (!manualActive && on ? <EvoChip amount={amount} stack={progression.stage} size={34} /> : null)
    const predTag = predictedHere ? <span className="evo-spot__pred">추천 {predConf}%</span> : null
    if (manualActive) {
      return (
        <button
          type="button"
          className={cls}
          disabled={!windowOpen || manualBet?.sending}
          onClick={() => onManualSpot?.(room, side)}
          title={windowOpen ? `${label}에 칩 올리기` : '배팅창이 닫혀 있어요'}
        >
          <span className="evo-spot__label">{label}</span>
          {chip}
          {predTag}
        </button>
      )
    }
    return (
      <div className={cls}>
        <span className="evo-spot__label">{label}</span>
        {chip}
      </div>
    )
  }

  return (
    <article
      className={`evo-card evo-card--${statusClass} ${sideClass} ${flashClass} ${manualActive ? 'evo-card--manual' : ''}`}
      aria-label={name}
    >
      <header className="evo-card__head">
        <span className={`evo-card__amount ${isBetting ? 'is-live' : ''}`} title={isBetting ? '배팅 중 금액' : '다음 배팅 금액'}>
          ₩ {amount.toLocaleString()}
        </span>
        <h3 className="evo-card__name" title={name}>{name}</h3>
        <RoundProgress
          remainingSeconds={timer}
          windowMs={room.bettingWindowMs}
          phase={room.phase}
          waitingForResult={isBetting}
          compact
          className="evo-card__round"
        />
      </header>

      <div className="evo-card__meta">
        {manualActive ? (
          <>
            {manualBet ? (
              <span className="evo-chip tone-betting">
                {manualBet.side === 'B' ? '뱅커' : manualBet.side === 'P' ? '플레이어' : '타이'} {manualBet.total.toLocaleString()}원
                {manualBet.sending ? ' · 전송 중' : manualBet.unconfirmed ? ' · 확인 대기' : ''}
              </span>
            ) : predSide ? (
              <span className="evo-chip tone-observing" title={prediction?.reasoning || 'AI 예측'}>
                AI 추천 {predSide === 'B' ? '뱅커' : predSide === 'P' ? '플레이어' : '타이'} {predConf}%
              </span>
            ) : (
              <span className="evo-chip tone-idle">{prediction?.isSkip ? 'AI 패스' : windowOpen ? '예측 대기' : '다음 판 대기'}</span>
            )}
            {isRecommended && <span className="evo-chip evo-chip--recommend">추천 방</span>}
            {filterLabel && (
              <span className={`evo-chip evo-chip--reason ${isTieFilter ? 'tie-tone' : ''}`}>{filterLabel}</span>
            )}
            {/* 빼기·취소는 수동 모드에서 항상 보인다(칩이 없거나 마감이면 비활성) */}
            <span className="evo-card__manual-actions">
              <button type="button" className="evo-card__mini-btn" disabled={!manualBet || !windowOpen || manualBet.sending} onClick={() => onManualUndo?.(room)} title="마지막 칩 빼기">↶ 빼기</button>
              <button type="button" className="evo-card__mini-btn is-danger" disabled={!manualBet || !windowOpen || manualBet.sending} onClick={() => onManualClear?.(room)} title="이 방 칩 전부 빼기">✕ 취소</button>
            </span>
          </>
        ) : (
          <>
            <span className={`evo-chip tone-${statusChip.tone}`}>{statusChip.text}</span>
            {filterLabel && (
              <span className={`evo-chip evo-chip--reason ${isTieFilter ? 'tie-tone' : ''}`} title="이 방이 배팅 대상에 들어온 이유">{filterLabel}</span>
            )}
            <span className={`evo-card__stage ${stageRisk ? 'is-danger' : stageWarn ? 'is-warn' : ''}`} title={progression.strategyLabel}>
              {progression.stepLabel}/{progression.maxStage}단계
            </span>
            <span className="evo-card__wl">{autoState?.totalWins || 0}승 {autoState?.totalLosses || 0}패</span>
          </>
        )}
        {roomProfit !== 0 && (
          <span className={`evo-card__profit ${roomProfit > 0 ? 'is-pos' : 'is-neg'}`}>
            {roomProfit > 0 ? '+' : ''}{roomProfit.toLocaleString()}
          </span>
        )}
      </div>

      <div className="evo-card__spots" role="img" aria-label={activeSide ? `${activeSide === 'B' ? '뱅커' : activeSide === 'P' ? '플레이어' : '타이'}에 ${amount.toLocaleString()}원` : '배팅 없음'}>
        <div className="evo-spot evo-spot--pp"><span className="evo-spot__label">플레이어<br />페어</span></div>
        {spot('P', '플레이어')}
        {spot('T', '무')}
        {spot('B', '뱅커')}
        <div className="evo-spot evo-spot--bp"><span className="evo-spot__label">뱅커<br />페어</span></div>
      </div>

      <EvoDealStrip room={room} betLogs={betLogs} />

      <div className="evo-card__road">
        <EvoBigRoad model={model} />
      </div>

      <footer className="evo-card__foot">
        <div className="evo-card__asks" title="다음 판이 플레이어/뱅커일 때 파생로드(빅아이보이·스몰로드·바퀴벌레) 마크">
          <span className="evo-ask"><b className="side-p">P?</b><DerivedMarks pred={asks.P} /></span>
          <span className="evo-ask"><b className="side-b">B?</b><DerivedMarks pred={asks.B} /></span>
        </div>
        <div className="evo-card__counts" aria-label={`플레이어 ${model.counts.P} 뱅커 ${model.counts.B} 타이 ${model.counts.T}`}>
          <span className="evo-count side-p"><i>P</i>{model.counts.P}</span>
          <span className="evo-count side-b"><i>B</i>{model.counts.B}</span>
          <span className="evo-count side-t"><i>T</i>{model.counts.T}</span>
        </div>
      </footer>
    </article>
  )
})

export default EvoRoomCard
