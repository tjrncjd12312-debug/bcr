// SettingsDialogFrame — shared dialog chrome shared by AutoMode/SemiAuto settings.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsDialogFrame } from './SettingsDialogFrame'

describe('SettingsDialogFrame', () => {
  const tabs = [
    { value: 'general', label: '일반' },
    { value: 'strategy', label: '배팅 전략' },
  ]

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <SettingsDialogFrame
        isOpen={false}
        onClose={() => {}}
        title="오토 배팅 설정"
        tabs={tabs}
        activeTab="general"
        onTabChange={() => {}}
      >
        <div>body</div>
      </SettingsDialogFrame>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders title, tabs, body, and footer when open', () => {
    render(
      <SettingsDialogFrame
        isOpen
        onClose={() => {}}
        title="오토 배팅 설정"
        tabs={tabs}
        activeTab="general"
        onTabChange={() => {}}
        footer={<button>확인</button>}
      >
        <div>body-content</div>
      </SettingsDialogFrame>
    )
    expect(screen.getByText('오토 배팅 설정')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '일반' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '배팅 전략' })).toBeInTheDocument()
    expect(screen.getByText('body-content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '확인' })).toBeInTheDocument()
  })

  it('marks the active tab with the active class', () => {
    render(
      <SettingsDialogFrame
        isOpen
        onClose={() => {}}
        title="t"
        tabs={tabs}
        activeTab="strategy"
        onTabChange={() => {}}
      >
        <div />
      </SettingsDialogFrame>
    )
    expect(screen.getByRole('button', { name: '배팅 전략' })).toHaveClass('settings-tab', 'active')
    expect(screen.getByRole('button', { name: '일반' })).toHaveClass('settings-tab')
    expect(screen.getByRole('button', { name: '일반' })).not.toHaveClass('active')
  })

  it('calls onTabChange with the tab value when a tab is clicked', () => {
    const onTabChange = vi.fn()
    render(
      <SettingsDialogFrame
        isOpen
        onClose={() => {}}
        title="t"
        tabs={tabs}
        activeTab="general"
        onTabChange={onTabChange}
      >
        <div />
      </SettingsDialogFrame>
    )
    fireEvent.click(screen.getByRole('button', { name: '배팅 전략' }))
    expect(onTabChange).toHaveBeenCalledWith('strategy')
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <SettingsDialogFrame
        isOpen
        onClose={onClose}
        title="t"
        tabs={tabs}
        activeTab="general"
        onTabChange={() => {}}
      >
        <div />
      </SettingsDialogFrame>
    )
    fireEvent.click(screen.getByLabelText('닫기'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the overlay is clicked but not when the dialog is clicked', () => {
    const onClose = vi.fn()
    render(
      <SettingsDialogFrame
        isOpen
        onClose={onClose}
        title="t"
        tabs={tabs}
        activeTab="general"
        onTabChange={() => {}}
      >
        <div data-testid="body" />
      </SettingsDialogFrame>
    )
    fireEvent.click(screen.getByTestId('settings-dialog-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('body'))
    expect(onClose).toHaveBeenCalledTimes(1) // unchanged
  })

  it('omits the tab bar when tabs is empty or missing', () => {
    const { rerender } = render(
      <SettingsDialogFrame
        isOpen
        onClose={() => {}}
        title="t"
        activeTab=""
        onTabChange={() => {}}
      >
        <div />
      </SettingsDialogFrame>
    )
    expect(screen.queryByRole('button', { name: '일반' })).not.toBeInTheDocument()
    rerender(
      <SettingsDialogFrame
        isOpen
        onClose={() => {}}
        title="t"
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
      >
        <div />
      </SettingsDialogFrame>
    )
    expect(screen.queryByRole('button', { name: '일반' })).not.toBeInTheDocument()
  })
})
