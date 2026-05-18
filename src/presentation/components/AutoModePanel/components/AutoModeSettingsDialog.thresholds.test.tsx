// AutoModeSettingsDialog — filter thresholds section tests.
//
// Verifies the new "필터 임계값" section in the 일반 tab writes through
// FilterThresholdsService so the same setting also reaches the inline
// editor in the filter dropdown and the RoomFilterService matchers.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AutoModeSettingsDialog } from './AutoModeSettingsDialog'
import FilterThresholdsService from '../../../../application/services/FilterThresholdsService'
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

describe('AutoModeSettingsDialog — 필터 임계값 section', () => {
  beforeEach(() => {
    localStorage.clear()
    FilterThresholdsService.set({
      tieDroughtThreshold: 20,
      freshRoomGames: 5,
      freshShoeMaxGameNumber: 5,
    })
    VirtualBettingService.dispose()
  })

  it('renders all three threshold inputs with current values', () => {
    openDialog()
    const labels = ['타이 미발생 (가뭄)', '신규 방 기준', '새 슈 기준']
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // tieDroughtThreshold default is 20
    expect(screen.getByLabelText('타이 미발생 (가뭄)')).toHaveValue(20)
  })

  it('writes tieDroughtThreshold through FilterThresholdsService when changed', () => {
    openDialog()
    const input = screen.getByLabelText('타이 미발생 (가뭄)') as HTMLInputElement
    fireEvent.change(input, { target: { value: '35' } })
    expect(FilterThresholdsService.get().tieDroughtThreshold).toBe(35)
  })

  it('writes freshRoomGames through FilterThresholdsService when changed', () => {
    openDialog()
    const input = screen.getByLabelText('신규 방 기준') as HTMLInputElement
    fireEvent.change(input, { target: { value: '12' } })
    expect(FilterThresholdsService.get().freshRoomGames).toBe(12)
    // Other thresholds should be unaffected
    expect(FilterThresholdsService.get().tieDroughtThreshold).toBe(20)
  })

  it('writes freshShoeMaxGameNumber through FilterThresholdsService when changed', () => {
    openDialog()
    const input = screen.getByLabelText('새 슈 기준') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(8)
  })

  it('reflects external service updates back into the inputs', () => {
    openDialog()
    act(() => {
      FilterThresholdsService.set({ tieDroughtThreshold: 99 })
    })
    expect(screen.getByLabelText('타이 미발생 (가뭄)')).toHaveValue(99)
  })
})

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
