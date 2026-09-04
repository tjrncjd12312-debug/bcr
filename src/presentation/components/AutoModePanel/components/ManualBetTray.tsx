// ManualBetTray — 수동 배팅 칩 트레이. Evolution 하단 칩 선택과 같은 조작: 칩 고르고 → 카드의 자리를 클릭.
import { useState } from 'react'
import { EvoChip } from './EvoChip'
import { MANUAL_CHIPS, type ManualStats } from '../../../../application/services/ManualBetService'
import './ManualBetTray.css'

interface ManualBetTrayProps {
  selectedChip: number
  onSelectChip: (amount: number) => void
  stats: ManualStats
  pendingAmount: number
  openBetCount: number
  isVirtual: boolean
  onResetStats: () => void
  /** 마지막으로 칩을 올린 방 이름(없으면 null) */
  lastRoomName: string | null
  onUndoLast: () => void
  onClearAll: () => void
  /** 마틴 따라가기: 방의 첫 칩을 그 방의 마틴 단계 금액으로 */
  followMartin: boolean
  onToggleFollowMartin: (on: boolean) => void
  strategyLabel: string
  /** 칩 액면(설정에서 편집) */
  presets?: readonly number[]
}

export function ManualBetTray({ selectedChip, onSelectChip, stats, pendingAmount, openBetCount, isVirtual, onResetStats, lastRoomName, onUndoLast, onClearAll, followMartin, onToggleFollowMartin, strategyLabel, presets = MANUAL_CHIPS }: ManualBetTrayProps) {
  const [custom, setCustom] = useState('')
  const isPreset = presets.includes(selectedChip)
  const applyCustom = () => {
    const n = Number(custom.replace(/[^0-9]/g, ''))
    if (Number.isFinite(n) && n >= 1000) onSelectChip(Math.round(n / 1000) * 1000)
  }
  return (
    <section className="manual-tray" aria-label="수동 배팅 칩 트레이">
      <div className="manual-tray__chips" role="radiogroup" aria-label="칩 선택">
        <span className="manual-tray__label">칩 선택</span>
        {presets.map((amount) => (
          <button
            key={amount}
            type="button"
            role="radio"
            aria-checked={selectedChip === amount}
            className={`manual-tray__chip ${selectedChip === amount ? 'is-selected' : ''}`}
            onClick={() => onSelectChip(amount)}
            title={`${amount.toLocaleString()}원 칩`}
          >
            <EvoChip amount={amount} size={38} />
          </button>
        ))}
        <span className={`manual-tray__custom ${!isPreset ? 'is-selected' : ''}`}>
          <input
            type="text"
            inputMode="numeric"
            placeholder="직접 입력"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyCustom() }}
            aria-label="칩 금액 직접 입력"
          />
          <button type="button" onClick={applyCustom}>적용</button>
        </span>
        <span className="manual-tray__selected">
          선택한 칩 <strong>{selectedChip.toLocaleString()}원</strong>
        </span>
        <label className={`manual-tray__follow ${followMartin ? 'is-on' : ''}`} title="켜면 방의 첫 칩이 그 방의 마틴 단계 금액으로 올라갑니다(설정의 기본 배팅 전략 기준). 지면 다음 단계, 이기면 1단계.">
          <input type="checkbox" checked={followMartin} onChange={(e) => onToggleFollowMartin(e.target.checked)} />
          <span>마틴 따라가기 <b>({strategyLabel})</b></span>
        </label>
        <span className="manual-tray__actions">
          <button type="button" className="manual-tray__action" disabled={openBetCount === 0} onClick={onUndoLast}
            title={lastRoomName ? `${lastRoomName}의 마지막 칩 빼기` : '올린 칩이 없어요'}>
            ↶ 빼기{lastRoomName ? ` (${lastRoomName})` : ''}
          </button>
          <button type="button" className="manual-tray__action is-danger" disabled={openBetCount === 0} onClick={onClearAll} title="열린 방의 칩을 전부 빼기">
            ✕ 전부 취소
          </button>
        </span>
      </div>
      <div className="manual-tray__status">
        <span className="manual-tray__hint">
          방 카드의 <b>플레이어·무·뱅커</b> 자리를 누르면 칩이 올라갑니다 · 같은 자리를 또 누르면 칩이 더 쌓입니다 · <b>빼기</b>는 마지막 칩, <b>취소</b>는 전부
        </span>
        <span className="manual-tray__stats">
          <span>걸린 방 <strong>{openBetCount}</strong></span>
          {isVirtual && <span>걸린 금액 <strong>{pendingAmount.toLocaleString()}</strong></span>}
          <span className="win">{stats.wins}승</span>
          <span className="loss">{stats.losses}패</span>
          {stats.ties > 0 && <span>{stats.ties}무</span>}
          <span className={stats.profit >= 0 ? 'win' : 'loss'}>손익 <strong>{stats.profit >= 0 ? '+' : ''}{stats.profit.toLocaleString()}</strong></span>
          <button type="button" className="manual-tray__reset" onClick={onResetStats} title="수동 배팅 통계 초기화">초기화</button>
        </span>
      </div>
    </section>
  )
}

export default ManualBetTray
