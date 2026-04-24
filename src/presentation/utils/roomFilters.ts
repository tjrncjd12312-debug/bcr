// roomFilters.ts - 바카라 방 필터링 유틸리티
// Clean Architecture: Presentation Layer - UI 관련 필터링 로직
// 5개 파일에서 중복되던 로직을 통합

import type { Room } from '../../domain/entities'

/**
 * 바카라 방만 필터링 (살롱, 라이트닝 제외)
 * @param rooms Map 또는 배열 형태의 방 목록
 * @returns 필터링된 바카라 방 배열
 */
export function filterBaccaratRooms(rooms: Map<string, Room> | Room[]): Room[] {
  const roomArray = rooms instanceof Map ? Array.from(rooms.values()) : rooms
  return roomArray.filter(isBaccaratRoom)
}

/**
 * 단일 방이 바카라 방인지 확인
 * @param room 확인할 방
 * @returns 바카라 방 여부
 */
export function isBaccaratRoom(room: Room): boolean {
  const name = (room.koreanName || room.name || '').toLowerCase()

  // 제외 조건: 살롱, 라이트닝
  if (name.includes('salon') || name.includes('살롱')) return false
  if (name.includes('lightning') || name.includes('라이트닝')) return false

  // 포함 조건: 바카라
  return name.includes('baccarat') || name.includes('바카라')
}

/**
 * 검색어로 방 필터링
 * @param rooms 검색할 방 목록
 * @param searchTerm 검색어
 * @returns 검색어에 매칭되는 방 배열
 */
export function searchRooms(rooms: Room[], searchTerm: string): Room[] {
  if (!searchTerm) return rooms
  const term = searchTerm.toLowerCase()
  return rooms.filter(room => {
    const name = (room.koreanName || room.name || '').toLowerCase()
    return name.includes(term)
  })
}

