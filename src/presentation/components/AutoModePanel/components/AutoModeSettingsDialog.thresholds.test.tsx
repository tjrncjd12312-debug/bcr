// AutoModeSettingsDialog — virtual balance persistence test.
//
// The filter-thresholds section that used to live here has moved to
// FilterSettingsDialog. Threshold behavior is now covered by
// FilterThresholdsService.test.ts, FilterThresholdInline.test.tsx, and
// FilterSettingsDialog.test.tsx.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AutoModeSettingsDialog } from './AutoModeSettingsDialog'
import { VirtualBettingService } from '../../../../application/services/VirtualBettingService'
import type { AutoModeSettings } from '../../../../application/services/AutoModeService'
import { createDefaultCustomStrategy } from '../../../../domain/strategies/customStrategy'

function baseSettings(): AutoModeSettings {
  return {
    enabled: false,
    isVirtualMode: true,
    autoBetting: false,
    baseBetAmount: 10_000,
    maxMartin: 5,
    betStrategy: 'martingale',
    customBetAmounts: [],
    winCutAmount: 0,
    lossCutAmount: 0,
    globalMaxConsecutiveLosses: 5,
    resetMartinOnStop: true,
    maxConcurrentBets: 0,
    onlySelectedRooms: false,
    roomConfigs: [],
    patternConfigs: [],
  } as unknown as AutoModeSettings
}

function noop() { /* */ }

function openDialog(
  settingsOverride: Partial<AutoModeSettings> = {},
  strategyProps: Pick<React.ComponentProps<typeof AutoModeSettingsDialog>, 'activeStructuredStrategy' | 'onOpenStrategyBuilder'> = {},
) {
  const settings = { ...baseSettings(), ...settingsOverride }
  return render(
    <AutoModeSettingsDialog
      isOpen
      onClose={noop}
      settings={settings}
      onUpdateSettings={noop}
      onResetStats={noop}
      totalWins={0}
      totalLosses={0}
      cumulativeProfit={0}
      realBalance={null}
      {...strategyProps}
    />
  )
}

describe('AutoModeSettingsDialog — virtual balance persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    VirtualBettingService.dispose()
  })

  it('shows the persisted virtual balance after a value was previously set', () => {
    VirtualBettingService.updateSettings({ initialBalance: 5_000_000 })
    VirtualBettingService.dispose() // simulates app restart
    openDialog()
    expect(screen.getByLabelText('초기 잔액')).toHaveValue(5_000_000)
  })
})

describe('AutoModeSettingsDialog — strategy ownership', () => {
  it('makes it explicit that a structured strategy owns direction, stages and amounts', () => {
    const onOpenStrategyBuilder = vi.fn()
    const { container } = openDialog({}, {
      activeStructuredStrategy: createDefaultCustomStrategy(),
      onOpenStrategyBuilder,
    })

    fireEvent.click(screen.getByRole('button', { name: '기본 배팅 전략' }))

    expect(screen.getByText('15회 무3연속 · 2연승')).toBeInTheDocument()
    expect(screen.getByText(/기본 배팅 전략은 중복 적용되지 않고 저장 상태로만 유지됩니다/)).toBeInTheDocument()
    expect(screen.getByText('단계별 금액')).toBeInTheDocument()
    expect(container.querySelector('.ams-strategy-fieldset')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '조건 전략 편집' }))
    expect(onOpenStrategyBuilder).toHaveBeenCalledTimes(1)
  })
})
