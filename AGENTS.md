# AGENTS.md - Complete Reference for AI Agents

**Project**: BCR Predictor v1.3.4
**Last Updated**: 2026-02-16
**Type**: Tauri 2.0 Desktop Application (React 18/TypeScript frontend + Rust backend)
**Purpose**: Baccarat game prediction with multi-room monitoring, semi-auto/auto-betting, virtual betting, Chrome CDP integration

---

## TABLE OF CONTENTS

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Frontend Architecture](#frontend-architecture)
4. [Backend Architecture](#backend-architecture)
5. [Data Flow & State Management](#data-flow--state-management)
6. [Tauri Commands Reference](#tauri-commands-reference)
7. [Domain Types & Enums](#domain-types--enums)
8. [Key Services & Use Cases](#key-services--use-cases)
9. [Testing Guide](#testing-guide)
10. [Common Tasks & Recipes](#common-tasks--recipes)
11. [Build & Deployment](#build--deployment)
12. [Debugging & Troubleshooting](#debugging--troubleshooting)
13. [Performance & Optimization](#performance--optimization)
14. [Security Considerations](#security-considerations)

---

## QUICK START

### What is BCR Predictor?

BCR Predictor is a desktop application that:
- **Connects to Evolution Gaming & Pragmatic Play** baccarat tables via WebSocket
- **Predicts game outcomes** using a backend ML model (BCR Prediction API)
- **Supports 3 modes**:
  1. **Login Screen**: User authentication
  2. **Auto Mode**: Multi-room monitoring + auto-betting across 33+ tables
  3. **Predict Mode**: Single-room focus with virtual betting simulation
- **Key features**: Semi-auto betting, pattern-based filtering, virtual balance tracking, Martingale/Fibonacci strategies, Chrome CDP integration for automated lobby navigation

### Project Structure at a Glance

```
newbcr/
├── src/                          # Frontend (TypeScript/React)
│   ├── domain/                   # Core business types & interfaces
│   ├── application/              # Services, DI container, use cases
│   ├── presentation/             # React components & hooks
│   ├── infrastructure/           # External adapters (Tauri, WebSocket)
│   ├── test/                     # Test utilities & mocks
│   └── main.tsx                  # React entry point
├── src-tauri/                    # Backend (Rust)
│   ├── src/
│   │   ├── domain/               # Entities, services, repositories (interfaces)
│   │   ├── application/          # Use cases (business logic orchestration)
│   │   ├── data/                 # Repository implementations, data sources
│   │   ├── presentation/         # Tauri commands, state
│   │   ├── evolution/            # Evolution Gaming integration
│   │   ├── pragmatic/            # Pragmatic Play integration
│   │   └── security/             # Anti-debugging, integrity checks
│   ├── Cargo.toml
│   └── tauri.conf.json
├── CLAUDE.md                     # Project instructions (for Claude Code)
└── AGENTS.md                     # This file
```

### Running Locally

```bash
# Setup
npm install
cd src-tauri && cargo build && cd ..

# Development with hot reload
npm run tauri:dev

# Production build
npm run tauri build

# Run tests
npm run test              # Watch mode
npm run test:run          # Single run
cd src-tauri && cargo test
```

---

## ARCHITECTURE OVERVIEW

### Clean Architecture (Both Frontend & Backend)

The codebase strictly follows Clean Architecture with 4 layers:

```
┌────────────────────────────────────────┐
│        PRESENTATION (UI/Commands)      │
│  React Components (Frontend)           │
│  Tauri Commands (Backend)              │
├────────────────────────────────────────┤
│        APPLICATION (Orchestration)     │
│  Services, Use Cases, DI Container     │
├────────────────────────────────────────┤
│         DOMAIN (Business Logic)        │
│  Entities, Services, Repository        │
│  Interfaces (no external deps)         │
├────────────────────────────────────────┤
│   INFRASTRUCTURE/DATA (External)       │
│  Adapters, API clients, DB, WebSocket  │
└────────────────────────────────────────┘
```

### Key Principles

1. **Dependency Inversion**: Domain doesn't depend on Infrastructure. Use interfaces (ports) defined in Domain.
2. **Single Source of Truth (SSOT)**: Frontend maintains game history; Rust state is stale.
3. **Event-Driven**: Casino WebSocket events → services → React contexts → UI updates.
4. **Isolation**: Each casino provider (Evolution/Pragmatic) has separate adapters.
5. **Type Safety**: Full TypeScript + Rust typing; all domain types in `src/domain/entities/index.ts`.

---

## FRONTEND ARCHITECTURE

### Directory Structure

```
src/
├── domain/
│   ├── entities/index.ts         # 729+ lines: All TypeScript types
│   ├── interfaces/index.ts       # Port interfaces (IAuthPort, ICasinoAdapter, etc.)
│   └── utils/converters.ts       # Type conversion helpers
├── application/
│   ├── di/
│   │   ├── Container.ts          # Generic DI container with factory support
│   │   └── setupContainer.ts     # Service registration
│   ├── services/
│   │   ├── VirtualBettingService.ts
│   │   ├── RoomFilterService.ts
│   │   ├── MultiRoomPredictionService.ts
│   │   ├── SemiAutoService.ts
│   │   ├── AutoModeService.ts
│   │   ├── SessionService.ts
│   │   ├── AutoBettingService.ts
│   │   ├── PatternBettingService.ts
│   │   └── CustomPatternService.ts
│   └── utils/
│       ├── CallbackManager.ts    # Event emitter
│       └── StorageManager.ts     # LocalStorage helper
├── presentation/
│   ├── components/
│   │   ├── LoginScreen/
│   │   ├── MainScreen/           # Routes by appMode
│   │   ├── AutoModePanel/        # Multi-room UI
│   │   ├── PredictModePanel/     # Prediction + virtual betting
│   │   ├── SemiAutoPanel/        # Single-room UI
│   │   ├── BettingPanel/
│   │   ├── Toast/
│   │   ├── NoticePopup/
│   │   ├── ErrorBoundary/
│   │   ├── shared/
│   │   └── common/
│   ├── hooks/
│   │   ├── useSession.ts
│   │   ├── useCasino.ts
│   │   ├── useVirtualBetting.ts
│   │   ├── useRoomFilters.ts
│   │   ├── useCustomPatterns.ts
│   │   ├── useMultiRoomPrediction.ts
│   │   ├── useSemiAuto.ts
│   │   ├── useAutoMode.ts
│   │   ├── useGameEvents.ts
│   │   ├── useHistoryLog.ts
│   │   ├── useCountUp.ts
│   │   └── useWindowControl.ts
│   └── context/
│       ├── DIContext.tsx
│       ├── ErrorContext.tsx
│       ├── GameConfigContext.tsx
│       ├── GameDataContext.tsx
│       └── GameContext.tsx (merged view)
└── infrastructure/
    ├── adapters/
    │   ├── EvolutionAdapter.ts       # Evolution WebSocket parsing
    │   ├── PragmaticAdapter.ts       # Pragmatic Play parsing
    │   ├── TauriAdapter.ts           # Facade
    │   ├── LocalStorageAdapter.ts
    │   └── tauri/
    │       ├── TauriAuthAdapter.ts
    │       ├── TauriCdpAdapter.ts
    │       ├── TauriWindowAdapter.ts
    │       ├── TauriConnectionAdapter.ts
    │       ├── TauriPredictionAdapter.ts
    │       └── TauriSessionMonitorAdapter.ts
    └── utils/
        └── SoundManager.ts           # Web Audio API
```

### Domain Layer: Type System (src/domain/entities/index.ts)

**Core Types** (all in single 729+ line file):

```typescript
// Winners
type Winner = 'B' | 'P' | 'T'  // Banker, Player, Tie

// Application modes
type AppMode = 'auto' | 'predict'

// Game phases
type GamePhase = 'betting' | 'dealing' | 'result' | 'idle'

// Prediction state machine
type PredictionMode = 'Analyzing' | 'Ready' | 'WaitingResult' | 'ShowingResult'

// Betting strategies
type BetStrategyType = 'martingale' | 'fibonacci' | 'paroli' | 'flat'
type PatternBetDirection = 'B' | 'P' | 'skip' | 'ai'

// Room filters
type RoomFilterType =
  | 'losing_streak'    // N consecutive losses
  | 'alternating'      // B/P alternating pattern
  | 'long_streak'      // Streak >= 4
  | 'winning_streak'   // Consecutive wins in current bet
  | 'short_streak'     // Streak < 4
  | 'after_tie'        // After tie result
  | 'banker_dominant'  // Banker wins > 60%
  | 'player_dominant'  // Player wins > 60%

// Casino providers
type CasinoProvider = 'evolution' | 'pragmatic'

// Session status
type SessionStatus = 'valid' | 'warning' | 'expired' | 'offline'

// Entities
interface Room { id: string; name: string; table: string; provider: CasinoProvider; ... }
interface User { id: string; username: string; token: string; ... }
interface GameState { phase: GamePhase; currentBet: Prediction | null; history: RoadResult[] }
interface Prediction { roomId: string; winner: Winner; confidence: number; timestamp: Date }
interface VirtualBetSettings { enabled: boolean; initialBalance: number; strategy: BetStrategyType; }
interface V2PredictionRequest { room_id: string; shoe_state: string; history: RoadResult[] }
interface V2PredictionResponse { winner: Winner; confidence: number; reasoning: string }

// Pure utility functions (NOT in separate files)
function calculateBetAmount(balance: number, level: number, strategy: BetStrategyType): number
function getNextBetLevel(lastResult: Winner, direction: Winner): number
function calculateTotalInvestment(bets: number[]): number
```

### Application Layer: Services

#### 1. VirtualBettingService

**Purpose**: Simulates betting with virtual balance tracking

**Key Functions**:
- `placeBet(roomId, winner, amount, strategy)` — Calculate bet amount using Martingale/Fibonacci/Paroli/Flat
- `processResult(roomId, actual)` — Update balance with 5% banker commission
- `calculateBetAmount(level, strategy)` — Algorithm for each strategy type
- `getBalance(roomId)` — Current room balance

#### 2. RoomFilterService

**Purpose**: Pattern-based room filtering and scoring

**8 Built-in Filters**:
1. `losing_streak` — Detect N consecutive losses
2. `alternating` — B/P alternating pattern
3. `long_streak` — Streak >= 4
4. `winning_streak` — Consecutive wins
5. `short_streak` — Streak < 4
6. `after_tie` — Rooms that just had tie
7. `banker_dominant` — Banker wins > 60%
8. `player_dominant` — Player wins > 60%

#### 3. MultiRoomPredictionService

**Purpose**: Central orchestrator for multi-room predictions

**State**:
- `autoMode` — Is auto mode active?
- `roomStates` — Map of roomId → prediction state
- `focusedRoomId` — Single room focus (or null)
- `pendingPredictions` — Debounced API calls
- `globalStats` — Aggregate stats across rooms

#### 4. SemiAutoService

**Purpose**: Single-room semi-automatic betting

**State** (21 fields):
- `enabled` — Service active?
- `selectedRoomId` — Room being monitored
- `predictionMode` — State machine (Analyzing/Ready/WaitingResult/ShowingResult)
- `currentBet` — Active prediction
- `winCount` — Consecutive wins for room movement
- `martingaleLevel` — Current Martingale level

#### 5. AutoModeService

**Purpose**: Multi-room auto-betting with strategy orchestration

**Sub-modules** (in `src/application/services/automode/`):
- `MartingaleManager` — Martingale tracking per room
- `RestPeriodManager` — Cooldown between bets
- `BettingDecisionService` — When to bet
- `PatternPredictionService` — Pattern-based direction override
- `AutoModeRepository` — Persistent settings

#### 6. SessionService

**Purpose**: Session lifecycle management + validation

**Features**:
- **Countdown Timer**: Displays remaining seconds (starts at 1800s = 30min)
- **Warning State**: isWarning = true when < 5min remaining
- **Validation Loop**: Every 30s, call `validate_session` command
- **Duplicate Login Detection**: Rust backend detects; frontend receives force_quit_app command
- **Auto-Exit**: On expiry, logout and return to login screen

### Presentation Layer: React Components & Hooks

#### Main Routes (src/presentation/components/MainScreen/MainScreen.tsx)

Routes by `appMode`:
- `appMode === 'auto'` → `<AutoModePanel />`
- `appMode === 'predict'` → `<PredictModePanel />`

#### Hooks

**useSession**
```typescript
const {
  remainingSeconds,    // 0-1800
  isWarning,           // < 5min
  isValid,             // true/false
  isOnline,            // internet connected
} = useSession()
```

**useCasino**
```typescript
const {
  isConnected,         // WebSocket connected
  provider,            // 'evolution' | 'pragmatic'
  rooms,               // Room[]
  currentRoom,         // Room | null
} = useCasino()
```

**useVirtualBetting**
```typescript
const {
  enabled,             // true/false
  globalBalance,       // number
  roomStates,          // Map<roomId, { balance, bets }>
  settings,            // VirtualBetSettings
} = useVirtualBetting()
```

**useMultiRoomPrediction**
```typescript
const {
  autoMode,            // true/false
  roomStates,          // Map<roomId, { prediction, state }>
  globalStats,         // { totalWins, totalLosses, accuracy }
  focusedRoomId,
} = useMultiRoomPrediction()
```

**useSemiAuto**
```typescript
const {
  enabled,
  selectedRoomId,
  predictionMode,      // 'Analyzing' | 'Ready' | 'WaitingResult' | 'ShowingResult'
  currentBet,
  winCount,
} = useSemiAuto()
```

### Infrastructure Layer: Adapters

#### EvolutionAdapter (src/infrastructure/adapters/EvolutionAdapter.ts)

**Parses Evolution WebSocket messages**:
- `widget.resolved` → Game started, extract shoe state
- `game.result` → Game result (B/P/T), extract winner
- `encodedShoeState` → Decode shoe card count
- `BALANCE_UPDATE` → User balance change

**Handles**:
- 33+ Korean room names
- Shoe change detection
- Connection state
- Multiple tables per socket

#### PragmaticAdapter

Similar to Evolution but for Pragmatic Play with message format differences.

#### TauriAdapter Facade

Delegates to specialized adapters (Auth, CDP, Window, Prediction, Session).

### Dependency Injection

**Container** (src/application/di/Container.ts):

```typescript
class Container {
  register<T>(key: string, factory: () => T)
  resolve<T>(key: string): T
}
```

**Setup** (src/application/di/setupContainer.ts):

Registers all ports, services, and adapters at app startup.

---

## BACKEND ARCHITECTURE

### Directory Structure

```
src-tauri/src/
├── presentation/
│   ├── state.rs                  # Global AppState
│   └── commands/
│       ├── auth_commands.rs
│       ├── session_commands.rs
│       ├── connection_commands.rs
│       ├── room_commands.rs
│       ├── prediction_commands.rs
│       └── webview_commands.rs (CDP)
├── application/
│   └── usecases/
│       ├── user_authentication.rs
│       ├── session_monitor.rs
│       ├── single_room_prediction.rs
│       └── multi_room_prediction.rs
├── domain/
│   ├── entities/ (user, session, room, game, prediction)
│   ├── services/ (game_logic, pattern_analyzer, session_manager)
│   ├── repositories/ (traits)
│   └── error.rs
├── data/
│   ├── datasources/ (prediction_api, local_storage, evolution_data)
│   └── repositories/ (implementations)
├── evolution/          # 33+ tables via single WebSocket
├── pragmatic/          # Per-room connections
└── security/           # anti_debug, integrity checks
```

### Evolution Gaming Integration

**Multi-Client Architecture** (src-tauri/src/evolution/multi_client.rs):

- **Single WebSocket**: Connects once to Evolution lobby, handles 33+ tables
- **Message Multiplexing**: Routes messages to correct table handler
- **Chrome TLS Fingerprint**: Uses `rquest` crate with Chrome 131 emulation to bypass Akamai bot detection
- **Automatic Reconnection**: On disconnect, reconnect with exponential backoff

### Pragmatic Play Integration

**Manager Architecture** (src-tauri/src/pragmatic/):

- **Multiple Connections**: One socket per room (unlike Evolution's single socket)
- **Normalizer**: Convert Pragmatic format → common format (matches Evolution)

### Data Source: BCR Prediction API

**prediction_api.rs** handles:
- Login/authentication
- V2 prediction requests
- Result reporting
- Shoe state management

---

## DATA FLOW & STATE MANAGEMENT

### Complete User Flow

**1. Login Flow**
```
User credentials → Frontend → TauriAuthAdapter.login()
                 → Rust auth_commands::login()
                 → UserAuthentication use case
                 → PredictionApi.login() → BCR backend
                 → Save to SQLite
                 → Return User to frontend
                 → MainScreen with appMode='predict'
```

**2. Casino Connection Flow**
```
Frontend: Connect → TauriAdapter.connectEvolution()
       → Rust evolution_commands::connect_evolution_multi_socket()
       → EvolutionMultiClient::connect() (single WebSocket)
       → Subscribe to 33+ tables
       → Listen for messages
       → Emit EvolutionEvent → Bridge to Tauri frontend event
       → Frontend receives event via listen('evolution_event')
       → Update GameDataContext → Re-render
```

**3. Prediction Request Flow**
```
Casino sends betting_phase for room #5
       → useGameEvents receives event
       → MultiRoomPredictionService.requestPrediction(roomId, history)
       → TauriAdapter.requestPrediction()
       → Rust prediction_commands::request_prediction_v2()
       → BCR API
       → Return Prediction{winner, confidence}
       → Store in roomStates
       → Update PredictionMode → Ready
       → Display prediction
```

**4. Result Processing Flow**
```
Casino sends game_result → useGameEvents
                        → MultiRoomPredictionService.processResult()
                        → Compare prediction vs actual
                        → report_result_v2 command
                        → Update accuracy stats
                        → VirtualBettingService.processResult() → balance update
                        → Update charts and UI
```

### Frontend State Management

**React Context Hierarchy**:
- **DIContext**: DI Container
- **ErrorContext**: Centralized errors + notifications
- **GameConfigContext**: User config (persisted to localStorage)
- **GameDataContext**: Real-time data (in-memory)
- **GameContext**: Merged view for backward compatibility

**Frontend is SSOT**: Frontend maintains complete game history. Rust state is stale. Always pass full history to `request_prediction_with_history()`.

---

## TAURI COMMANDS REFERENCE

### Authentication (7 commands)

| Command | Signature | Purpose |
|---------|-----------|---------|
| `login` | `(username, password) → User` | User login |
| `logout` | `() → void` | Logout |
| `restore_session` | `() → User` | Restore from storage |
| `is_logged_in` | `() → boolean` | Check login status |
| `get_current_user` | `() → User \| null` | Get current user |
| `get_client_version` | `() → string` | Get version |
| `download_client_update` | `(url: string) → void` | Download update |

### Session Management (7 commands)

| Command | Purpose |
|---------|---------|
| `validate_session` | Validate JWT, detect duplicates |
| `check_session_validity` | Check if session valid + remaining seconds |
| `get_remaining_seconds` | Get session countdown |
| `start_session_monitoring` | Begin validation loop |
| `stop_session_monitoring` | Stop validation loop |
| `force_quit_app` | Emergency logout |
| `manual_token_validation` | Manual JWT validation |

### Evolution Gaming (5 commands)

Connect to Evolution 33+ tables via single WebSocket.

### Pragmatic Play (7 commands)

Connect to Pragmatic Play tables (one socket per room).

### Room Management (6 commands)

Get rooms, subscribe, rank by filters.

### Prediction API V2 (10+ commands)

Request predictions, report results, get predictions.

### Chrome DevTools Protocol (14+ commands)

CDP monitoring for WebSocket capture, navigation, Chrome control.

---

## DOMAIN TYPES & ENUMS

### Core Types

```typescript
type Winner = 'B' | 'P' | 'T'  // Banker, Player, Tie
type AppMode = 'auto' | 'predict'
type GamePhase = 'betting' | 'dealing' | 'result' | 'idle'
type PredictionMode = 'Analyzing' | 'Ready' | 'WaitingResult' | 'ShowingResult'
type BetStrategyType = 'martingale' | 'fibonacci' | 'paroli' | 'flat'
type PatternBetDirection = 'B' | 'P' | 'skip' | 'ai'
type RoomFilterType = 'losing_streak' | 'alternating' | 'long_streak' | 'winning_streak' | 'short_streak' | 'after_tie' | 'banker_dominant' | 'player_dominant'
type CasinoProvider = 'evolution' | 'pragmatic'
type SessionStatus = 'valid' | 'warning' | 'expired' | 'offline'
```

### Entities

```typescript
interface User { id: string; username: string; token: string; ... }
interface Room { id: string; name: string; table: string; provider: CasinoProvider; ... }
interface Prediction { id: string; roomId: string; winner: Winner; confidence: number; ... }
interface GameState { roomId: string; phase: GamePhase; history: RoadResult[] }
interface VirtualBetSettings { enabled: boolean; initialBalance: number; strategy: BetStrategyType }
```

---

## KEY SERVICES & USE CASES

### Service Pattern

All services follow:
```typescript
interface Service {
  init(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  getState(): State
  on(event: string, handler: (data: any) => void): Unsubscribe
  destroy(): void
}
```

### Backend UseCase Pattern

```rust
pub struct UseCase {
    repository: Arc<dyn Repository>,
    service: Arc<Service>,
}

impl UseCase {
    pub async fn execute(&self, input: Input) -> Result<Output> {
        // Orchestrate: repository → service → domain logic → output
    }
}
```

---

## TESTING GUIDE

### Frontend Testing Setup

**Framework**: Vitest 4 + @testing-library/react + jsdom

**Setup** (src/test/setup.ts): Mocks all Tauri APIs

**Existing Test Files** (5 suites):
1. VirtualBettingService.test.ts (~500 lines)
2. SemiAutoService.test.ts (~449 lines)
3. AutoModeService.test.ts (~300 lines)
4. RoomFilterService.test.ts (~251 lines)
5. MultiRoomPredictionService.test.ts (~124 lines)

**Running Tests**:
```bash
npm run test              # Watch mode
npm run test:run          # Single run
npm run test:coverage     # Coverage report
```

### Backend Testing

```bash
cd src-tauri
cargo test
```

---

## COMMON TASKS & RECIPES

### Adding a New Prediction Strategy

1. Update domain types (src/domain/entities/index.ts)
2. Implement in VirtualBettingService
3. Add settings interface
4. Update UI components
5. Write tests

### Adding a New Room Filter

1. Add to domain type (RoomFilterType)
2. Implement detection logic in RoomFilterService
3. Add UI filter tab
4. Write tests

### Connecting a New Casino Provider

1. Create adapter (src/infrastructure/adapters/)
2. Register in DI container
3. Add backend integration (src-tauri/src/)
4. Register Tauri commands
5. Update domain types

### Adding CDP Command

1. Implement in Rust (src-tauri/src/presentation/commands/)
2. Register command in lib.rs
3. Create adapter in frontend
4. Call from service/component

---

## BUILD & DEPLOYMENT

### Development Build

```bash
npm run dev                # Vite dev server
npm run tauri:dev          # Full app with hot reload
```

### Production Build

```bash
npm run build              # Frontend bundle
npm run tauri build        # Package desktop app
```

### Release Optimizations

Rust uses aggressive optimizations:
- Link-time optimization (LTO)
- Single codegen unit
- Size optimization (opt-level="z")
- Symbol stripping
- Panic abort

---

## DEBUGGING & TROUBLESHOOTING

### Common Issues & Solutions

**"Cannot find invoke in context"**
- Cause: Tauri not initialized
- Fix: Ensure setupContainer() called in main.tsx

**"WebSocket connection refused"**
- Cause: Evolution WebSocket URL not captured
- Fix: Check CDP monitoring, verify Chrome connected, check TLS

**"Predictions always same (stale state)"**
- Cause: Using cached Rust state instead of frontend history
- Fix: Use request_prediction_with_history() with full game history

**"Virtual betting balance not updating"**
- Cause: VirtualBettingService.processResult() not called
- Fix: Ensure useGameEvents hook active

**"Room filter not working"**
- Cause: Pattern detection logic incorrect
- Fix: Log room history, check pattern matching, verify filter enabled

### Logging

**Frontend**:
```typescript
localStorage.setItem('DEBUG', '*')
console.log(multiRoomPredictionService.getState())
```

**Backend**:
```rust
use tracing::{info, debug, warn, error};
info!("User logged in: {}", user.id);
```

**Chrome DevTools**:
```bash
TAURI_CLI_RUN_FORCE_DEVTOOLS=true npm run tauri:dev
```

---

## PERFORMANCE & OPTIMIZATION

### Frontend Optimization

**Code Splitting**: Vite automatically chunks vendor, services, charts

**Virtual Rendering**: @tanstack/react-virtual for 33+ room grid

**State Optimization**:
- Use `useCallback` to memoize callbacks
- Use `useMemo` for expensive computations
- Split contexts to avoid unnecessary re-renders

**Bundle Size**: ~3MB after optimization + compression

### Backend Optimization

**Single WebSocket for 33+ Rooms**: Evolution multiplexing saves bandwidth

**Async/Await with Tokio**: Concurrent operations, no blocking

**Chrome TLS Fingerprint**: rquest emulates Chrome 131, bypasses Akamai

**SQLite Optimization**: Use prepared statements with sqlx

---

## SECURITY CONSIDERATIONS

### Frontend Security

**CORS & CSP**: Configured in tauri.conf.json

**Token Storage**: JWT in memory only, cleared on logout

**WebSocket Security**: Use wss:// only, verify certificate

### Backend Security

**Anti-Debugging** (Release mode only): Detects debuggers

**Integrity Verification** (Release mode only): Detects tampering

**Token Validation**: JWT with signing key

**Database Security**: Parameterized queries prevent SQL injection

### Sensitive Data Handling

**Do NOT log**: Tokens, passwords, credit cards, API keys

**Do log**: User IDs (hashed), timestamps, error types, request sizes

---

## KEY FILES & LOCATIONS

| File | Lines | Purpose |
|------|-------|---------|
| `src/domain/entities/index.ts` | 729+ | TypeScript types |
| `src/application/services/VirtualBettingService.ts` | 200+ | Virtual betting |
| `src/application/services/RoomFilterService.ts` | 150+ | Pattern filtering |
| `src/application/services/MultiRoomPredictionService.ts` | 180+ | Orchestration |
| `src/infrastructure/adapters/EvolutionAdapter.ts` | 250+ | Evolution parsing |
| `src-tauri/src/evolution/multi_client.rs` | 300+ | Single WebSocket |
| `src-tauri/src/data/datasources/prediction_api.rs` | 150+ | BCR API |
| `src-tauri/Cargo.toml` | 40+ | Dependencies |
| `vite.config.ts` | 30+ | Bundler config |
| `vitest.config.ts` | 20+ | Test config |

---

## CODING CONVENTIONS

### TypeScript/Frontend

- **Indentation**: 2 spaces
- **Quotes**: Single quotes
- **Semicolons**: None
- **Trailing commas**: Yes
- **Naming**:
  - Components: PascalCase
  - Hooks: `use*` prefix
  - Functions/variables: camelCase
  - Constants: UPPER_CASE
  - Types: PascalCase
- **Component Files**: Self-contained folders with `index.ts`

### Rust/Backend

- **Style**: Standard rustfmt
- **Naming**: snake_case
- **Visibility**: `pub` for public, `pub(crate)` for internal
- **Doc comments**: `///` for public items
- **Error handling**: Use `Result<T>`

### Commits

- **Format**: `<type>: <subject>`
- **Types**: feat, fix, refactor, chore, docs, test
- **Subject**: Present tense, lowercase, <50 chars

---

## QUICK REFERENCE CHECKLIST

### Before Starting Work

- [ ] Understand Clean Architecture layers
- [ ] Know whether task is frontend (React) or backend (Rust)
- [ ] Identify domain types to use
- [ ] Check if similar feature exists
- [ ] Review existing tests for patterns

### When Adding Features

- [ ] Add types to `src/domain/entities/index.ts`
- [ ] Implement service in `src/application/services/`
- [ ] Create/update port interface in `src/domain/interfaces/`
- [ ] Implement adapter in `src/infrastructure/adapters/`
- [ ] Register in DI container
- [ ] Add Tauri command if needed
- [ ] Write tests (Vitest + cargo test)
- [ ] Update this document if adding new patterns

### When Debugging

- [ ] Check frontend console (React DevTools)
- [ ] Check Tauri console (Ctrl+Shift+I)
- [ ] Check Rust logs
- [ ] Verify WebSocket connection (Chrome DevTools)
- [ ] Check state in React DevTools
- [ ] Trace data flow through layers

### Release Checklist

- [ ] All tests passing
- [ ] No console errors/warnings
- [ ] Build succeeds
- [ ] Binary size acceptable (~3-5MB)
- [ ] Anti-debug working
- [ ] Session management working
- [ ] Multi-room prediction stable
- [ ] Chrome CDP integration working
- [ ] Version bumped
- [ ] Changelog updated

---

**Last Updated**: 2026-02-16
**Maintainer**: AI Agents on BCR Predictor Project
**Questions?** Refer to `CLAUDE.md` for project context and repository guidelines.
