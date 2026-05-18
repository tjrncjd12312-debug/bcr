import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FreshShoeToggle } from './FreshShoeToggle'

// Mock the DI container to provide a controllable preset
const isEnabled = vi.fn()
const enable = vi.fn()
const disable = vi.fn()
const getDescription = vi.fn(() => '슈가 막 시작된 방에서만 타이 마틴 베팅.')

vi.mock('../../../application/di/setupContainer', () => ({
  getFreshShoePreset: () => ({ isEnabled, enable, disable, getDescription }),
}))

describe('FreshShoeToggle', () => {
  beforeEach(() => {
    isEnabled.mockReset()
    enable.mockReset()
    disable.mockReset()
    getDescription.mockClear()
    getDescription.mockReturnValue('슈가 막 시작된 방에서만 타이 마틴 베팅.')
  })

  it('renders the label and description from the preset', () => {
    isEnabled.mockReturnValue(false)
    render(<FreshShoeToggle scope="auto" />)
    expect(screen.getByText('새 슈 타이 마틴')).toBeInTheDocument()
    expect(screen.getByText(/슈가 막 시작된 방에서만/)).toBeInTheDocument()
  })

  it('reflects the initial enabled state for the given scope', () => {
    isEnabled.mockImplementation((scope: string) => scope === 'auto')
    render(<FreshShoeToggle scope="auto" />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(isEnabled).toHaveBeenCalledWith('auto')
  })

  it('calls preset.enable(scope) when toggled on', () => {
    isEnabled.mockReturnValue(false)
    render(<FreshShoeToggle scope="semiauto" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(enable).toHaveBeenCalledWith('semiauto')
  })

  it('calls preset.disable(scope) when toggled off', () => {
    isEnabled.mockImplementation((scope: string) => scope === 'auto')
    render(<FreshShoeToggle scope="auto" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(disable).toHaveBeenCalledWith('auto')
  })

  it('renders the warning slot when provided', () => {
    isEnabled.mockReturnValue(false)
    render(
      <FreshShoeToggle scope="semiauto" warning="⚠ 후속 패치에서 지원" />
    )
    expect(screen.getByText(/후속 패치에서 지원/)).toBeInTheDocument()
  })
})
