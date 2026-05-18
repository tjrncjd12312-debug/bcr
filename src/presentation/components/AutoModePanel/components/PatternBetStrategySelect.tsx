// PatternBetStrategySelect - Per-filter betting strategy override.
// Empty selection means "use the global strategy from settings.betStrategy".
// When a filter matches and triggers a bet, AutoModeService consults
// PatternBettingService.resolveBetStrategy(filterType, globalStrategy).

import { useEffect, useState } from 'react'
import type { RoomFilterType, BetStrategyType } from '../../../../domain/entities'
import PatternBettingService from '../../../../application/services/PatternBettingService'
import './PatternBetStrategySelect.css'

const AUTO_VALUE = '__auto__'

const OPTIONS: Array<{ value: BetStrategyType | typeof AUTO_VALUE; label: string; title: string }> = [
  { value: AUTO_VALUE,   label: '전역',   title: '전역 배팅 전략 사용 (오토 설정 다이얼로그에서 정한 값)' },
  { value: 'martingale', label: '마틴',   title: '마틴게일 — 패배 시 2배 증가' },
  { value: 'flat',       label: '플랫',   title: '플랫 — 고정 금액 유지' },
  { value: 'fibonacci',  label: '피보',   title: '피보나치 수열' },
  { value: 'paroli',     label: '파롤리', title: '파롤리 — 승리 시 2배 증가' },
  { value: 'custom',     label: '커스텀', title: '커스텀 — 단계별 직접 설정' },
]

interface PatternBetStrategySelectProps {
  patternType: RoomFilterType
  className?: string
}

export default function PatternBetStrategySelect({
  patternType,
  className,
}: PatternBetStrategySelectProps) {
  const [strategy, setStrategy] = useState<BetStrategyType | undefined>(() =>
    PatternBettingService.getBetStrategy(patternType)
  )

  useEffect(() => {
    setStrategy(PatternBettingService.getBetStrategy(patternType))
    return PatternBettingService.onChange(() => {
      setStrategy(PatternBettingService.getBetStrategy(patternType))
    })
  }, [patternType])

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation()
    const v = e.target.value
    PatternBettingService.setBetStrategy(
      patternType,
      v === AUTO_VALUE ? undefined : (v as BetStrategyType)
    )
  }

  const value = strategy ?? AUTO_VALUE
  const isOverride = strategy !== undefined

  return (
    <select
      className={`pbs-select${isOverride ? ' is-override' : ''}${className ? ` ${className}` : ''}`}
      value={value}
      onChange={handleChange}
      onClick={(e) => e.stopPropagation()}
      title={isOverride ? `이 필터 전용 전략: ${OPTIONS.find(o => o.value === strategy)?.label}` : '전역 배팅 전략을 따름'}
      aria-label="필터별 배팅 전략"
    >
      {OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value} title={opt.title}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
