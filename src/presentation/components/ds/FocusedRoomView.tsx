// FocusedRoomView — 통합 디자인시스템: 세 작업 공용 '한 방 자세히' (Level 2)
// 리디자인 2단계. 큰길 dominant + 비드플레이트 + 뱅커/플레이어/타이 카운트 상시 +
// 30px 한글 예측칩 + 단일 주요 액션 + [자세히 보기 ▾] 점진적 공개.
// 로드맵은 슬롯(ReactNode)으로 받아 기존 BigRoad/BeadPlate를 배선 단계에서 꽂음(중복 렌더 방지).
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AppShell } from './AppShell'
import { PredictionChip, type PredictionValue } from './PredictionChip'
import './FocusedRoomView.css'

interface FocusedRoomViewProps {
  roomName: string
  /** 빵부스러기(예: '살펴보기 › 스피드 바카라 A › 자세히') */
  breadcrumb: string
  connection?: 'online' | 'offline'
  freshness?: string

  /** 다음 예측 */
  prediction: PredictionValue
  confidence?: number

  /** 뱅커/플레이어/타이 카운트(항상 표시) */
  counts: { banker: number; player: number; tie: number }
  /** 슈 진행(예: 32/78패) */
  shoeProgress?: { played: number; total: number }
  /** 한글 패턴 라벨(예: '뱅커 3연속 (장줄)') */
  patternLabel?: string

  /** 큰길/비드플레이트 — 배선 단계에서 실제 컴포넌트 주입 */
  bigRoadSlot?: ReactNode
  beadPlateSlot?: ReactNode

  /** 단일 주요 액션(살펴보기='이 방에서 도움받기', 자동맡기기='이 방만 자동 끄기' 등) */
  primaryActionLabel: string
  onPrimaryAction: () => void
  primaryDanger?: boolean

  /** [자세히 보기 ▾] 뒤로 숨기는 고급 내용(파생 로드/전략/마틴/기록) */
  detail?: ReactNode
  detailLabel?: string

  /** ← 방 목록 복귀 */
  onBack: () => void
  backLabel?: string
  className?: string
}

export function FocusedRoomView({
  roomName,
  breadcrumb,
  connection = 'online',
  freshness,
  prediction,
  confidence,
  counts,
  shoeProgress,
  patternLabel,
  bigRoadSlot,
  beadPlateSlot,
  primaryActionLabel,
  onPrimaryAction,
  primaryDanger = false,
  detail,
  detailLabel = '자세히 보기',
  onBack,
  backLabel = '← 방 목록',
  className = '',
}: FocusedRoomViewProps) {
  const [detailOpen, setDetailOpen] = useState(false)

  return (
    <AppShell
      backLabel={backLabel}
      onBack={onBack}
      breadcrumb={breadcrumb}
      connection={connection}
      freshness={freshness}
    >
      <div className={`focused-room ${className}`} aria-label={roomName}>
        <div className="focused-room__top">
          <div className="focused-room__pred">
            <span className="focused-room__pred-label">다음 예측</span>
            <PredictionChip value={prediction} size="hero" confidence={confidence} />
          </div>

          <div className="focused-room__road">
            <span className="focused-room__road-label">큰길 (메인 흐름)</span>
            <div className="focused-room__road-slot">{bigRoadSlot ?? <span className="focused-room__road-empty">기록 모으는 중</span>}</div>
          </div>

          <div className="focused-room__bead">
            <span className="focused-room__road-label">비드플레이트</span>
            <div className="focused-room__bead-slot">{beadPlateSlot ?? <span className="focused-room__road-empty">기록 모으는 중</span>}</div>
          </div>
        </div>

        <div className="focused-room__stats">
          <span className="focused-room__count focused-room__count--banker">뱅커 {counts.banker}</span>
          <span className="focused-room__count focused-room__count--player">플레이어 {counts.player}</span>
          <span className="focused-room__count focused-room__count--tie">타이 {counts.tie}</span>
          {shoeProgress && (
            <span className="focused-room__shoe">· {shoeProgress.played}/{shoeProgress.total}패</span>
          )}
        </div>
        {patternLabel && <div className="focused-room__pattern">흐름: {patternLabel}</div>}

        <button
          type="button"
          className={`focused-room__primary ${primaryDanger ? 'is-danger' : ''}`}
          onClick={onPrimaryAction}
        >
          {primaryActionLabel}
        </button>

        {detail && (
          <div className="focused-room__detail">
            <button
              type="button"
              className="focused-room__detail-toggle"
              aria-expanded={detailOpen}
              onClick={() => setDetailOpen((v) => !v)}
            >
              {detailLabel} <span aria-hidden="true">{detailOpen ? '▾' : '▸'}</span>
            </button>
            {detailOpen && <div className="focused-room__detail-body">{detail}</div>}
          </div>
        )}
      </div>
    </AppShell>
  )
}

export default FocusedRoomView
