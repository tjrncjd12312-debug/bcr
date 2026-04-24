// RoomSelectorModal - 범용 방 선택 모달
// PredictMode와 AutoMode 모두에서 사용 가능

import React, { useState, useMemo } from 'react'
import type { Room } from '../../../domain/entities'
import { filterBaccaratRooms, searchRooms } from '../../utils'
import './RoomSelectorModal.css'

interface RoomSelectorModalProps {
  isOpen: boolean
  onClose: () => void
  rooms: Map<string, Room>
  selectedRoomIds: Set<string>
  onSelectionChange: (selectedIds: Set<string>) => void
  title?: string
  // 추가 옵션 (AutoMode 호환)
  showOnlySelectedOption?: boolean
  onlySelectedValue?: boolean
  onOnlySelectedChange?: (value: boolean) => void
  emptyHint?: string
}

export function RoomSelectorModal({
  isOpen,
  onClose,
  rooms,
  selectedRoomIds,
  onSelectionChange,
  title = '방 선택',
  showOnlySelectedOption = false,
  onlySelectedValue = false,
  onOnlySelectedChange,
  emptyHint = '선택하지 않으면 전체 방이 대상입니다',
}: RoomSelectorModalProps) {
  const [searchTerm, setSearchTerm] = useState('')

  // 바카라 방만 필터링 (유틸리티 사용)
  const roomList = useMemo(() => filterBaccaratRooms(rooms), [rooms])

  // 검색 필터링 (유틸리티 사용)
  const filteredRooms = useMemo(() => searchRooms(roomList, searchTerm), [roomList, searchTerm])

  const handleRoomToggle = (roomId: string, enabled: boolean) => {
    const newSet = new Set(selectedRoomIds)
    if (enabled) {
      newSet.add(roomId)
    } else {
      newSet.delete(roomId)
    }
    onSelectionChange(newSet)
  }

  const handleSelectAll = () => {
    const newSet = new Set(roomList.map(r => r.id))
    onSelectionChange(newSet)
  }

  const handleDeselectAll = () => {
    onSelectionChange(new Set())
  }

  if (!isOpen) return null

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="rsm-overlay" onClick={handleOverlayClick}>
      <div className="rsm-modal">
        {/* Header */}
        <div className="rsm-header">
          <h3>{title}</h3>
          <button className="rsm-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="rsm-toolbar">
          <div className="rsm-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="방 검색..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="rsm-actions">
            <button className="rsm-btn" onClick={handleSelectAll}>전체선택</button>
            <button className="rsm-btn" onClick={handleDeselectAll}>전체해제</button>
          </div>
        </div>

        {/* Status */}
        <div className="rsm-status">
          <span className="rsm-count">
            <strong>{selectedRoomIds.size}</strong> / {roomList.length} 방 선택됨
          </span>
          {selectedRoomIds.size === 0 && (
            <span className="rsm-hint">{emptyHint}</span>
          )}
        </div>

        {/* Room List */}
        <div className="rsm-list">
          {filteredRooms.length === 0 ? (
            <div className="rsm-empty">
              {searchTerm ? '검색 결과가 없습니다' : '연결된 방이 없습니다'}
            </div>
          ) : (
            filteredRooms.map(room => (
              <label
                key={room.id}
                className={`rsm-item ${selectedRoomIds.has(room.id) ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selectedRoomIds.has(room.id)}
                  onChange={(e) => handleRoomToggle(room.id, e.target.checked)}
                />
                <span className="rsm-item-name">{room.koreanName || room.name}</span>
                <span className="rsm-item-games">{room.history.length}게임</span>
              </label>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="rsm-footer">
          {showOnlySelectedOption && onOnlySelectedChange && (
            <label className="rsm-checkbox">
              <input
                type="checkbox"
                checked={onlySelectedValue}
                onChange={(e) => onOnlySelectedChange(e.target.checked)}
              />
              <span>선택된 방만 화면에 표시</span>
            </label>
          )}
          <button className="rsm-btn-primary" onClick={onClose}>
            확인
          </button>
        </div>
      </div>
    </div>
  )
}
