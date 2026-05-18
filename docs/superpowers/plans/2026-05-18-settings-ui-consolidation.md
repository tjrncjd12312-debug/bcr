# Settings UI Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplication across `AutoModeSettingsDialog`, `SemiAutoSettingsDialog`, and `PatternManagerModal` by extracting shared UI primitives (modal frame, Fresh-Shoe toggle, input+suffix field, stat card) and consolidating the three filter-threshold implementations into a single component.

**Architecture:** Pull repeated structure into `src/presentation/components/common/` as small, focused presentational components with no business logic. Each dialog keeps its own state shape and props — only the layout primitives are shared. CSS prefix `settings-*` replaces the duplicated `ams-*` / `sa-*` style blocks. Migration is incremental: each phase ships independently and the existing tests pass between phases. `FilterThresholdInputs` (the global dropdown form) is deleted because `FilterThresholdInline` (per-row) + the AutoMode settings section already cover its job.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react, plain CSS (no CSS modules — repo uses global stylesheets with prefixes).

---

## Repository Conventions (read first)

- **Test runner:** Vitest. Files end in `.test.tsx`. Co-located with the component (`Foo.tsx` + `Foo.test.tsx`).
- **Test command:** `npm test -- <pattern>` runs Vitest with a filename pattern. `npm test` runs the whole suite. From PowerShell, `npm test -- run <pattern>` for single-run mode.
- **Type check:** `npm run typecheck` (uses `tsc --noEmit`).
- **CSS:** No CSS-in-JS. Plain `.css` files imported at the top of each component. CSS variables live in `src/presentation/styles/` (e.g. `--accent-primary`, `--modal-border`). The `common/Modal.css` file already defines `.modal-overlay`, `.modal`, `.modal-header`, `.modal-close`, `.modal-body`, `.modal-footer`, `@keyframes modal-fade-in`, `@keyframes modal-pop` — reuse these.
- **DI:** `getFreshShoePreset()` from `src/application/di/setupContainer.ts` returns the global Fresh-Shoe preset singleton. It is allowed to return `null`.
- **Korean labels:** Keep all Korean copy identical to the existing text. Do not translate or shorten.
- **Frequent commits:** One commit per task. Use Conventional Commits prefixes (`feat:`, `refactor:`, `test:`, `chore:`).

---

## File Structure

**New files (Phase 1–5):**

```
src/presentation/components/common/
├── Modal.css                              (existing — reused, do not edit)
├── SettingsDialogFrame.tsx                NEW — overlay + dialog + header + tabs + footer wrapper
├── SettingsDialogFrame.css                NEW — settings-* class definitions
├── SettingsDialogFrame.test.tsx           NEW
├── FreshShoeToggle.tsx                    NEW — Fresh-Shoe preset checkbox card
├── FreshShoeToggle.test.tsx               NEW
├── NumberFieldWithSuffix.tsx              NEW — labeled input + suffix span
├── NumberFieldWithSuffix.test.tsx         NEW
├── StatCard.tsx                           NEW — label + value stat tile
└── StatCard.test.tsx                      NEW
```

**Modified files:**

```
src/presentation/components/AutoModePanel/components/
├── AutoModeSettingsDialog.tsx             USE new primitives
├── AutoModeSettingsDialog.css             SHRINK — remove duplicated rules
└── AutoModeSettingsDialog.thresholds.test.tsx  KEEP — labels unchanged

src/presentation/components/SemiAutoPanel/components/
├── SemiAutoSettingsDialog.tsx             USE new primitives
└── SemiAutoSettingsDialog.css             SHRINK — remove duplicated rules
```

**Deleted files (Phase 5):**

```
src/presentation/components/AutoModePanel/components/
├── FilterThresholdInputs.tsx              DELETE — superseded by FilterThresholdInline
└── FilterThresholdInputs.css              DELETE
```

(Before deleting, find all importers and migrate them to use `FilterThresholdInline` per-row instead.)

---

# Phase 1 — Shared `SettingsDialogFrame`

The biggest single duplication is the overlay → dialog → header (title + close button) → tabs → scrollable content → footer layout. AutoMode and SemiAuto each implement this from scratch with `ams-*` / `sa-*` classes. We extract a single `SettingsDialogFrame` that owns the chrome and accepts the body as children.

## Task 1.1: Write failing test for SettingsDialogFrame

**Files:**
- Create: `src/presentation/components/common/SettingsDialogFrame.test.tsx`

- [ ] **Step 1: Create the test file**

```tsx
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
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test -- run SettingsDialogFrame`
Expected: FAIL — `Cannot find module './SettingsDialogFrame'`

## Task 1.2: Implement SettingsDialogFrame

**Files:**
- Create: `src/presentation/components/common/SettingsDialogFrame.tsx`
- Create: `src/presentation/components/common/SettingsDialogFrame.css`

- [ ] **Step 1: Write the component**

```tsx
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
  activeTab: T | ''
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

  const hasTabs = tabs && tabs.length > 0

  return (
    <div
      data-testid="settings-dialog-overlay"
      className={`settings-dialog-overlay ${animateIn ? 'visible' : ''}`}
      onClick={handleOverlayClick}
    >
      <div className={`settings-dialog ${animateIn ? 'visible' : ''}`}>
        <div className="settings-dialog-header">
          <h2>{title}</h2>
          <button className="settings-dialog-close" onClick={onClose} aria-label="닫기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {hasTabs && (
          <div className="settings-dialog-tabs">
            {tabs!.map(tab => (
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
```

- [ ] **Step 2: Write the CSS**

