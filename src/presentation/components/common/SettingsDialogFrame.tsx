// SettingsDialogFrame — shared chrome for settings dialogs.
// Owns the overlay, dialog box, header (title + close), optional tab bar,
// scrollable content area, and optional footer. No business logic — pure layout.

import { useEffect, useState, type ReactNode } from 'react'
import './SettingsDialogFrame.css'

export interface SettingsTabDef<T extends string> {
  value: T
  label: string
}

export interface SettingsDialogFrameProps<T extends string> {
  isOpen: boolean
  onClose: () => void
  title: string
  tabs?: SettingsTabDef<T>[]
  activeTab?: T
  onTabChange: (next: T) => void
  footer?: ReactNode
  children: ReactNode
}

export function SettingsDialogFrame<T extends string>({
  isOpen,
  onClose,
  title,
  tabs,
  activeTab,
  onTabChange,
  footer,
  children,
}: SettingsDialogFrameProps<T>) {
  const [animateIn, setAnimateIn] = useState(false)

  useEffect(() => {
    setAnimateIn(isOpen)
  }, [isOpen])

  if (!isOpen) return null

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      data-testid="settings-dialog-overlay"
      className={`settings-dialog-overlay ${animateIn ? 'visible' : ''}`}
      onClick={handleOverlayClick}
    >
      <div
        className={`settings-dialog ${animateIn ? 'visible' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <div className="settings-dialog-header">
          <h2 id="settings-dialog-title">{title}</h2>
          <button className="settings-dialog-close" onClick={onClose} aria-label="닫기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {tabs && tabs.length > 0 && (
          <div className="settings-dialog-tabs">
            {tabs.map(tab => (
              <button
                key={tab.value}
                className={`settings-tab ${activeTab === tab.value ? 'active' : ''}`}
                onClick={() => onTabChange(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className="settings-dialog-content">
          {children}
        </div>

        {footer && (
          <div className="settings-dialog-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
