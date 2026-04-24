// Presentation Formatters - UI formatting utilities

/**
 * Get Martingale level display text
 */
export function formatMartingaleLevel(level: number): string {
  if (level === 0) return '기본'
  return `${level}마틴`
}

/**
 * Format currency in Korean Won
 */
export function formatCurrency(amount: number): string {
  return amount.toLocaleString('ko-KR') + '원'
}

/**
 * Get CSS class for profit/loss display
 */
export function getProfitClass(amount: number): string {
  if (amount > 0) return 'profit-positive'
  if (amount < 0) return 'profit-negative'
  return 'profit-neutral'
}
