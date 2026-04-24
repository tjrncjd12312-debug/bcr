# PredictModePanel 구조 분리 + 성능 최적화 설계

**Date:** 2026-04-02
**Status:** Approved
**Scope:** `src/presentation/components/PredictModePanel/` + `src/application/services/MultiRoomPredictionService.ts`

---

## 1. 문제 요약

| 문제 | 영향 |
|------|------|
| PredictModePanel.tsx 2,578줄, 8개 컴포넌트 단일 파일 | 유지보수 어려움, 코드 탐색 비효율 |
| React.memo() 미적용 | RoomCard 50+개가 매 상태변경마다 전부 리렌더 |
| getState() 호출마다 전체 Map deep copy | 50+ 룸 x 3속성 = 150+ 객체 생성/emit |
| Hot Room 모니터링 roomStates 의존성 | 매 업데이트마다 20s interval 재생성 |
| SelectedRoomDetail / FocusedRoomView 중복 로직 | roadView, scroll, 통계 계산 등 7곳 복붙 |
| PredictModePanel.css 6,032줄 단일 파일 | 스타일 탐색/수정 비효율 |
| Chart.js 최상단 import | 초기 번들 크기 증가 |

---

## 2. 파일 분리 구조

### Before
```
PredictModePanel/
├── PredictModePanel.tsx     (2,578줄)
├── PredictModePanel.css     (6,032줄)
├── Top3Rankings.tsx
├── RankingView/
├── LobbyView/
├── StrategyAnalysisView.tsx
└── ThreeRowOXGrid.tsx
```

### After
```
PredictModePanel/
├── PredictModePanel.tsx          (~350줄) 메인 오케스트레이터
├── PredictModePanel.css          (~1,200줄) 변수 정의 + 메인 레이아웃 + 헤더
├── components/
│   ├── RoomCard.tsx              (~180줄) + RoomCard.css (~800줄)
│   ├── SelectedRoomDetail.tsx    (~250줄) + SelectedRoomDetail.css (~900줄)
│   ├── FocusedRoomView.tsx       (~400줄) + FocusedRoomView.css (~1,800줄)
│   ├── CompactRoomRow.tsx        (~100줄) + CompactRoomRow.css (~400줄)
│   ├── SparklineGraph.tsx        (~60줄)
│   ├── MiniRoadmap.tsx           (~30줄)
│   ├── WinRateTrendChart.tsx     (~90줄) + WinRateTrendChart.css (~100줄)
│   └── ShoeResetOverlay.tsx      (~30줄)
├── hooks/
│   └── useRoadView.ts            (~80줄) 공통 roadView/scroll 로직
├── Top3Rankings.tsx              (기존 유지)
├── RankingView/                  (기존 유지)
├── LobbyView/                   (기존 유지)
├── StrategyAnalysisView.tsx      (기존 유지)
└── ThreeRowOXGrid.tsx            (기존 유지)
```

### 분리 원칙
- 모든 분리된 컴포넌트에 `React.memo()` 적용
- 기존 props 인터페이스 유지 (외부 API 변경 없음)
- 각 컴포넌트 파일은 자체 CSS를 import

---

## 3. 성능 최적화

### 3-1. React.memo() 적용

대상 컴포넌트:
- `RoomCard` — 50+ 인스턴스, 가장 큰 리렌더 영향
- `SelectedRoomDetail` — 복잡한 차트/로드맵 포함
- `FocusedRoomView` — 가장 큰 서브컴포넌트
- `CompactRoomRow` — 리스트 뷰에서 다수 렌더
- `SparklineGraph` — SVG 연산
- `MiniRoadmap` — SVG 연산
- `WinRateTrendChart` — Chart.js 렌더링 비용 높음
- `ShoeResetOverlay` — 단순하지만 일관성 위해 포함

부모 콜백 안정화:
- `filteredRooms.map()` 내 인라인 화살표 함수를 roomId 기반 안정 콜백으로 변경
- `handleRoomSelect`, `handleEnterAndFocus` 등 기존 useCallback은 유지

### 3-2. MultiRoomPredictionService 선택적 상태 업데이트

