// RecommendStrip — 살펴보기 상단 '추천' 띠 (구 Top3Rankings 4중복을 화면당 1회로 단일화)
// 리디자인 2단계. 방 이름 풀표기(9자 잘림·hover title 폐기), 한글 풀라벨, 아이콘-only 제거.
import { useState } from 'react'
import './RecommendStrip.css'

export interface RecommendItem {
  id: string
  rank: number
  name: string
  /** 적중 횟수 / 시도 횟수 */
  hits: number
  total: number
  /** 보조 한글 라벨(예: '▲ 3연속 좋음') */
  note?: string
}

interface RecommendStripProps {
  items: RecommendItem[]
  onSelect?: (id: string) => void
  defaultOpen?: boolean
  className?: string
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']

export function RecommendStrip({ items, onSelect, defaultOpen = true, className = '' }: RecommendStripProps) {
  const [open, setOpen] = useState(defaultOpen)
  if (!items || items.length === 0) return null

  return (
    <section className={`recommend-strip ${className}`} aria-label="흐름 좋은 방 추천">
      <button
        type="button"
        className="recommend-strip__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="recommend-strip__title">추천 · 흐름 좋은 방 {items.length}개</span>
        <span className="recommend-strip__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ul className="recommend-strip__list">
          {items.map((it, i) => {
            const rate = it.total > 0 ? Math.round((it.hits / it.total) * 100) : null
            return (
              <li key={it.id}>
                <button type="button" className="recommend-strip__item" onClick={() => onSelect?.(it.id)}>
                  <span className="recommend-strip__rank" aria-hidden="true">{CIRCLED[i] ?? `${i + 1}.`}</span>
                  <span className="recommend-strip__name">{it.name}</span>
                  <span className="recommend-strip__rate">
                    적중 {it.hits}/{it.total}
                    {rate != null && ` (${rate}%)`}
                  </span>
                  {it.note && <span className="recommend-strip__note">{it.note}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default RecommendStrip
