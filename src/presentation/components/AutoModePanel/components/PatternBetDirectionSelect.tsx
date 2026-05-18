// PatternBetDirectionSelect - Color-coded segmented control for per-filter bet direction.
// Used inside AutoMode / PredictMode filter dropdowns so users can decide
// what to bet (B/P/T/skip/AI) when a built-in or custom filter matches.

import { useEffect, useState } from 'react'
import type { RoomFilterType, PatternBetDirection } from '../../../../domain/entities'
import PatternBettingService from '../../../../application/services/PatternBettingService'
import './PatternBetDirectionSelect.css'

interface DirOption {
  value: PatternBetDirection
  label: string
  title: string
  variant: 'ai' | 'banker' | 'player' | 'tie' | 'skip'
}

const OPTIONS: DirOption[] = [
  { value: 'ai',   label: 'AI', title: 'AI 예측 (서버 요청)',     variant: 'ai' },
  { value: 'B',    label: 'B',  title: '이 필터 적중 시 뱅커 배팅', variant: 'banker' },
  { value: 'P',    label: 'P',  title: '이 필터 적중 시 플레이어 배팅', variant: 'player' },
  { value: 'T',    label: 'T',  title: '이 필터 적중 시 타이 배팅', variant: 'tie' },
  { value: 'skip', label: '✕',  title: '이 필터는 배팅하지 않음(스킵)', variant: 'skip' },
]

interface PatternBetDirectionSelectProps {
  patternType: RoomFilterType
  className?: string
  size?: 'sm' | 'md'
}

export default function PatternBetDirectionSelect({
  patternType,
  className,
  size = 'sm',
}: PatternBetDirectionSelectProps) {
  const [dir, setDir] = useState<PatternBetDirection>(() =>
    PatternBettingService.getBetDirection(patternType)
  )

  useEffect(() => {
    setDir(PatternBettingService.getBetDirection(patternType))
    return PatternBettingService.onChange(() => {
      setDir(PatternBettingService.getBetDirection(patternType))
    })
  }, [patternType])

  const handleSelect = (e: React.MouseEvent<HTMLButtonElement>, value: PatternBetDirection) => {
    e.preventDefault()
    e.stopPropagation()
    if (value === dir) return
    PatternBettingService.setBetDirection(patternType, value)
  }

  return (
    <div
      className={`pbd-segment pbd-segment--${size}${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label="배팅 방향"
      onClick={(e) => e.stopPropagation()}
    >
      {OPTIONS.map(opt => {
        const active = dir === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            className={`pbd-segment__btn pbd-segment__btn--${opt.variant}${active ? ' is-active' : ''}`}
            onClick={(e) => handleSelect(e, opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
