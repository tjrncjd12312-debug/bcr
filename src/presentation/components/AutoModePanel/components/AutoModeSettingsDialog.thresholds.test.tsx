// AutoModeSettingsDialog — virtual balance persistence test.
//
// The filter-thresholds section that used to live here has moved to
// FilterSettingsDialog. Threshold behavior is now covered by
// FilterThresholdsService.test.ts, FilterThresholdInline.test.tsx, and
// FilterSettingsDialog.test.tsx.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AutoModeSettingsDialog } from './AutoModeSettingsDialog'
import { VirtualBettingService } from '../../../../application/services/VirtualBettingService'
import type { AutoModeSettings } from '../../../../application/services/AutoModeService'

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
    restDurationMinutes: 0,
    resetMartinOnStop: true,
    maxConcurrentBets: 0,
    onlySelectedRooms: false,
    roomConfigs: [],
    patternConfigs: [],
  } as unknown as AutoModeSettings
}

function noop() { /* */ }

function openDialog(settingsOverride: Partial<AutoModeSettings> = {}) {
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
