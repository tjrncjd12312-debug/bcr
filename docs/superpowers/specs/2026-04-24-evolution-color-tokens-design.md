# Evolution Art Deco Color Token Redesign

**Date:** 2026-04-24
**Scope:** Frontend color system only (no logic changes, no backend)
**Goal:** Replace the current inconsistent teal/mixed palette with a cohesive Evolution Gaming-inspired "Black + Gold Art Deco" system, consolidate duplicate tokens, and sync hardcoded hex values in component CSS.

## Problem

Current tokens in `src/styles/global.css` (v3.0) are internally inconsistent:
- `--accent-gold` is actually teal (#14B8A6) — name/value mismatch.
- Teal is duplicated across 5+ variables: `--accent-primary`, `--accent-secondary`, `--accent-color`, `--accent-hover`, `--accent-muted`, `--neon-blue`, `--neon-gold`.
- `--status-ready` uses cyan (#00e5ff) which clashes with the teal accent.
- Backgrounds (#080b10 → #243444) are blue-tinted, not the pure black Evolution uses.
- Component CSS files contain many hardcoded hex values (oranges, bright blues, cyans, bronzes) that ignore the token system entirely.

## Target Aesthetic: Evolution Art Deco

Verified against Evolution Gaming's public materials (Lightning Baccarat — "black and gold Art Deco", Salon Privé — gold-heavy luxury, No Commission — purple variant accent).

- Pure black backgrounds (#0a0a0a base, stepped neutrals).
- **Warm gold** (#d4af37 / bright #f4ce49) as the single brand/AI/VIP accent.
- **Evolution red** (#e31a38) shared between brand lockup and Banker result (industry standard).
- **Player blue** (#1e6be0) — deeper, less saturated.
- **Tie green** (#22c55e) — unchanged.
- **Purple** (#8b5cf6) reserved for No Commission variant.
- **Lightning cream** (#fff7c2) for flash/strike moments.
- Art Deco typographic cue: wider letter-spacing and uppercase on brand/section headers.

## Token Map

Variable names stay identical so existing `var(--*)` references keep working. Values change.

### Backgrounds (pure black)
| Token | Old | New |
|---|---|---|
| `--bg-base` | #080b10 | #0a0a0a |
| `--bg-elevated` | #111820 | #141414 |
| `--bg-surface` | #182230 | #1a1a1a |
| `--bg-card` / `--bg-panel` | #1c2a3a | #1e1e1e |
| `--bg-tertiary` | #243444 | #262626 |

### Brand Accent — Gold
| Token | Old | New |
|---|---|---|
| `--accent-primary` | #14B8A6 (teal) | #d4af37 |
| `--accent-secondary` | #5eead4 | #f4ce49 |
| `--accent-gold` | #14B8A6 (mislabeled) | #d4af37 |
| `--accent-gold-muted` | rgba(20,184,166,0.15) | rgba(212,175,55,0.15) |
| `--accent-gold-dim` (new) | — | #8a6d1a |
| `--accent-gold-bright` (new) | — | #f4ce49 |
| `--accent-color` / `--accent-hover` / `--accent-muted` | teal | gold (aliases retained) |
| `--neon-blue` / `--neon-gold` | mixed | remapped to gold (deprecated but live) |

### Game Colors
| Token | Old | New |
|---|---|---|
| `--banker-color` | #ef4444 | #e31a38 |
| `--banker-bg` | rgba(239,68,68,0.15) | rgba(227,26,56,0.14) |
| `--banker-glow` | rgba(239,68,68,0.5) | rgba(227,26,56,0.5) |
| `--banker-light` | #f87171 | #ff5a75 |
| `--player-color` | #3b82f6 | #1e6be0 |
| `--player-bg` | rgba(59,130,246,0.15) | rgba(30,107,224,0.14) |
| `--player-light` | #60a5fa | #5a9bff |
| `--tie-color` | #22c55e | unchanged |

### New / Repurposed
| Token | Value | Purpose |
|---|---|---|
| `--accent-purple` | #8b5cf6 | No Commission variant |
| `--accent-purple-muted` | rgba(139,92,246,0.15) | soft backgrounds |
| `--lightning` | #fff7c2 | flash moments |
| `--shadow-lightning` | `0 0 30px rgba(255,247,194,0.4)` | flash glow |

### Status (aligned to brand palette)
| Token | Old | New |
|---|---|---|
| `--status-success` | #22c55e | unchanged |
| `--status-danger` | #f44336 | #e31a38 |
| `--status-warning` | #ff9800 | #f4ce49 |
| `--status-info` | #29b6f6 | #1e6be0 |
| `--status-ready` | #00e5ff | #d4af37 |
| `--status-idle` | #78909c | #6b6b6b |
| `--status-error` | #ef5350 | #e31a38 |

### Borders & Shadows
Borders shift from white-alpha to subtle gold-alpha (`rgba(212,175,55,0.18)`); glow shadows inherit brand hues.

## Component CSS Sweep

After updating `global.css`, hardcoded hex literals in component CSS files must be replaced:

**Mechanical replacements (direct value swap):**
- `#080b10` → `#0a0a0a`
- `#111820` → `#141414`
- `#182230` → `#1a1a1a`
- `#1c2a3a` → `#1e1e1e`
- `#243444` → `#262626`
- `#14B8A6` / `#14b8a6` → `#d4af37`
- `#5eead4` → `#f4ce49`
- `#0a84ff` → `var(--accent-gold)` (legacy "neon-blue" callsites)
- `#00e5ff` → `var(--accent-gold)`

**Context-specific replacements (judgment call):**
- Ad-hoc oranges (#ff9800 / #ff9f0a / #ea580c) in warnings → `var(--status-warning)` (gold)
- Ad-hoc bronzes (#b87333 / #cd7f32) → `var(--accent-gold-dim)`
- Ad-hoc blues (#007aff / #3b82f6 / #4b7dff) → `var(--player-color)` if baccarat-related, else `var(--accent-gold)` if brand-related
- Ad-hoc cyans (#00bcd4 / #29b6f6 / #5ac8fa / #42a5f5) → `var(--accent-gold)` or `var(--player-color)` by context

**Preserved hexes (intentional, per-component):**
- White (#ffffff), neutrals used for text/icons on dark surfaces.
- Any Chart.js / data visualization palette that needs multi-hue separation — left alone unless blatantly clashing.

## Execution Plan

1. Rewrite `:root` block of `src/styles/global.css` with the new token values (variable names unchanged).
2. Update the dotted background pattern in `body` from teal to gold.
3. Batch-replace mechanical hardcoded hexes across `src/presentation/components/**/*.css` and `src/styles/global.css`.
4. Spot-review component files flagged with context-specific hexes and apply judgment swaps to tokens.
5. Run `npm run build` to confirm no CSS parse errors.
6. Commit as a single change so rollback is a single revert.

## Out of Scope

- TypeScript / React component logic.
- Typography changes beyond header letter-spacing suggestions (not applied in this pass).
- Image assets, icons, sound assets.
- Rust backend.
- Theme switching (light mode) — not required.

## Rollback

Single commit; `git revert <sha>` restores prior palette.

## Success Criteria

- `src/styles/global.css` passes visual scan: every token's value matches its name (no more teal in `--accent-gold`).
- No component CSS file references the deprecated hex values listed in the mechanical replacement table.
- `npm run build` succeeds.
- Live app renders dark Art Deco aesthetic with gold CTA and VIP accents; Banker/Player/Tie colors remain clearly distinguishable.
