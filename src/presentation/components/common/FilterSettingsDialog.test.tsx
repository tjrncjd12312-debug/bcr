// FilterSettingsDialog smoke tests — verifies the dialog renders all sections
// and that toggle/clear actions delegate to the props (so backing services
// keep their current contract; per-control behavior is covered in their own
// tests like PatternBetDirectionSelect.test.tsx).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterSettingsDialog } from './FilterSettingsDialog'
import PatternBettingService from '../../../application/services/PatternBettingService'
import type { RoomFilter } from '../../../domain/entities'

const isEnabled = vi.fn(() => false)
const enable = vi.fn()
const disable = vi.fn()
const getDescription = vi.fn(() => '슈가 막 시작된 방에서만 타이 마틴 베팅.')

vi.mock('../../../application/di/setupContainer', () => ({
  getFreshShoePreset: () => ({ isEnabled, enable, disable, getDescription }),
}))

const availableFilters: RoomFilter[] = [
  { type: 'tie_drought', enabled: false, label: '타이 가뭄 (20)', description: '' },
  { type: 'fresh_room',  enabled: false, label: '신규 방 (≤30)', description: '' },
  { type: 'fresh_shoe',  enabled: false, label: '새 슈 (≤5)',    description: '' },
  { type: 'banker_dominant', enabled: false, label: '뱅커 우세', description: '' },
]