```typescript
// dirtyRooms 추적
private dirtyRooms = new Set<string>()

// 룸 상태 변경 시 dirty 마킹
private updateRoomState(roomId: string, updater: (s: RoomPredictionState) => void) {
  const state = this.state.roomStates.get(roomId)
  if (state) {
    updater(state)
    this.dirtyRooms.add(roomId)
  }
}

// getState()에서 dirty 룸만 새 객체 생성
getState(): MultiRoomPredictionState {
  if (this.dirtyRooms.size === 0) {
    return { ...this.state, roomStates: this.state.roomStates }
  }
  const newRoomStates = new Map(this.state.roomStates)
  this.dirtyRooms.forEach(roomId => {
    const s = this.state.roomStates.get(roomId)
    if (s) {
      newRoomStates.set(roomId, {
        ...s,
        stats: { ...s.stats },
        history: [...s.history],
        lastPrediction: s.lastPrediction ? { ...s.lastPrediction } : null,
      })
    }
  })
  this.dirtyRooms.clear()
  return { ...this.state, roomStates: newRoomStates, globalStats: { ...this.state.globalStats } }
}
```

### 3-3. Hot Room 모니터링 의존성 분리

```typescript
// useRef로 최신값 참조, useEffect 의존성에서 제거
const roomStatesRef = useRef(roomStates)
roomStatesRef.current = roomStates
const roomsRef = useRef(rooms)
roomsRef.current = rooms
const getMartinLevelRef = useRef(getMartinLevel)
getMartinLevelRef.current = getMartinLevel

useEffect(() => {
  if (status !== 'connected') return
  const interval = setInterval(() => {
    roomStatesRef.current.forEach((state, roomId) => {
      const room = roomsRef.current.get(roomId)
      if (!room) return
      // ... alert 로직 (addAlert은 useCallback이므로 안정적)
    })
  }, 20000)
  return () => clearInterval(interval)
}, [status, addAlert])
```

### 3-4. Chart.js Lazy Loading

```typescript
// WinRateTrendChart.tsx
import { lazy, Suspense } from 'react'

// Chart.js register는 컴포넌트 내부에서 수행
const LazyLine = lazy(() =>
  import('react-chartjs-2').then(m => ({ default: m.Line }))
)

// 최초 렌더 시 Chart.js 번들 로드
export const WinRateTrendChart = memo(function WinRateTrendChart({ history }) {
  // Chart.js register는 첫 렌더 시 한 번만
  useEffect(() => {
    import('chart.js').then(({ Chart, ...scales }) => {
      Chart.register(scales.CategoryScale, scales.LinearScale, ...)
    })
  }, [])

  return (
    <Suspense fallback={<div className="chart-loading" />}>
      <LazyLine data={chartData} options={options} />
    </Suspense>
  )
})
```

---

## 4. 공통 훅: useRoadView

SelectedRoomDetail과 FocusedRoomView에서 중복되는 7개 로직을 통합합니다.

### 인터페이스

```typescript
interface UseRoadViewOptions {
  room: Room
  state: RoomPredictionState | null
  lastResult?: boolean
  beadCols?: number  // SelectedRoomDetail: 12, FocusedRoomView: 16
}

interface UseRoadViewResult {
  // roadView 상태
  roadView: 'six' | 'three' | 'one'
  toggleRoadView: (view: 'six' | 'three' | 'one') => void
  isOneRow: boolean
  isThreeRow: boolean
  beadRows: number

  // DOM refs
  historyPlateRef: RefObject<HTMLDivElement>
  bigRoadCols: number

  // 메모이즈된 데이터
  beadHistory: RoadResult[]
  bigRoadHistory: RoadResult[]
  predictionMap: Map<number, PredictionInfo>

  // 통계
  stats: { bankerCount: number; playerCount: number; tieCount: number; bPercent: number; pPercent: number; tPercent: number }
  currentStreak: { winner: 'B' | 'P' | null; count: number }
  patternLabel: string | null
}
```

### 통합되는 중복 로직

