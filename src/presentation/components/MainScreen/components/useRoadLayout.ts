import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

interface UseRoadLayoutOptions {
  cols: number
  rows: number
  gap?: number
  minSize?: number
  maxSize?: number
}

/**
 * Compute responsive road cell size based on container width and column count.
 * Keeps circles consistent across Big Road and Bead Plate.
 */
export function useRoadLayout({
  cols,
  rows,
  gap = 4,
  minSize = 24,
  maxSize = 40,
}: UseRoadLayoutOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [cellSize, setCellSize] = useState(minSize)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const calculate = () => {
      const width = el.clientWidth || el.parentElement?.clientWidth || minSize * cols
      const height = el.clientHeight || el.parentElement?.clientHeight || 0
      const safeCols = Math.max(cols, 1)
      const safeRows = Math.max(rows, 1)
      const sizeByWidth = (width - gap * (safeCols - 1)) / safeCols
      const sizeByHeight = height > 0 ? (height - gap * (safeRows - 1)) / safeRows : Number.POSITIVE_INFINITY
      const size = Math.min(sizeByWidth, sizeByHeight, maxSize)
      const clamped = Math.max(minSize, Math.floor(size))
      setCellSize(clamped)
    }

    calculate()
    const observer = new ResizeObserver(calculate)
    observer.observe(el)
    return () => observer.disconnect()
  }, [cols, gap, maxSize, minSize])

  const style = useMemo(() => ({
    '--road-cell-size': `${cellSize}px`,
    '--road-cols': cols,
    '--road-rows': rows,
    '--road-gap': `${gap}px`,
    '--road-total-width': `${cellSize * cols + gap * Math.max(cols - 1, 0)}px`,
  } as CSSProperties), [cellSize, cols, gap, rows])

  return { containerRef, style }
}