describe('FilterSettingsDialog', () => {
  beforeEach(() => {
    isEnabled.mockClear()
    enable.mockClear()
    disable.mockClear()
  })

  function renderDialog(overrides: Partial<Parameters<typeof FilterSettingsDialog>[0]> = {}) {
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      availableFilters,
      activeFilters: [],
      toggleFilter: vi.fn(),
      clearFilters: vi.fn(),
      filterCounts: { all: 10, tie_drought: 2, fresh_room: 5, fresh_shoe: 1, banker_dominant: 3 },
      onOpenPatternManager: vi.fn(),
      freshShoeScope: 'auto' as const,
      ...overrides,
    }
    return { ...render(<FilterSettingsDialog {...props} />), props }
  }

  it('renders nothing when closed', () => {
    const { container } = renderDialog({ isOpen: false })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders all five sections', () => {
    renderDialog()
    expect(screen.getByText('타이 자동 배팅')).toBeInTheDocument()
    expect(screen.getByText('활성 필터')).toBeInTheDocument()
    expect(screen.getByText('필터별 세부 설정')).toBeInTheDocument()
    expect(screen.getByText('고급 — 새 슈 전용 타이 자동 이동')).toBeInTheDocument()
    expect(screen.getByText('커스텀 패턴')).toBeInTheDocument()
  })

  it('checks "전체 (AI 자동)" when no filters are active', () => {
    renderDialog({ activeFilters: [] })
    const allRow = screen.getByText('전체 (AI 자동)').closest('label')!
    expect(allRow.querySelector('input[type="checkbox"]')).toBeChecked()
  })

  it('unchecks "전체 (AI 자동)" once any filter becomes active', () => {
    renderDialog({ activeFilters: ['tie_drought'] })
    const allRow = screen.getByText('전체 (AI 자동)').closest('label')!
    expect(allRow.querySelector('input[type="checkbox"]')).not.toBeChecked()
  })

  it('calls toggleFilter when a filter checkbox is clicked', () => {
    const { props } = renderDialog()
    // The label appears in both the toggle list and the detail list — the
    // first occurrence is the toggle row.
    const tieRow = screen.getAllByText('타이 가뭄 (20)')[0].closest('label')!
    fireEvent.click(tieRow.querySelector('input[type="checkbox"]')!)
    expect(props.toggleFilter).toHaveBeenCalledWith('tie_drought')
  })

  it('calls clearFilters when "전체" is clicked while a filter is active', () => {
    const { props } = renderDialog({ activeFilters: ['tie_drought'] })
    const allRow = screen.getByText('전체 (AI 자동)').closest('label')!
    fireEvent.click(allRow.querySelector('input[type="checkbox"]')!)
    expect(props.clearFilters).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-trigger clearFilters when "전체" is already on and clicked', () => {
    const { props } = renderDialog({ activeFilters: [] })
    const allRow = screen.getByText('전체 (AI 자동)').closest('label')!
    fireEvent.click(allRow.querySelector('input[type="checkbox"]')!)
    expect(props.clearFilters).not.toHaveBeenCalled()
  })

  it('renders the threshold input only for filters that have one', () => {
    renderDialog()
    // tie_drought / fresh_room / fresh_shoe → 3 threshold inputs
    expect(screen.getAllByLabelText('필터 임계값')).toHaveLength(3)
  })

  it('passes the freshShoeScope through to the preset toggle', () => {
    renderDialog({ freshShoeScope: 'semiauto' })
    expect(isEnabled).toHaveBeenCalledWith('semiauto')
  })

  it('opens the pattern manager via onOpenPatternManager', () => {
    const { props } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '커스텀 패턴 추가/관리' }))
    expect(props.onOpenPatternManager).toHaveBeenCalledTimes(1)
  })

  it('closes via the footer 확인 button', () => {
    const { props } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '확인' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  // "한 번 클릭" 카드 (어르신 사용자용 진입점) 테스트
  describe('타이 자동 배팅 quick toggle', () => {
    it('shows OFF status when tie_frequent is not active', () => {
      renderDialog({ activeFilters: [] })
      expect(screen.getByText(/꺼짐.*숫자를 정한 뒤 켜기/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '켜기', pressed: false })).toBeInTheDocument()
    })

    it('shows OFF when tie_frequent is active alongside another filter (no mixing)', () => {
      // 다른 필터와 섞이면 "타이 전용"이 아니므로 카드는 꺼짐 상태로 표시
      PatternBettingService.setBetDirection('tie_frequent', 'T')
      PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
      renderDialog({ activeFilters: ['tie_frequent', 'banker_dominant'] })
      expect(screen.getByRole('button', { name: '켜기', pressed: false })).toBeInTheDocument()
    })

    it('clearing other filters and adding tie_frequent on 켜기 (exclusive mode)', () => {
      const { props } = renderDialog({ activeFilters: ['banker_dominant'] })
      fireEvent.click(screen.getByRole('button', { name: '켜기' }))
      expect(props.clearFilters).toHaveBeenCalledTimes(1)
      expect(props.toggleFilter).toHaveBeenCalledWith('tie_frequent')
    })

    it('writes tieFrequentMinCount independently of tieFrequentMaxCount (range UI)', async () => {
      // Easy card now exposes min and max separately as a range "X ~ Y 번"
      PatternBettingService.setBetDirection('tie_frequent', 'T')
      PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
      const FilterThresholdsService = (await import('../../../application/services/FilterThresholdsService')).default
      FilterThresholdsService.set({ tieFrequentMinCount: 2, tieFrequentMaxCount: 99 })

      renderDialog({ activeFilters: ['tie_frequent'] })

      const minInput = screen.getByLabelText('타이 출현 최소 횟수') as HTMLInputElement
      const maxInput = screen.getByLabelText('타이 출현 최대 횟수') as HTMLInputElement
      fireEvent.change(minInput, { target: { value: '3' } })
      fireEvent.change(maxInput, { target: { value: '5' } })

      expect(FilterThresholdsService.get().tieFrequentMinCount).toBe(3)
      expect(FilterThresholdsService.get().tieFrequentMaxCount).toBe(5)
    })

    it('writes baseBetAmount + maxMartin through AutoModeService.updateSettings', async () => {
      const AutoModeService = (await import('../../../application/services/AutoModeService')).default
      renderDialog({ activeFilters: ['tie_frequent'] })

      const amount = screen.getByLabelText('기본 배팅 금액') as HTMLInputElement
      const martin = screen.getByLabelText('마틴 최대 단계') as HTMLInputElement
      fireEvent.change(amount, { target: { value: '20000' } })
      fireEvent.change(martin, { target: { value: '7' } })

      expect(AutoModeService.getState().settings.baseBetAmount).toBe(20000)
      expect(AutoModeService.getState().settings.maxMartin).toBe(7)
    })

    it('clicking 켜기 activates the tie_frequent filter via toggleFilter', () => {
      const { props } = renderDialog({ activeFilters: [] })
      fireEvent.click(screen.getByRole('button', { name: '켜기' }))
      expect(props.toggleFilter).toHaveBeenCalledWith('tie_frequent')
    })

    it('shows match count when 켜진 상태', () => {
      // The quick card considers the toggle "on" only when all three are set:
      //   tie_frequent filter active + direction=T + strategy=martingale.
      PatternBettingService.setBetDirection('tie_frequent', 'T')
      PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

      renderDialog({
        activeFilters: ['tie_frequent'],
        filterCounts: { all: 10, tie_frequent: 7 },
      })

      expect(screen.getByText(/작동 중.*7개/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '끄기', pressed: true })).toBeInTheDocument()
    })
  })
})
