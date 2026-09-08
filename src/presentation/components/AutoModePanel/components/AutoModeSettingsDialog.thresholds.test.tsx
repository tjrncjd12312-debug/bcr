// AutoModeSettingsDialog — virtual balance persistence test.
//
// The filter-thresholds section that used to live here has moved to
// FilterSettingsDialog. Threshold behavior is now covered by
// FilterThresholdsService.test.ts, FilterThresholdInline.test.tsx, and
// FilterSettingsDialog.test.tsx.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AutoModeSettingsDialog } from './AutoModeSettingsDialog'
import { VirtualBettingService } from '../../../../application/services/VirtualBettingService'
import AccountLimitsService from '../../../../application/services/AccountLimitsService'
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

type DialogProps = React.ComponentProps<typeof AutoModeSettingsDialog>

function openDialog(
  settingsOverride: Partial<AutoModeSettings> = {},
  strategyProps: Partial<Pick<DialogProps, 'activeStructuredStrategy' | 'onOpenStrategyBuilder' | 'onUpdateSettings'>> = {},
) {
  const settings = { ...baseSettings(), ...settingsOverride }
  const { onUpdateSettings = noop, ...rest } = strategyProps
  return render(
    <AutoModeSettingsDialog
      isOpen
      onClose={noop}
      settings={settings}
      onUpdateSettings={onUpdateSettings}
      onResetStats={noop}
      totalWins={0}
      totalLosses={0}
      cumulativeProfit={0}
      realBalance={null}
      {...rest}
    />
  )
}

describe('AutoModeSettingsDialog — virtual balance persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    VirtualBettingService.dispose()
    // 계정 동시배팅 상한은 싱글턴이라 케이스 사이에 남으면 안 된다(null=미주입 → clamp는 no-op).
    AccountLimitsService.reset()
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

    fireEvent.click(screen.getByRole('button', { name: '배팅 전략' })) // 탭 라벨은 도메인 이름으로(2026-09-05)

    expect(screen.getByText('15회 무3연속 · 2연승')).toBeInTheDocument()
    expect(screen.getByText(/기본 배팅 전략은 중복 적용되지 않고 저장 상태로만 유지됩니다/)).toBeInTheDocument()
    expect(screen.getByText('단계별 금액')).toBeInTheDocument()
    expect(container.querySelector('.ams-strategy-fieldset')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '조건 전략 편집' }))
    expect(onOpenStrategyBuilder).toHaveBeenCalledTimes(1)
  })
})

// 관리자가 어드민 페이지에서 계정마다 건 "동시배팅 최대 개수"가 이 설정창에 어떻게 비치는지.
// ⚠️ 이 상한은 클라이언트 UX 가드이며 보안 경계가 아니다(서버가 배팅을 중계하지 않는다).
describe('AutoModeSettingsDialog — 계정 동시배팅 상한', () => {
  beforeEach(() => {
    localStorage.clear()
    AccountLimitsService.reset()
  })

  afterEach(() => {
    // reset()이 마운트된 다이얼로그의 onChange 구독을 깨우면 act() 경고가 뜬다 — 먼저 언마운트.
    cleanup()
    AccountLimitsService.reset()
  })

  /** '동시 배팅 제한'은 배팅 전략 탭에 있다 */
  function openStrategyTab(settingsOverride: Partial<AutoModeSettings> = {}, onUpdateSettings?: DialogProps['onUpdateSettings']) {
    const view = openDialog(settingsOverride, onUpdateSettings ? { onUpdateSettings } : {})
    fireEvent.click(screen.getByRole('button', { name: '배팅 전략' }))
    return view
  }

  const concurrentInput = () => screen.getByLabelText('최대 동시 배팅 수') as HTMLInputElement
  const concurrentPresets = () =>
    within(screen.getByRole('group', { name: '최대 동시 배팅 수 빠른 선택' }))

  it('상한이 없으면(미주입) 기존 칩 그대로 — 제한 없음 + 1/3/6/10, max 없음', () => {
    openStrategyTab()

    expect(concurrentPresets().getByRole('button', { name: '제한 없음' })).toBeInTheDocument()
    for (const label of ['1개', '3개', '6개', '10개']) {
      expect(concurrentPresets().getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(concurrentInput().min).toBe('0')
    expect(concurrentInput().max).toBe('')
    expect(screen.getByText('0 = 전체 방 배팅 (동시배팅 제한없음)')).toBeInTheDocument()
  })

  it('상한 10이면 프리셋에서 "제한 없음"이 사라지고 10이 남는다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 10 })

    openStrategyTab()

    expect(concurrentPresets().queryByRole('button', { name: '제한 없음' })).toBeNull()
    expect(concurrentPresets().getByRole('button', { name: '10개' })).toBeInTheDocument()
    expect(
      concurrentPresets().getAllByRole('button').map(b => b.textContent)
    ).toEqual(['1개', '3개', '6개', '10개'])
  })

  it('상한 10이면 입력칸이 1~10으로 좁혀지고 안내 문구가 관리자 설정을 말한다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 10 })

    openStrategyTab()

    expect(concurrentInput().min).toBe('1')
    expect(concurrentInput().max).toBe('10')
    expect(screen.getByText('관리자 설정: 최대 10개까지 선택할 수 있어요')).toBeInTheDocument()
  })

  it('상한 10인데 저장값이 0(무제한)이면 화면엔 10으로 보인다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 10 })

    openStrategyTab({ maxConcurrentBets: 0 })

    expect(concurrentInput()).toHaveValue(10)
  })

  it('프리셋에 없는 상한(7)도 칩으로 한 번에 고를 수 있다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 7 })

    openStrategyTab()

    expect(
      concurrentPresets().getAllByRole('button').map(b => b.textContent)
    ).toEqual(['1개', '3개', '6개', '7개'])
    expect(concurrentInput().max).toBe('7')
  })

  it('상한 0(관리자가 제한 풀기)은 상한 미주입과 화면이 같다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 0 })

    openStrategyTab()

    expect(concurrentPresets().getByRole('button', { name: '제한 없음' })).toBeInTheDocument()
    expect(concurrentInput().min).toBe('0')
    expect(concurrentInput().max).toBe('')
  })

  it('상한을 넘겨 타이핑해도 onUpdateSettings에는 상한으로 조여져 나간다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 10 })
    const onUpdateSettings = vi.fn()

    openStrategyTab({ maxConcurrentBets: 5 }, onUpdateSettings)
    fireEvent.change(concurrentInput(), { target: { value: '20' } })

    expect(onUpdateSettings).toHaveBeenCalledWith({ maxConcurrentBets: 10 })
  })
})
