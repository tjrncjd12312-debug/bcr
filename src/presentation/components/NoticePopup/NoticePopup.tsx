import { useState, useEffect, useCallback } from 'react'
import './NoticePopup.css'

export interface NoticeData {
  id: number
  title: string
  content: string
  regDate?: string
}

interface NoticePopupProps {
  notice: NoticeData
  onClose: () => void
}

const STORAGE_KEY = 'notice_hide_until'

/**
 * Check if notice should be hidden (24-hour hide active)
 */
export function shouldHideNotice(noticeId: number): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return false

    const data = JSON.parse(stored)
    if (data.noticeId !== noticeId) return false

    const hideUntil = new Date(data.hideUntil)
    return new Date() < hideUntil
  } catch {
    return false
  }
}

/**
 * Set 24-hour hide for notice
 */
function setHideNotice(noticeId: number): void {
  const hideUntil = new Date()
  hideUntil.setHours(hideUntil.getHours() + 24)

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      noticeId,
      hideUntil: hideUntil.toISOString(),
    })
  )
}

export default function NoticePopup({ notice, onClose }: NoticePopupProps) {
  const [isClosing, setIsClosing] = useState(false)
  const [hideFor24Hours, setHideFor24Hours] = useState(false)

  const handleClose = useCallback(() => {
    setIsClosing(true)

    if (hideFor24Hours) {
      setHideNotice(notice.id)
    }

    // Wait for animation to complete
    setTimeout(() => {
      onClose()
    }, 300)
  }, [hideFor24Hours, notice.id, onClose])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  // Format date
  const formattedDate = notice.regDate
    ? new Date(notice.regDate).toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  return (
    <div className={`notice-popup ${isClosing ? 'notice-popup--closing' : ''}`}>
      {/* Backdrop */}
      <div className="notice-popup__backdrop" onClick={handleClose} />

      {/* Modal */}
      <div className="notice-popup__modal">
        {/* Decorative glow */}
        <div className="notice-popup__glow notice-popup__glow--1" />
        <div className="notice-popup__glow notice-popup__glow--2" />

        {/* Header */}
        <div className="notice-popup__header">
          <div className="notice-popup__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <div className="notice-popup__header-text">
            <span className="notice-popup__label">NOTICE</span>
            <h2 className="notice-popup__title">{notice.title}</h2>
          </div>
          <button className="notice-popup__close" onClick={handleClose} aria-label="닫기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="notice-popup__content">
          <div
            className="notice-popup__text"
            dangerouslySetInnerHTML={{ __html: notice.content.replace(/\n/g, '<br/>') }}
          />
        </div>

        {/* Footer */}
        <div className="notice-popup__footer">
          <label className="notice-popup__checkbox">
            <input
              type="checkbox"
              checked={hideFor24Hours}
              onChange={(e) => setHideFor24Hours(e.target.checked)}
            />
            <span className="notice-popup__checkbox-box" />
            <span className="notice-popup__checkbox-text">24시간 동안 안보기</span>
          </label>

          <div className="notice-popup__actions">
            {formattedDate && (
              <span className="notice-popup__date">{formattedDate}</span>
            )}
            <button className="notice-popup__confirm" onClick={handleClose}>
              확인
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
