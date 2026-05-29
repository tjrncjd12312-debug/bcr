// AssistContainer — 도움받기(반자동) 라이브 배선
// 리디자인 3단계 배선. 검증된 SemiAutoPanel(예측·가상베팅·방이동 로직 그대로)을
// 공용 AppShell(홈 복귀·빵부스러기·연결 상태) 안에 감싸 작업 중심 IA에 편입한다.
//
// ⚠️ 베팅 로직 불변: 실제 베팅은 기존과 동일하게 SemiAutoSettings.autoBetting 플래그
//    뒤에서만 동작하며, 기본 흐름은 가상 베팅이다. 이 배선은 화면/내비게이션만 바꾼다.
import { useEffect } from 'react'
import { useGame } from '../../context/GameContext'
import SemiAutoPanel from '../SemiAutoPanel/SemiAutoPanel'
import { AppShell } from '../ds/AppShell'
import type { RoomFilterType } from '../../../domain/entities'

interface AssistContainerProps {
  onHome: () => void
}

export function AssistContainer({ onHome }: AssistContainerProps) {
  const {
    rooms,
    roomsReady,
    status,
    openCasino,
    user,
    availableFilters,
    activeFilters,
    toggleFilter,
    clearFilters,
  } = useGame()

  // 첫 진입(idle)이면 카지노 연결 → 방 목록·baseURL 확보 (WatchContainer와 동일 의도)
  useEffect(() => {
    if (status === 'idle' && user?.siteUrl) {
      openCasino(user.siteUrl).catch(() => { /* 연결 실패는 상태바에 반영 */ })
    }
    // 마운트 시 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connection = roomsReady ? 'online' : 'offline'

  return (
    <AppShell
      backLabel="홈"
      onBack={onHome}
      breadcrumb="도움받기"
      connection={connection}
    >
      <SemiAutoPanel
        rooms={rooms}
        fullScreen={false}
        onSwitchToPredict={onHome}
        availableFilters={availableFilters}
        selectedPattern={(activeFilters[0] as RoomFilterType) || 'all'}
        onPatternChange={(p) => (p === 'all' ? clearFilters() : toggleFilter(p))}
      />
    </AppShell>
  )
}

export default AssistContainer
