# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BCR Predictor is a Tauri 2.0 desktop application for baccarat game prediction. It uses a React 18/TypeScript frontend with a Rust backend, following Clean Architecture principles on both sides. The application supports Evolution Gaming and Pragmatic Play casinos with features including semi-automatic prediction, multi-room monitoring, virtual betting, and auto-betting with various strategies.

## Build & Development Commands

```bash
# Frontend development (Vite dev server only, port 1420)
npm run dev

# Full desktop app with hot reload (frontend + Rust backend)
npm run tauri:dev

# Type-check and build production frontend assets
npm run build

# Build packaged desktop app (outputs to src-tauri/target/release)
npm run tauri build

# Preview built frontend assets
npm run preview

# Run frontend tests (watch mode)
npm run test

# Run frontend tests (single run)
npm run test:run

# Run frontend tests with coverage
npm run test:coverage
```

**Rust-specific commands (from src-tauri/):**
```bash
cd src-tauri
cargo build              # Debug build
cargo build --release    # Release build
cargo test               # Run Rust tests
cargo clippy             # Lint Rust code
```

## Architecture

### Clean Architecture Layers (Both Frontend & Backend)

```
┌─────────────────────────────────────────────────────────────┐
│                     PRESENTATION                             │
│  React Components (src/presentation/components/)            │
│  React Hooks (src/presentation/hooks/)                      │
│  Tauri Commands (src-tauri/src/presentation/commands/)      │
├─────────────────────────────────────────────────────────────┤
│                     APPLICATION                              │
│  Frontend Services (src/application/services/)              │
│  DI Container (src/application/di/)                         │
│  Rust Use Cases (src-tauri/src/application/usecases/)       │
├─────────────────────────────────────────────────────────────┤
│                       DOMAIN                                 │
│  TypeScript Entities (src/domain/entities/)                 │
│  Rust Entities (src-tauri/src/domain/entities/)             │
│  Rust Services (src-tauri/src/domain/services/)             │
│  Repository Interfaces (src-tauri/src/domain/repositories/) │
├─────────────────────────────────────────────────────────────┤
│                   INFRASTRUCTURE                             │
│  Tauri Adapters (src/infrastructure/adapters/)              │
│  Data Sources (src-tauri/src/data/datasources/)             │
│  Repository Impls (src-tauri/src/data/repositories/)        │
└─────────────────────────────────────────────────────────────┘
```

### Frontend (TypeScript/React)

**Presentation Layer:**
- `src/presentation/components/`: React UI components
  - `LoginScreen/`: Authentication UI
  - `MainScreen/`: Primary dashboard
  - `SemiAutoPanel/`: Semi-automatic betting mode
  - `AutoModePanel/`: Auto-betting UI
  - `PredictModePanel/`: Prediction display
  - `Toast/`: Notification system
- `src/presentation/hooks/`: State management hooks
  - `useSession.ts`: Authentication state
  - `useCasino.ts`: Casino connection
  - `useSemiAuto.ts`: Semi-automatic mode logic
  - `useAutoMode.ts`: Auto-betting mode
  - `useVirtualBetting.ts`: Virtual bet simulation
  - `useMultiRoomPrediction.ts`: Multi-room predictions
  - `useRoomFilters.ts`: Room filtering logic
  - `useCustomPatterns.ts`: Pattern detection
  - `useGameEvents.ts`: Real-time game events
- `src/presentation/context/`: React contexts
  - `GameContext.tsx`: Current game state
  - `GameDataContext.tsx`: Real-time updates
  - `GameConfigContext.tsx`: Settings
  - `DIContext.tsx`: Dependency injection provider
  - `ErrorContext.tsx`: Error handling

**Application Layer:**
- `src/application/services/`: Business logic services
  - `SemiAutoService.ts`: Semi-automatic betting orchestration
  - `MultiRoomPredictionService.ts`: Multi-room prediction management
  - `VirtualBettingService.ts`: Simulated betting with strategies
  - `RoomFilterService.ts`: Room filtering and sorting
  - `AutoBettingService.ts`: Auto-betting logic
  - `PatternBettingService.ts`: Pattern-based betting
  - `CustomPatternService.ts`: Custom pattern detection
  - `SessionService.ts`: Session management
- `src/application/di/`: Dependency injection
  - `Container.ts`: Generic DI container
  - `setupContainer.ts`: Service initialization

**Domain Layer:**
- `src/domain/entities/index.ts`: All TypeScript type definitions (729+ lines)

