// 카드·칩 표시 유틸(순수 함수). Evolution 카드 코드는 '랭크+무늬'(AS, KD, 10H/TH, 2C).

export type Suit = 'S' | 'H' | 'D' | 'C'
export interface ParsedCard {
  rank: string
  suit: Suit
  symbol: string
  red: boolean
}

const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' }

/** 'AS' → {rank:'A', suit:'S'}, 'TH'/'10H' → rank '10'. 못 읽으면 null. */
export function parseCard(code: unknown): ParsedCard | null {
  if (typeof code !== 'string' || code.length < 2) return null
  const c = code.trim().toUpperCase()
  const suit = c[c.length - 1] as Suit
  if (!(suit in SUIT_SYMBOL)) return null
  let rank = c.slice(0, -1)
  if (rank === 'T') rank = '10'
  if (!/^(A|K|Q|J|10|[2-9])$/.test(rank)) return null
  return { rank, suit, symbol: SUIT_SYMBOL[suit], red: suit === 'H' || suit === 'D' }
}

export type ChipTone = 'blue' | 'red' | 'green' | 'black' | 'gold'

/** 카지노 칩 액면 색: 1천대 파랑 · 5천대 빨강 · 1만대 초록 · 5만대 검정 · 10만 이상 금 */
export function chipTone(amount: number): ChipTone {
  if (amount >= 100_000) return 'gold'
  if (amount >= 50_000) return 'black'
  if (amount >= 10_000) return 'green'
  if (amount >= 5_000) return 'red'
  return 'blue'
}

/** 칩 위에 쓰는 짧은 액면: 1천 · 5천 · 1만 · 1.5만 · 10만 · 100만 */
export function chipLabel(amount: number): string {
  if (amount >= 10_000) {
    const v = amount / 10_000
    return `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}만`
  }
  if (amount >= 1_000) {
    const v = amount / 1_000
    return `${Number(v.toFixed(1))}천`
  }
  return `${amount}`
}