Copy the visual rules from `AutoModeSettingsDialog.css` for `.ams-overlay`, `.ams-dialog`, `.ams-header`, `.ams-close`, `.ams-tabs`, `.ams-tab`, `.ams-content`, `.ams-footer` and re-prefix to `.settings-dialog-*` / `.settings-tab`. Do not introduce new visual design — pixel-match the AutoMode version (it is the more polished of the two).

```css
/* SettingsDialogFrame.css — shared chrome for settings dialogs.
 * Visual rules pulled from the AutoMode settings dialog so all settings
 * dialogs match. Per-dialog body content keeps its own *-section / *-input
 * styles for now. */

.settings-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.settings-dialog-overlay.visible { opacity: 1; }

.settings-dialog {
  width: min(720px, 92vw);
  max-height: 88vh;
  background: var(--bg-elevated, #161616);
  border: 1px solid var(--color-border, #2a2a2a);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: scale(0.92);
  opacity: 0;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}
.settings-dialog.visible { transform: scale(1); opacity: 1; }

.settings-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid var(--color-border, #2a2a2a);
}
.settings-dialog-header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary, #e8e8e8);
}
.settings-dialog-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary, #9c9c9c);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.settings-dialog-close:hover {
  background: var(--bg-hover, #1f1f1f);
  color: var(--text-primary, #e8e8e8);
  border-color: var(--color-border, #2a2a2a);
}

.settings-dialog-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border, #2a2a2a);
  background: var(--bg-surface, #141414);
}
.settings-tab {
  flex: 1;
  padding: 13px 16px;
  background: transparent;
  border: none;
  color: var(--text-secondary, #9c9c9c);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.settings-tab:hover { color: var(--text-primary, #e8e8e8); background: var(--bg-hover, #1f1f1f); }
.settings-tab.active {
  color: var(--accent-primary, #3182f6);
  border-bottom-color: var(--accent-primary, #3182f6);
}

.settings-dialog-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.settings-dialog-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--color-border, #2a2a2a);
  background: var(--bg-surface, #141414);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
```

- [ ] **Step 3: Run test and verify it passes**

Run: `npm test -- run SettingsDialogFrame`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/common/SettingsDialogFrame.tsx \
        src/presentation/components/common/SettingsDialogFrame.css \
        src/presentation/components/common/SettingsDialogFrame.test.tsx
git commit -m "feat(settings): add shared SettingsDialogFrame primitive"
```

## Task 1.3: Migrate `AutoModeSettingsDialog` to use SettingsDialogFrame

The existing `AutoModeSettingsDialog.thresholds.test.tsx` is a smoke test that the migration must not break.

**Files:**
- Modify: `src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx` — replace the overlay/dialog/header/tabs/footer JSX with `<SettingsDialogFrame>`. Keep all body content (sections inside `{activeTab === 'general' && ...}`, `{activeTab === 'strategy' && ...}`, `{activeTab === 'safety' && ...}`) exactly as-is.
- Modify: `src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.css` — delete the now-unused selectors: `.ams-overlay`, `.ams-dialog`, `.ams-header`, `.ams-close`, `.ams-tabs`, `.ams-tab`, `.ams-content`, `.ams-footer`, and their `.visible` / `.active` / hover variants. **Keep** everything else (`.ams-section`, `.ams-input-wrap`, `.ams-stat-card`, etc.).

- [ ] **Step 1: Run the existing tests baseline (must pass)**

Run: `npm test -- run AutoModeSettingsDialog.thresholds`
Expected: PASS — capture the pass count so we know the baseline.

- [ ] **Step 2: Edit `AutoModeSettingsDialog.tsx`**

Replace the entire `return (...)` body (currently lines 165–656). The new structure:

```tsx
import { SettingsDialogFrame, type SettingsTabDef } from '../../common/SettingsDialogFrame'
// ... keep other imports ...

const TABS: SettingsTabDef<SettingsTab>[] = [
  { value: 'general', label: '일반' },
  { value: 'strategy', label: '배팅 전략' },
  { value: 'safety', label: '안전 장치' },
]