| 로직 | SelectedRoomDetail 줄 | FocusedRoomView 줄 |
|------|----------------------|-------------------|
| roadView 상태 + localStorage | 1529-1537 | 1923-1931 |
| ResizeObserver 컬럼 계산 | 1544-1564 | 2031-2051 |
| 새 결과 시 자동 스크롤 | 1567-1595 | 2053-2082 |
| beadHistory 메모이제이션 | 1597-1599 | 2084-2086 |
| bigRoadHistory 메모이제이션 | 1601-1603 | 2088-2090 |
| predictionMap 생성 | 1606-1615 | 2094-2104 |
| B/P/T 통계 + streak + pattern | 1517-1527, 1617-1627 | 2107-2144 |

`predictionMap` 생성 시 FocusedRoomView의 previewRoomId 분기 처리:
- `useRoadView`는 전달받은 `lastResult`가 `undefined`면 predictionMap을 빈 Map으로 반환
- FocusedRoomView에서 previewRoomId가 있을 때 `lastResult`를 `undefined`로 전달하면 자연스럽게 처리됨

---

## 5. CSS 분할

### 분할 매핑

| 파일 | 포함 셀렉터 범위 |
|------|----------------|
| `PredictModePanel.css` | `.predict-panel` 변수, `.predict-header`, `.predict-content`, `.predict-rooms`, `.predict-empty`, `.predict-loading`, `.predict-alerts`, `.alert-toast`, `.win-celebration`, `.predict-detail__empty`, `.room-grid`, `.predict-compact` (레이아웃만), `.predict-lobby-wrapper` |
| `RoomCard.css` | `.room-card`, `.room-card__*`, `.room-stat-item`, `.sparkline-*`, `.mini-roadmap`, `.shoe-reset-overlay` |
| `SelectedRoomDetail.css` | `.detail-hero`, `.detail-header`, `.detail-prediction`, `.confidence-gauge`, `.detail-distribution`, `.detail-history`, `.detail-pred-stats`, `.detail-scrollable-content`, `.xai-chip`, `.detail-enter-btn` |
| `FocusedRoomView.css` | `.focused-room-v2`, `.focused-room-v2__*`, `.prediction-bar`, `.prediction-bar__*`, `.bead-area`, `.quick-pill` |
| `CompactRoomRow.css` | `.compact-header-row`, `.compact-list`, `.compact-row`, `.compact-row__*` |
| `WinRateTrendChart.css` | `.room-detail__winrate-chart`, `.chart-label`, `.chart-wrapper` |

### 원칙
- CSS custom properties는 `.predict-panel` 블록(메인 CSS)에 유지
- 기존 클래스명 변경 없음
- 애니메이션 `@keyframes`는 사용하는 CSS 파일에 포함
- 공유 애니메이션(`anim-fade-in`, `anim-pulse`, `anim-slide-in`)은 메인 CSS에 유지

---

## 6. 변경하지 않는 것

- 기존 컴포넌트 외부 API (props 인터페이스)
- CSS 클래스명 / 셀렉터
- 상태 흐름 (GameContext → PredictModePanel → 자식)
- Top3Rankings, RankingView, LobbyView, StrategyAnalysisView, ThreeRowOXGrid 등 기존 분리된 컴포넌트
- MultiRoomPredictionService의 공개 메서드 시그니처
- CSS Modules 전환 (이번 범위 아님)
- 가상 스크롤링 (이번 범위 아님)

---

## 7. 리스크 및 완화

| 리스크 | 완화 |
|--------|------|
| 파일 분리 시 import 경로 오류 | 빌드 확인 (`npm run build`) |
| memo()로 인한 stale props | 콜백을 useCallback으로 안정화, 원시값 props 우선 |
| dirtyRooms 누락으로 UI 미갱신 | 기존 테스트 + 수동 QA |
| CSS 분할 시 셀렉터 누락 | 분할 전후 CSS 줄 수 합산 비교 |

---

## 8. 검증 계획

1. `npm run build` — TypeScript 컴파일 + 번들 성공
2. `npm run test:run` — 기존 테스트 통과
3. 수동 QA: Grid/Lobby/Ranking/Compact 4개 뷰 모드 전환
4. 수동 QA: FocusedRoomView 진입 → 예측 표시 → 결과 표시 → 사운드
5. CSS 줄 수 합산이 원본과 일치하는지 확인