**Infrastructure Layer:**
- `src/infrastructure/adapters/`: External system bridges
  - `EvolutionAdapter.ts`: Evolution Gaming WebSocket parsing
  - `PragmaticAdapter.ts`: Pragmatic Play WebSocket parsing
  - `TauriAdapter.ts`: Rust backend IPC
  - `LocalStorageAdapter.ts`: Browser storage
  - `tauri/`: Specialized Tauri adapters (Auth, CDP, Window)
- `src/infrastructure/utils/`: Utilities
  - `SoundManager.ts`: Audio notifications

### Backend (Rust/Tauri)

**Presentation Layer:**
- `src-tauri/src/presentation/commands/`: Tauri command handlers
  - `auth_commands.rs`: Login, logout, session restore
  - `session_commands.rs`: Session validation & monitoring
  - `connection_commands.rs`: Evolution WebSocket connection
  - `prediction_commands.rs`: Prediction requests (V2 API)
  - `room_commands.rs`: Room list, filtering, subscriptions
  - `webview_commands.rs`: Chrome/CDP integration
- `src-tauri/src/presentation/state.rs`: Global app state

**Application Layer:**
- `src-tauri/src/application/usecases/`: Business logic orchestration
  - `user_authentication.rs`: Auth flow
  - `connect_evolution.rs`: Evolution connection
  - `single_room_prediction.rs`: Single prediction
  - `multi_room_prediction.rs`: Multi-room predictions
  - `session_monitor.rs`: Session monitoring

**Domain Layer:**
- `src-tauri/src/domain/entities/`: Core data structures
  - `user.rs`, `session.rs`, `room.rs`, `game.rs`, `prediction.rs`
- `src-tauri/src/domain/services/`: Core business logic
  - `game_logic.rs`: Prediction algorithms
  - `pattern_analyzer.rs`: Pattern detection
  - `session_manager.rs`: Session handling
- `src-tauri/src/domain/repositories/`: Repository interfaces

**Data Layer:**
- `src-tauri/src/data/datasources/`: External integrations
  - `evolution_websocket.rs`: Evolution WebSocket handler
  - `evolution_data.rs`: Evolution data structures
  - `prediction_api.rs`: BCR Prediction API client
  - `local_storage.rs`: SQLite database
- `src-tauri/src/data/repositories/`: Repository implementations

**Casino Modules:**
- `src-tauri/src/evolution/`: Evolution Gaming integration
  - `lobby_client.rs`: Lobby WebSocket
  - `multi_client.rs`: Multi-table handler
  - `commands.rs`: Tauri commands
- `src-tauri/src/pragmatic/`: Pragmatic Play integration
  - `client.rs`: WebSocket client
  - `manager.rs`: Connection manager
  - `parser.rs`: Message parsing
  - `normalizer.rs`: Data normalization
  - `discovery.rs`: Service discovery
  - `commands.rs`: Tauri commands

**Security:**
- `src-tauri/src/security/`: Security features
  - `anti_debug.rs`: Anti-debugging checks
  - `integrity.rs`: Integrity verification

### Key Tauri Commands

Commands are invoked from frontend via `invoke()`:

| Category | Commands |
|----------|----------|
| **Auth** | `login`, `logout`, `restore_session`, `is_logged_in` |
| **Session** | `validate_session`, `check_session_validity`, `start_session_monitoring` |
| **Evolution** | `connect_evolution`, `disconnect_evolution`, `is_connected` |
| **Evolution Multi** | `connect_evolution_multi_socket`, `disconnect_evolution_multi_socket` |
| **Pragmatic** | `connect_pragmatic`, `connect_pragmatic_room`, `send_pragmatic_message` |
| **Rooms** | `get_all_rooms`, `get_ranked_rooms`, `subscribe_to_room` |
| **Prediction** | `request_prediction_v2`, `report_result_v2`, `get_all_predictions` |
| **CDP/Chrome** | `start_cdp_monitoring`, `stop_cdp_monitoring`, `open_in_chrome`, `navigate_chrome` |

### Data Flow

1. User logs in → JWT token stored locally
2. App opens Chrome via CDP → navigates to casino lobby
3. CDP monitors network → captures Evolution/Pragmatic WebSocket URL + cookies
4. Rust connects to casino WebSocket → receives real-time game updates
5. Frontend subscribes to room → displays game state via React context
6. On betting phase → `request_prediction_v2` calls BCR API for AI prediction
7. On game result → `report_result_v2` updates stats and transitions state