// inside the component:
return (
  <SettingsDialogFrame
    isOpen={isOpen}
    onClose={onClose}
    title="오토 배팅 설정"
    tabs={TABS}
    activeTab={activeTab}
    onTabChange={setActiveTab}
    footer={
      <button className="ams-btn-primary" onClick={onClose}>확인</button>
    }
  >
    {activeTab === 'general' && (
      <>
        {/* paste the existing general-tab JSX here, lines 206–379 */}
      </>
    )}
    {activeTab === 'strategy' && (
      <>
        {/* paste the existing strategy-tab JSX here, lines 386–539 */}
      </>
    )}
    {activeTab === 'safety' && (
      <>
        {/* paste the existing safety-tab JSX here, lines 547–643 */}
      </>
    )}
  </SettingsDialogFrame>
)
```

Also remove these now-dead pieces from the component:
- `const [animateIn, setAnimateIn] = useState(false)` (the frame owns this now)
- The `useEffect(() => { if (isOpen) { setAnimateIn(true); ... } else { setAnimateIn(false) } ...` — keep the body of the `if (isOpen)` branch that re-syncs `virtualBalance` and `thresholds`, but drop the `setAnimateIn` calls
- The `handleOverlayClick` function
- The early `if (!isOpen) return null` (frame handles it)

- [ ] **Step 3: Edit `AutoModeSettingsDialog.css`**

Delete only these selectors and their related rules (leave everything else alone):
- `.ams-overlay`, `.ams-overlay.visible`
- `.ams-dialog`, `.ams-dialog.visible`
- `.ams-header`, `.ams-header h2`
- `.ams-close`, `.ams-close:hover`
- `.ams-tabs`, `.ams-tab`, `.ams-tab:hover`, `.ams-tab.active`
- `.ams-content`
- `.ams-footer`

- [ ] **Step 4: Run the existing tests and verify they still pass**

Run: `npm test -- run AutoModeSettingsDialog.thresholds`
Expected: PASS (same count as Step 1).

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: clean exit code 0.

- [ ] **Step 6: Manual smoke check**

Run: `npm run dev`
Open the app → header → 오토 설정 아이콘 → verify the three tabs render, switching tabs works, X button closes, overlay click closes, content scrolls, footer "확인" button closes.

- [ ] **Step 7: Commit**

```bash
git add src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx \
        src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.css
git commit -m "refactor(auto-mode): use SettingsDialogFrame for dialog chrome"
```

## Task 1.4: Migrate `SemiAutoSettingsDialog` to use SettingsDialogFrame

Mirror of Task 1.3 for the SemiAuto dialog.

**Files:**
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx`
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.css`

- [ ] **Step 1: Edit `SemiAutoSettingsDialog.tsx`**

Replace the JSX rooted at `<div className={`sa-dialog-overlay ...`}>` (line 129) through its closing `</div>` (line 374) with:

```tsx
import { SettingsDialogFrame, type SettingsTabDef } from '../../common/SettingsDialogFrame'

const TABS: SettingsTabDef<SettingsTab>[] = [
  { value: 'general', label: '일반' },
  { value: 'rooms', label: '방 선택' },
]

return (
  <SettingsDialogFrame
    isOpen={isOpen}
    onClose={onClose}
    title="반자동 설정"
    tabs={TABS}
    activeTab={activeTab}
    onTabChange={setActiveTab}
    footer={
      <button className="sa-btn-primary" onClick={onClose}>설정 완료</button>
    }
  >
    {activeTab === 'general' && (
      <>
        {/* paste the existing general-tab JSX from lines 162–321 */}
      </>
    )}
    {activeTab === 'rooms' && (
      <div className="sa-dialog-section">
        {/* paste the existing rooms-tab JSX from lines 328–364 */}
      </div>
    )}
  </SettingsDialogFrame>
)
```

Remove the now-dead `animateIn` state, the `useEffect` that sets it, `handleOverlayClick`, and the `if (!isOpen) return null` line.

- [ ] **Step 2: Edit `SemiAutoSettingsDialog.css`**

Delete:
- `.sa-dialog-overlay`, `.sa-dialog-overlay.visible`
- `.sa-dialog`, `.sa-dialog.visible`
- `.sa-dialog-header`, `.sa-dialog-header h2`
- `.sa-dialog-close`, `.sa-dialog-close:hover`
- `.sa-dialog-tabs`, `.sa-tab`, `.sa-tab:hover`, `.sa-tab.active`
- `.sa-dialog-content`
- `.sa-dialog-footer`

Keep all section-level (`.sa-dialog-section`, `.sa-stat-box`, etc.) selectors.

- [ ] **Step 3: Run tests**

Run: `npm test -- run SemiAuto`
Expected: existing tests still pass.

- [ ] **Step 4: Type-check + manual smoke**

Run: `npm run typecheck` → clean.
Open the SemiAuto panel settings dialog → both tabs work, room list renders.

- [ ] **Step 5: Commit**

```bash
git add src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx \
        src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.css
git commit -m "refactor(semi-auto): use SettingsDialogFrame for dialog chrome"
```

---

# Phase 2 — Shared `FreshShoeToggle`

Both dialogs render an identical Fresh-Shoe Tie 마틴 preset card with inline `style={{...}}` (AutoMode lines 387–405, SemiAuto lines 162–184). The only meaningful difference is the `scope` argument passed to the preset (`'auto'` vs `'semiauto'`) and the SemiAuto warning footer.

## Task 2.1: Write failing test for FreshShoeToggle

**Files:**
- Create: `src/presentation/components/common/FreshShoeToggle.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FreshShoeToggle } from './FreshShoeToggle'

// Mock the DI container to provide a controllable preset
const isEnabled = vi.fn()
const enable = vi.fn()
const disable = vi.fn()
const getDescription = vi.fn(() => '슈가 막 시작된 방에서만 Tie 마틴 베팅.')

vi.mock('../../../application/di/setupContainer', () => ({
  getFreshShoePreset: () => ({ isEnabled, enable, disable, getDescription }),
}))

describe('FreshShoeToggle', () => {
  beforeEach(() => {
    isEnabled.mockReset()
    enable.mockReset()
    disable.mockReset()
    getDescription.mockClear()
    getDescription.mockReturnValue('슈가 막 시작된 방에서만 Tie 마틴 베팅.')
  })

  it('renders the label and description from the preset', () => {
    isEnabled.mockReturnValue(false)
    render(<FreshShoeToggle scope="auto" />)
    expect(screen.getByText('Fresh-Shoe Tie 마틴')).toBeInTheDocument()
    expect(screen.getByText(/슈가 막 시작된 방에서만/)).toBeInTheDocument()
  })

  it('reflects the initial enabled state for the given scope', () => {
    isEnabled.mockImplementation((scope: string) => scope === 'auto')
    render(<FreshShoeToggle scope="auto" />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(isEnabled).toHaveBeenCalledWith('auto')
  })

  it('calls preset.enable(scope) when toggled on', () => {
    isEnabled.mockReturnValue(false)
    render(<FreshShoeToggle scope="semiauto" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(enable).toHaveBeenCalledWith('semiauto')
  })

  it('calls preset.disable(scope) when toggled off', () => {
    isEnabled.mockImplementation((scope: string) => scope === 'auto')
    render(<FreshShoeToggle scope="auto" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(disable).toHaveBeenCalledWith('auto')
  })

  it('renders the warning slot when provided', () => {
    isEnabled.mockReturnValue(false)
    render(
      <FreshShoeToggle scope="semiauto" warning="⚠ 후속 패치에서 지원" />
    )
    expect(screen.getByText(/후속 패치에서 지원/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test -- run FreshShoeToggle`
Expected: FAIL — `Cannot find module './FreshShoeToggle'`

## Task 2.2: Implement FreshShoeToggle

**Files:**
- Create: `src/presentation/components/common/FreshShoeToggle.tsx`

- [ ] **Step 1: Write the component**

```tsx
// FreshShoeToggle — Fresh-Shoe Tie 마틴 preset card.
// Single source for the toggle previously duplicated in AutoModeSettingsDialog
// and SemiAutoSettingsDialog. Reads/writes the preset via the DI container.

import { useState, type ReactNode } from 'react'
import { getFreshShoePreset } from '../../../application/di/setupContainer'

export type FreshShoeScope = 'auto' | 'semiauto'

interface FreshShoeToggleProps {
  scope: FreshShoeScope
  warning?: ReactNode
}

export function FreshShoeToggle({ scope, warning }: FreshShoeToggleProps) {
  const preset = getFreshShoePreset()
  const [on, setOn] = useState(() => (preset ? preset.isEnabled(scope) : false))

  if (!preset) return null

  const handleChange = (next: boolean) => {
    if (next) preset.enable(scope)
    else preset.disable(scope)
    setOn(preset.isEnabled(scope))
  }

  return (
    <div
      style={{
        border: '1px solid var(--color-border, #444)',
        borderRadius: 8,
        padding: 12,
        margin: '12px 0',
        background: 'var(--color-surface-2, #1c1c1c)',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => handleChange(e.target.checked)}
        />
        Fresh-Shoe Tie 마틴
      </label>
      <div style={{ fontSize: 12, color: 'var(--color-text-dim, #999)', marginTop: 6, lineHeight: 1.5 }}>
        {preset.getDescription()}
        {warning && (
          <>
            {' '}
            <strong style={{ color: 'var(--color-warn, #d97706)' }}>{warning}</strong>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run test and verify it passes**

Run: `npm test -- run FreshShoeToggle`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/common/FreshShoeToggle.tsx \
        src/presentation/components/common/FreshShoeToggle.test.tsx
git commit -m "feat(settings): extract FreshShoeToggle shared component"
```

## Task 2.3: Use FreshShoeToggle in AutoMode and SemiAuto dialogs

**Files:**
- Modify: `src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx`
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx`

- [ ] **Step 1: Edit `AutoModeSettingsDialog.tsx`**

Replace the inline-styled `<div style={{ border: '1px solid var(--color-border...' }}>...</div>` block in the 배팅 전략 tab (currently lines 387–405) with:

```tsx
<FreshShoeToggle scope="auto" />
```

Add import at top: `import { FreshShoeToggle } from '../../common/FreshShoeToggle'`.

Remove the now-unused `freshShoeOn` state, `handleFreshShoeToggle`, and the `getFreshShoePreset` import (only if no other usage remains — check first).

- [ ] **Step 2: Edit `SemiAutoSettingsDialog.tsx`**

Replace the corresponding inline block (currently lines 162–184) with:

```tsx
<FreshShoeToggle
  scope="semiauto"
  warning="⚠ 반자동 모드의 Tie 베팅 강제는 후속 패치에서 지원. 현재 토글은 fresh_shoe 필터와 이동 트리거만 활성화."
/>
```

Add import. Remove the local `freshShoeOn` state, `handleFreshShoeToggle`, and the `getFreshShoePreset` import (only if no other usage remains).

- [ ] **Step 3: Type-check + test**

Run: `npm run typecheck` → clean.
Run: `npm test -- run AutoModeSettingsDialog SemiAuto` → all pass.

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx \
        src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx
git commit -m "refactor(settings): use shared FreshShoeToggle in both dialogs"
```

---

# Phase 3 — Shared `NumberFieldWithSuffix`

The `<label><span>...</span><div class="ams-input-wrap"><input type="number"/><span class="ams-input-suffix">원</span></div></label>` pattern appears 12+ times across `AutoModeSettingsDialog.tsx` (가상 잔액, 필터 임계값×3, 기본 배팅금, 최대 단계, 단계별 커스텀×N, 최대 동시 배팅 수, 윈컷, 로스컷, 연패 기준, 휴식 시간) and 2× in `SemiAutoSettingsDialog.tsx` (연승 이동, 연패 이동).

The duplicated CSS (`.ams-input-wrap` + `.ams-input-suffix` vs `.sa-input-wrapper` + `.sa-input-suffix`) has the same visual output.

## Task 3.1: Write failing test for NumberFieldWithSuffix

**Files:**
- Create: `src/presentation/components/common/NumberFieldWithSuffix.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumberFieldWithSuffix } from './NumberFieldWithSuffix'

describe('NumberFieldWithSuffix', () => {
  it('renders the label, current value, and suffix', () => {
    render(
      <NumberFieldWithSuffix
        label="기본 배팅금"
        value={10000}
        suffix="원"
        onChange={() => {}}
      />
    )
    expect(screen.getByText('기본 배팅금')).toBeInTheDocument()
    expect(screen.getByLabelText('기본 배팅금')).toHaveValue(10000)
    expect(screen.getByText('원')).toBeInTheDocument()
  })

  it('calls onChange with a number when the input changes', () => {
    const onChange = vi.fn()
    render(
      <NumberFieldWithSuffix
        label="기본 배팅금"
        value={10000}
        suffix="원"
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('기본 배팅금'), { target: { value: '25000' } })
    expect(onChange).toHaveBeenCalledWith(25000)
  })

  it('forwards min, max, and step to the underlying input', () => {
    render(
      <NumberFieldWithSuffix
        label="최대 단계"
        value={5}
        suffix="단계"
        min={1}
        max={100}
        step={1}
        onChange={() => {}}
      />
    )
    const input = screen.getByLabelText('최대 단계') as HTMLInputElement
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '100')
    expect(input).toHaveAttribute('step', '1')
  })

  it('does not invoke onChange when the input parses to NaN', () => {
    const onChange = vi.fn()
    render(
      <NumberFieldWithSuffix
        label="L"
        value={5}
        suffix="단계"
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('L'), { target: { value: 'abc' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npm test -- run NumberFieldWithSuffix`
Expected: FAIL — module not found.

## Task 3.2: Implement NumberFieldWithSuffix

**Files:**
- Create: `src/presentation/components/common/NumberFieldWithSuffix.tsx`

- [ ] **Step 1: Write the component**

```tsx
// NumberFieldWithSuffix — labeled numeric input with a trailing unit suffix.
// Replaces the .ams-input-wrap / .sa-input-wrapper pattern across both
// settings dialogs.

interface NumberFieldWithSuffixProps {
  label: string
  value: number
  suffix: string
  min?: number
  max?: number
  step?: number
  onChange: (next: number) => void
}

export function NumberFieldWithSuffix({
  label,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
}: NumberFieldWithSuffixProps) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <span className="settings-field__input-wrap">
        <input
          className="settings-field__input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (!Number.isFinite(n)) return
            onChange(n)
          }}
        />
        <span className="settings-field__suffix">{suffix}</span>
      </span>
    </label>
  )
}
```

- [ ] **Step 2: Add CSS rules to `SettingsDialogFrame.css`** (or a new sibling `SettingsFields.css` if you prefer — but adding to the existing frame stylesheet avoids another import)

Append to `SettingsDialogFrame.css`:

```css
/* Shared field primitive (NumberFieldWithSuffix) */
.settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.settings-field__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #9c9c9c);
}
.settings-field__input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.settings-field__input {
  width: 100%;
  padding: 9px 38px 9px 12px;
  background: var(--bg-surface, #141414);
  border: 1px solid var(--color-border, #2a2a2a);
  border-radius: 8px;
  color: var(--text-primary, #e8e8e8);
  font-size: 13px;
  font-family: var(--font-mono, monospace);
}
.settings-field__input:focus {
  outline: none;
  border-color: var(--accent-primary, #3182f6);
}
.settings-field__suffix {
  position: absolute;
  right: 10px;
  font-size: 12px;
  color: var(--text-muted, #6c6c6c);
  pointer-events: none;
}
```

- [ ] **Step 3: Run and verify PASS**

Run: `npm test -- run NumberFieldWithSuffix`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/common/NumberFieldWithSuffix.tsx \
        src/presentation/components/common/NumberFieldWithSuffix.test.tsx \
        src/presentation/components/common/SettingsDialogFrame.css
git commit -m "feat(settings): add NumberFieldWithSuffix shared input primitive"
```

## Task 3.3: Migrate AutoMode dialog inputs to NumberFieldWithSuffix

**Files:**
- Modify: `src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx`

Migrate **in this order**, one section per commit so a regression points at a small diff:

- [ ] **Step 1: Filter thresholds section** (lines 270–320 in the original)

Replace each `<label className="ams-input-group">...</label>` block with:

```tsx
<NumberFieldWithSuffix
  label="Tie 미발생 (가뭄)"
  value={thresholds.tieDroughtThreshold}
  suffix="게임"
  min={1}
  max={200}
  onChange={(n) => handleThresholdChange('tieDroughtThreshold', String(n))}
/>
<NumberFieldWithSuffix
  label="신규 방 기준"
  value={thresholds.freshRoomGames}
  suffix="게임"
  min={1}
  max={200}
  onChange={(n) => handleThresholdChange('freshRoomGames', String(n))}
/>
<NumberFieldWithSuffix
  label="Fresh Shoe 기준"
  value={thresholds.freshShoeMaxGameNumber}
  suffix="게임"
  min={1}
  max={200}
  onChange={(n) => handleThresholdChange('freshShoeMaxGameNumber', String(n))}
/>
```

Then run `npm test -- run AutoModeSettingsDialog.thresholds` — must pass. The existing test uses `screen.getByLabelText('Tie 미발생 (가뭄)')` which matches the new `aria-label` attribute set by `NumberFieldWithSuffix`.

Commit: `refactor(auto-mode): migrate filter threshold inputs to shared field`.

- [ ] **Step 2: Betting amount section** (lines 434–478)

Replace 기본 배팅금 and 최대 단계 fields. Use the same per-field props with `min`, `max`, `step` as the originals (`min=1000, step=1000` for 기본 배팅금; `min=1, max=100` for 최대 단계). The 최대 단계 handler stays the same — its onChange has the customBetAmounts resize logic.

Commit: `refactor(auto-mode): migrate betting amount inputs to shared field`.

- [ ] **Step 3: 안전 장치 tab inputs** (윈컷, 로스컷, 연패 기준, 휴식 시간)

Replace each. Preserve all `min`/`max`/`step` attrs.

Commit: `refactor(auto-mode): migrate safety inputs to shared field`.

- [ ] **Step 4: 동시 배팅 제한 input**

Replace. Commit: `refactor(auto-mode): migrate concurrent bets input to shared field`.

- [ ] **Step 5: 가상 잔액 input and 단계별 커스텀 입력 (preview rows)**

The custom-step inputs are the trickiest because they live inside a map. Preserve the loop:

```tsx
{betPreview.map((amount, i) => (
  <div key={i} className="ams-preview-step">
    <span className="ams-preview-level">{i + 1}단계</span>
    {settings.betStrategy === 'custom' ? (
      <NumberFieldWithSuffix
        label={`${i + 1}단계 금액`}
        value={settings.customBetAmounts?.[i] ?? (settings.baseBetAmount || 10000)}
        suffix="원"
        min={1000}
        step={1000}
        onChange={(n) => {
          const baseAmount = settings.baseBetAmount || 10000
          const maxLevel = settings.maxMartin || 5
          const newAmounts = [...(settings.customBetAmounts || Array(maxLevel).fill(baseAmount))]
          newAmounts[i] = n
          onUpdateSettings({ customBetAmounts: newAmounts })
        }}
      />
    ) : (
      <span className="ams-preview-amount">{amount.toLocaleString()}원</span>
    )}
  </div>
))}
```

The preview-input layout may need a tweak — verify the visual matches. If not, gate the `settings-field` label visibility with a `compact` prop:

```tsx
// optional addition to NumberFieldWithSuffix
hideLabel?: boolean
```

…and render the label with `sr-only` styling when `hideLabel`. Decide based on the visual diff. If you add `hideLabel`, also add a test:

```tsx
it('keeps an accessible aria-label even when the visible label is hidden', () => {
  render(
    <NumberFieldWithSuffix label="단계 금액" value={10000} suffix="원" hideLabel onChange={() => {}} />
  )
  expect(screen.getByLabelText('단계 금액')).toBeInTheDocument()
  // visible <span> with that text should not be present, or should have sr-only
})
```

Commit: `refactor(auto-mode): migrate custom-step and virtual-balance inputs to shared field`.

- [ ] **Step 6: Type-check + manual smoke**

Run: `npm run typecheck` → clean.
Open the AutoMode settings dialog, check every input on every tab. Edit each and verify the value flows through.

## Task 3.4: Migrate SemiAuto dialog inputs to NumberFieldWithSuffix

**Files:**
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx`

- [ ] **Step 1: Replace 연승 이동 and 연패 이동 inputs (lines 217–246)**

```tsx
<NumberFieldWithSuffix
  label="연승 이동"
  value={settings.winThreshold ?? 0}
  suffix="승"
  min={0}
  max={20}
  onChange={(n) => onUpdateSettings({ winThreshold: n })}
/>
<NumberFieldWithSuffix
  label="연패 이동"
  value={settings.lossThreshold ?? 0}
  suffix="연패"
  min={0}
  max={20}
  onChange={(n) => onUpdateSettings({ lossThreshold: n })}
/>
```

- [ ] **Step 2: Run tests + typecheck + smoke**

Run: `npm test -- run SemiAuto`; `npm run typecheck`; open the panel and verify both inputs work.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx
git commit -m "refactor(semi-auto): migrate move-threshold inputs to shared field"
```

---

# Phase 4 — Shared `StatCard`

`AutoModeSettingsDialog.tsx:323–355` renders 4 stat tiles with `.ams-stat-card`. `SemiAutoSettingsDialog.tsx:298–311` renders 3 with `.sa-stat-box`. Same pattern, slightly different styling — consolidate.

## Task 4.1: Write failing test for StatCard

**Files:**
- Create: `src/presentation/components/common/StatCard.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatCard } from './StatCard'

describe('StatCard', () => {
  it('renders the label and value', () => {
    render(<StatCard label="승률" value="73%" />)
    expect(screen.getByText('승률')).toBeInTheDocument()
    expect(screen.getByText('73%')).toBeInTheDocument()
  })

  it('renders a ReactNode value', () => {
    render(<StatCard label="승/패" value={<><span className="positive">10</span>/<span className="negative">3</span></>} />)
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('applies the tone class when provided', () => {
    const { container } = render(<StatCard label="손익" value="+50,000" tone="positive" />)
    expect(container.querySelector('.settings-stat-card.positive')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npm test -- run StatCard`. Expected: FAIL.

## Task 4.2: Implement StatCard

**Files:**
- Create: `src/presentation/components/common/StatCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
import type { ReactNode } from 'react'

type Tone = 'neutral' | 'positive' | 'negative'

interface StatCardProps {
  label: string
  value: ReactNode
  tone?: Tone
}

export function StatCard({ label, value, tone = 'neutral' }: StatCardProps) {
  return (
    <div className={`settings-stat-card ${tone}`}>
      <span className="settings-stat-card__label">{label}</span>
      <span className="settings-stat-card__value">{value}</span>
    </div>
  )
}
```

- [ ] **Step 2: Add CSS to `SettingsDialogFrame.css`**

```css
.settings-stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--bg-surface, #141414);
  border: 1px solid var(--color-border, #2a2a2a);
  border-radius: 8px;
}
.settings-stat-card__label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary, #9c9c9c);
}
.settings-stat-card__value {
  font-size: 18px;
  font-family: var(--font-mono, monospace);
  color: var(--text-primary, #e8e8e8);
}
.settings-stat-card.positive .settings-stat-card__value { color: var(--status-success, #4ade80); }
.settings-stat-card.negative .settings-stat-card__value { color: var(--status-danger, #f87171); }
```

- [ ] **Step 3: Verify PASS**

Run: `npm test -- run StatCard`. Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/common/StatCard.tsx \
        src/presentation/components/common/StatCard.test.tsx \
        src/presentation/components/common/SettingsDialogFrame.css
git commit -m "feat(settings): add StatCard shared primitive"
```

## Task 4.3: Use StatCard in AutoMode dialog

**Files:**
- Modify: `src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx`

- [ ] **Step 1: Replace the four `.ams-stat-card` blocks** (lines 325–354)

```tsx
<div className="settings-stat-grid">
  <StatCard
    label={settings.isVirtualMode ? '가상 잔액' : '잔액'}
    value={settings.isVirtualMode
      ? currentVirtualBalance.toLocaleString()
      : realBalance !== null ? realBalance.toLocaleString() : '-'}
  />
  <StatCard
    label="승률"
    value={`${winRate}%`}
    tone={winRate >= 50 ? 'positive' : winRate > 0 ? 'negative' : 'neutral'}
  />
  <StatCard
    label="승/패"
    value={<>
      <span style={{ color: 'var(--status-success)' }}>{totalWins}</span>
      <span style={{ margin: '0 4px', color: 'var(--text-muted)' }}>/</span>
      <span style={{ color: 'var(--status-danger)' }}>{totalLosses}</span>
    </>}
  />
  <StatCard
    label="손익"
    value={`${cumulativeProfit > 0 ? '+' : ''}${cumulativeProfit.toLocaleString()}`}
    tone={cumulativeProfit > 0 ? 'positive' : cumulativeProfit < 0 ? 'negative' : 'neutral'}
  />
</div>
```

Add `.settings-stat-grid` to `SettingsDialogFrame.css`:

```css
.settings-stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
```

- [ ] **Step 2: Delete `.ams-stats-grid`, `.ams-stat-card`, `.ams-stat-label`, `.ams-stat-value`, `.ams-stat-value.positive`, `.ams-stat-value.negative`, `.ams-stat-divider` from `AutoModeSettingsDialog.css`**

- [ ] **Step 3: Typecheck + smoke**

Run: `npm run typecheck` → clean.
Open the AutoMode settings → 일반 tab → stat grid renders 4 cards correctly with colors.

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.tsx \
        src/presentation/components/AutoModePanel/components/AutoModeSettingsDialog.css \
        src/presentation/components/common/SettingsDialogFrame.css
git commit -m "refactor(auto-mode): use StatCard for stats grid"
```

## Task 4.4: Use StatCard in SemiAuto dialog

**Files:**
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx`

- [ ] **Step 1: Replace the `.sa-stats-summary` block** (lines 298–311)

```tsx
<div className="settings-stat-grid">
  <StatCard label="총 예측" value={totalWins + totalLosses} />
  <StatCard label="적중" value={totalWins} tone="positive" />
  <StatCard label="실패" value={totalLosses} tone="negative" />
</div>
```

- [ ] **Step 2: Delete `.sa-stats-summary`, `.sa-stat-box`, `.sa-stat-box .label`, `.sa-stat-box .value`, `.sa-stat-box.success`, `.sa-stat-box.danger` from `SemiAutoSettingsDialog.css`**

- [ ] **Step 3: Typecheck + smoke + commit**

Run: `npm run typecheck`. Verify visually. Commit: `refactor(semi-auto): use StatCard for stats summary`.

---

# Phase 5 — Consolidate filter threshold UIs

Three implementations exist:
1. `AutoModeSettingsDialog` 필터 임계값 섹션 (already inside the dialog body)
2. `FilterThresholdInputs.tsx` — drop-in 3-row form used in a filter dropdown
3. `FilterThresholdInline.tsx` — per-row single input used inside each individual filter dropdown item

After Phase 3, (1) already uses `NumberFieldWithSuffix`. The plan is to **delete `FilterThresholdInputs`** because `FilterThresholdInline` already renders the per-filter threshold next to each filter row, and the standalone 3-row form is redundant with the AutoMode settings section.

## Task 5.1: Audit FilterThresholdInputs usage

- [ ] **Step 1: Find all importers**

Run via Grep:

```
pattern: "FilterThresholdInputs"
type:    tsx
```

Capture the list of files. Expected: it's likely imported in 1–2 filter dropdown components.

- [ ] **Step 2: Decide per importer**

For each importer:
- If the importer is a filter dropdown that already has individual `FilterThresholdInline` rows next to each filter → just delete the `FilterThresholdInputs` import and its `<FilterThresholdInputs />` JSX. The per-row inline edits cover it.
- If the importer is somewhere else (e.g., a settings entrypoint with no per-row alternative) → leave it alone and skip the delete; close the task with a note.

- [ ] **Step 3: Document the audit result**

Add a brief checklist in the PR description listing each importer and the action taken.

## Task 5.2: Remove the consumer usage

**Files (TBD by audit; example):**
- Modify: each file from Task 5.1 that imports `FilterThresholdInputs`

- [ ] **Step 1: Remove the `<FilterThresholdInputs />` JSX and its import.**

- [ ] **Step 2: Smoke test the affected filter dropdown — verify per-row inline inputs are still present and editable.**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(filters): drop standalone FilterThresholdInputs in favor of inline per-row inputs"
```

## Task 5.3: Delete the FilterThresholdInputs component

**Files:**
- Delete: `src/presentation/components/AutoModePanel/components/FilterThresholdInputs.tsx`
- Delete: `src/presentation/components/AutoModePanel/components/FilterThresholdInputs.css`

- [ ] **Step 1: Verify no remaining importers**

Grep `FilterThresholdInputs` — must return zero matches.

- [ ] **Step 2: Delete the files**

```bash
git rm src/presentation/components/AutoModePanel/components/FilterThresholdInputs.tsx \
       src/presentation/components/AutoModePanel/components/FilterThresholdInputs.css
```

- [ ] **Step 3: Typecheck + test suite**

Run: `npm run typecheck` → clean.
Run: `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(filters): delete unused FilterThresholdInputs component"
```

---

# Phase 6 — Clean up legacy CSS prefixes (optional, low priority)

After phases 1–5, the only `ams-*` / `sa-*` selectors that should remain are body-section styles (`.ams-section`, `.ams-section-title`, `.ams-strategy-grid`, `.ams-mode-toggle`, `.ams-warning`, `.ams-hint`, `.ams-preview*`, `.ams-toggle-row`, `.ams-data-actions`, `.ams-btn-*`, and the SemiAuto equivalents). These are not duplicated *across* dialogs — they are dialog-specific.

If you want to push further:

## Task 6.1: Audit dead CSS

- [ ] **Step 1: For each remaining `.ams-*` and `.sa-*` selector, grep the `.tsx` files**

```
pattern: "ams-section\b"
type: tsx
```

…and so on. Selectors with zero hits → delete.

- [ ] **Step 2: Commit per dialog**

```
chore(auto-mode): remove dead CSS selectors from AutoModeSettingsDialog.css
chore(semi-auto): remove dead CSS selectors from SemiAutoSettingsDialog.css
```

## Task 6.2: SemiAuto's data-tab betting-strategy CSS

`SemiAutoSettingsDialog.css` contains `.sa-strategy-grid` and `.sa-strategy-btn` rules but the `SemiAutoSettingsDialog.tsx` JSX never renders them — this is dead CSS pointing at a never-implemented betting-strategy selector in SemiAuto mode.

Decision required from the user, not the implementer:

- [ ] **Step 1: Ask the user**: 반자동 모드에 배팅 전략 선택을 실제로 구현할 계획이 있나요? (1) 곧 구현 — CSS는 유지 (2) 계획 없음 — CSS 삭제. Document the answer in the PR description.

- [ ] **Step 2: Apply the decision** — delete the `.sa-strategy-*` rules or leave them with a `/* TODO: see TASK_ID */` comment.

---

# Out of Scope

The following were considered and **explicitly excluded** from this plan:

1. **PatternManagerModal** — it shares the underlying `Modal.css` primitives (`.modal`, `.modal-header`, etc.) but its body uses domain-specific pattern editor widgets (`.pattern-form__grid`, `.pattern-field`, `.pattern-list`, `.pattern-chip`). Folding it into `SettingsDialogFrame` would require reconciling two different modal stylings (`.modal` vs `.settings-dialog`). Defer until product UX confirms they should look identical.
2. **Unified state shape between AutoMode and SemiAuto** — the two services genuinely diverge (Auto has martingale strategy + safety limits; SemiAuto has room-move thresholds + auto-room-find). A shared state shape would create a god-type. Keep them separate.
3. **PredictModePanel settings** — the original analysis flagged it as a possible third settings UI, but inspection showed it does not have a settings dialog of its own that overlaps with AutoMode/SemiAuto. If a `PredictModeSettingsDialog` is later added, it should be built on top of `SettingsDialogFrame` from day one.
4. **Visual redesign** — this plan is structural. The visual end-state matches the current AutoMode dialog. A separate brainstorming + design pass would precede any visual changes.

---

# Spec Coverage Self-Review

| Spec item from analysis | Task that covers it |
| --- | --- |
| Fresh-Shoe toggle duplication (AutoMode ↔ SemiAuto) | Phase 2 (Tasks 2.1–2.3) |
| Filter threshold UI: 3 implementations | Phase 5 (Tasks 5.1–5.3) — `FilterThresholdInputs` deleted, `FilterThresholdInline` kept, AutoMode section uses shared `NumberFieldWithSuffix` |
| Modal frame 99% duplication | Phase 1 (Tasks 1.1–1.4) |
| Stat card styling drift (4-card vs 3-box) | Phase 4 (Tasks 4.1–4.4) |
| Input + suffix pattern repeated 14+ times | Phase 3 (Tasks 3.1–3.4) |
| CSS prefix `ams-*` / `sa-*` overlap | Phases 1–4 delete the overlapping selectors as part of each migration; Phase 6 catches leftover dead rules |
| SemiAuto data-tab strategy CSS (dead) | Task 6.2 |
| UX inconsistencies (tab placement, label wording, etc.) | Out of scope for this structural plan — flagged in the analysis report for a separate UX pass |

---

# Execution Tips

- **Order matters across phases but not within a phase.** Phase 1 must land before Phases 2–4 touch the same dialogs (they reference the frame). Within Phase 3, the 6 sub-migrations (Task 3.3 Steps 1–5 + Task 3.4) can each be its own commit.
- **One commit per task** keeps reverts cheap. If a smoke test fails after Step 6 of Task 3.3, revert just that commit.
- **Korean copy is load-bearing.** The existing tests assert exact label strings (`'Tie 미발생 (가뭄)'`). Do not normalize spacing or punctuation.
- **CSS variables, not hex codes.** Every new rule must use the `var(--*)` tokens shown above. The fallback values in this plan match the current theme.
- **Do not edit Modal.css.** It is shared with `PatternManagerModal` — out of scope.
