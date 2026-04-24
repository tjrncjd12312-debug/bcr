# BCR Predictor - Gemini Context

## Project Overview

BCR Predictor is a desktop application for Baccarat game prediction, built using **Tauri 2.0**. It combines a **React/TypeScript** frontend with a **Rust** backend, employing **Clean Architecture** principles on both sides to ensure modularity and testability.

The application works by monitoring live Baccarat games (specifically Evolution Gaming) via a hidden Chrome window controlled by the Chrome DevTools Protocol (CDP), capturing real-time game state, and providing AI-based predictions.

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS (implied by class names), Chart.js
- **Backend:** Rust, Tauri 2.0, Tokio (Async Runtime), Sqlx (SQLite), Reqwest
- **Integration:** Chrome DevTools Protocol (CDP) for WebSocket capture and automation

## Architecture

The project strictly follows **Clean Architecture**.

### Layers (Mirrored in Frontend & Backend)

1.  **Presentation:** UI components and command handlers.
    *   *Frontend:* `src/presentation/components`, `src/presentation/hooks`
    *   *Backend:* `src-tauri/src/presentation/commands`
2.  **Application:** Business logic orchestration and use cases.
    *   *Frontend:* `src/application/services`
    *   *Backend:* `src-tauri/src/application/usecases`
3.  **Domain:** Pure business entities and rules. Independent of frameworks.
    *   *Frontend:* `src/domain/entities`, `src/domain/interfaces`
    *   *Backend:* `src-tauri/src/domain/entities`, `src-tauri/src/domain/services`
4.  **Infrastructure:** External interfaces (API, Database, WebSocket).
    *   *Frontend:* `src/infrastructure/adapters`
    *   *Backend:* `src-tauri/src/data/datasources`, `src-tauri/src/data/repositories`

### Data Flow

1.  **Capture:** The app opens a casino lobby in a hidden window. `webview_commands.rs` uses CDP to intercept the Evolution Gaming WebSocket connection.
2.  **Processing:** Game events are parsed (currently primarily in frontend via `EvolutionAdapter`, intended to be mirrored/synced with backend).
3.  **Prediction:**
    *   Users subscribe to a room.
    *   `PredictionService` (frontend) coordinates requests.
    *   `TauriAdapter` sends history/state to Rust backend.
    *   Rust backend calculates predictions (via local logic or external API) and returns them.
4.  **Display:** React components (`MainScreen`, `StatsChart`) render the game state and prediction results.

## Key Directories & Files

### Frontend (`src/`)

*   **`application/services/`**:
    *   `PredictionService.ts`: Manages the prediction workflow (request -> wait -> result).
    *   `RoomFilterService.ts`: Filters rooms based on patterns (streaks, chops).
    *   `VirtualBettingService.ts`: Simulates betting strategies without real money.
*   **`infrastructure/adapters/`**:
    *   `EvolutionAdapter.ts`: Parses raw WebSocket messages from Evolution Gaming.
    *   `TauriAdapter.ts`: Interface to the Rust backend (Tauri Commands).
*   **`presentation/`**:
    *   `components/`: UI modules (`LoginScreen`, `MainScreen`, etc.).
    *   `hooks/`: Custom hooks (`usePrediction`, `useEvolution`).
*   **`domain/entities/`**: Core types (`Room`, `Winner` ('B'|'P'|'T'), `GamePhase`).

### Backend (`src-tauri/src/`)

*   **`presentation/commands/`**:
    *   `webview_commands.rs`: CDP integration for monitoring network traffic.
    *   `prediction_commands.rs`: Handles prediction requests.
    *   `room_commands.rs`: Room management.
*   **`domain/`**:
    *   `game_logic.rs`: Core Baccarat rules.
    *   `pattern_analyzer.rs`: Pattern recognition logic.
*   **`data/datasources/`**:
    *   `evolution_websocket.rs`: Backend WebSocket handling.

## Development Commands

### Prerequisites
*   Node.js (v18+)
*   Rust (Latest Stable)
*   Tauri CLI (`npm install -g @tauri-apps/cli`)

### Workflow

```bash
# Install Dependencies
npm install

# Start Development Server (Frontend + Rust Backend)
# This is the primary command for development.
npm run tauri:dev

# Frontend Only (Vite Server)
npm run dev

# Build for Production
npm run tauri build
```

## Known Issues & Refactoring Context

*   **Data Synchronization:** There is a disconnect between the frontend's `EvolutionAdapter` (active) and the backend's `EvolutionWebSocket` (passive/stale).
*   **Refactoring Plan:** A plan exists to move towards a "Single Source of Truth" model where the frontend (which has the fresh WebSocket data) passes history to the backend for prediction, rather than the backend trying to maintain its own stale state.
*   **CDP Polling:** The CDP monitoring loop currently exits too early; it needs to persist to capture new tabs/rooms.

## Conventions

*   **Code Style:**
    *   **TypeScript:** 2-space indent, single quotes, no semicolons, trailing commas.
    *   **Rust:** Standard `rustfmt`.
*   **Naming:**
    *   **Components:** PascalCase (`LoginScreen`).
    *   **Hooks:** `use` prefix (`usePrediction`).
    *   **Services/Adapters:** CamelCase (`predictionService`).
    *   **Rust:** snake_case for functions/modules.