## Key Domain Types

```typescript
// Winner result
type Winner = 'B' | 'P' | 'T'  // Banker, Player, Tie

// Prediction modes (state machine)
type PredictionMode = 'Analyzing' | 'Ready' | 'WaitingResult' | 'ShowingResult'

// Game phases
type GamePhase = 'betting' | 'dealing' | 'result' | 'idle'

// Betting strategies
type BetStrategyType = 'martingale' | 'fibonacci' | 'paroli' | 'flat'
type PatternBetDirection = 'B' | 'P' | 'skip' | 'ai'

// Room filter types
type RoomFilterType = 'losing_streak' | 'alternating' | 'long_streak'
                    | 'winning_streak' | 'short_streak' | 'after_tie'
                    | 'banker_dominant' | 'player_dominant'

// Casino providers
type CasinoProvider = 'evolution' | 'pragmatic'
```

## Coding Conventions

### TypeScript/Frontend
- **Indent**: 2 spaces
- **Quotes**: Single quotes
- **Semicolons**: None
- **Trailing commas**: Yes
- **Hooks**: Prefix with `use*`, return object with state and actions
- **Components**: PascalCase, self-contained folders with `index.ts`
- **CSS**: BEM-style selectors (`.block__element--modifier`)
- **Constants**: UPPER_CASE

### Rust/Backend
- **Style**: Standard rustfmt
- **Naming**: snake_case for functions/variables
- **Documentation**: Doc comments (`///`)
- **Modules**: Organized by Clean Architecture layer

## Testing

### Frontend Testing
- **Framework**: Vitest v4 with jsdom environment
- **Libraries**: @testing-library/react, @testing-library/jest-dom
- **Mocking**: Tauri API mocked in `src/test/setup.ts`
- **Pattern**: `*.test.ts` or `*.spec.ts`

**Existing test files:**
- `src/application/services/MultiRoomPredictionService.test.ts`
- `src/application/services/VirtualBettingService.test.ts`
- `src/application/services/SemiAutoService.test.ts`
- `src/application/services/RoomFilterService.test.ts`
- `src/application/services/AutoModeService.test.ts`

```bash
npm run test          # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage report
```

### Backend Testing
```bash
cd src-tauri && cargo test
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/main.tsx` | React entry point, DI initialization |
| `src/App.tsx` | Root component with context providers |
| `src/domain/entities/index.ts` | All TypeScript type definitions |
| `src/application/di/Container.ts` | Dependency injection container |
| `src-tauri/src/lib.rs` | Tauri app setup, command registration |
| `src-tauri/src/main.rs` | Binary entry point |
| `src-tauri/tauri.conf.json` | Tauri configuration (window, CSP, bundle) |
| `vite.config.ts` | Vite bundler configuration |
| `vitest.config.ts` | Test framework configuration |

## Key Dependencies

### Frontend
- **React 18**: Component-based UI
- **TypeScript 5.4**: Type safety
- **Vite 5**: Fast dev server and bundler
- **@tauri-apps/api 2.9**: IPC with Rust backend
- **lucide-react**: Icons
- **Chart.js**: Charts and graphs
- **@tanstack/react-virtual**: Virtual scrolling

### Backend
- **Tauri 2.1**: Desktop app framework
- **tokio 1.36**: Async runtime
- **tokio-tungstenite**: WebSocket client (rustls-tls)
- **reqwest 0.12**: HTTP client
- **sqlx 0.8**: SQLite async queries
- **serde/serde_json**: Serialization
- **tracing**: Logging and diagnostics

## Special Features

- **Virtual Betting**: Simulates betting with Martingale/Fibonacci/Paroli/Flat strategies
- **Multi-Room Prediction**: Simultaneous predictions across 33+ rooms
- **Pattern Analysis**: Custom pattern detection (alternating, streaks, dominance)
- **Chrome DevTools Protocol**: Automated casino navigation and WebSocket capture
- **Session Monitoring**: Duplicate login detection and session validation
- **Room Filtering**: Dynamic filtering with 8+ filter types
- **Auto-Betting**: Configurable betting strategies with loss limits

## Release Build Optimizations

The Rust backend uses aggressive optimizations in release mode:
- Link-time optimization (LTO)
- Single codegen unit
- Size optimization (`opt-level = "z"`)
- Symbol stripping
- Panic abort (smaller binary)
