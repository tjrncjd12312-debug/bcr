import { describe, expect, it } from 'vitest'
import { parseCard, chipTone, chipLabel } from './cards'

describe('parseCard', () => {
  it('parses rank and suit codes', () => {
    expect(parseCard('AS')).toMatchObject({ rank: 'A', suit: 'S', symbol: '♠', red: false })
    expect(parseCard('KD')).toMatchObject({ rank: 'K', suit: 'D', symbol: '♦', red: true })
    expect(parseCard('10H')).toMatchObject({ rank: '10', red: true })
    expect(parseCard('TH')).toMatchObject({ rank: '10', suit: 'H' })
  })
  it('rejects garbage', () => {
    expect(parseCard('')).toBeNull()
    expect(parseCard('ZZ')).toBeNull()
    expect(parseCard(42)).toBeNull()
  })
})

describe('chip helpers', () => {
  it('maps denominations to casino chip colors', () => {
    expect(chipTone(1000)).toBe('blue')
    expect(chipTone(5000)).toBe('red')
    expect(chipTone(20000)).toBe('green')
    expect(chipTone(80000)).toBe('black')
    expect(chipTone(100000)).toBe('gold')
  })
  it('formats short labels', () => {
    expect(chipLabel(1000)).toBe('1천')
    expect(chipLabel(2500)).toBe('2.5천')
    expect(chipLabel(10000)).toBe('1만')
    expect(chipLabel(15000)).toBe('1.5만')
    expect(chipLabel(160000)).toBe('16만')
    expect(chipLabel(500)).toBe('500')
  })
})
