// LazyMount — 스크롤 영역에 가까운 카드만 실제로 마운트한다(방 ~100개 × SVG 로드맵 대응, 메모리·렌더 절약).
//   화면 밖 카드는 마지막으로 잰 높이의 빈 자리로 두어 스크롤 위치가 튀지 않는다.
//   IntersectionObserver가 없는 환경(테스트)에서는 항상 렌더한다.
import { useEffect, useRef, useState, type ReactNode } from 'react'

interface LazyMountProps {
  children: ReactNode
  /** 자리 표시용 라벨(방 이름) */
  label?: string
  /** 아직 한 번도 그려지지 않았을 때 쓰는 기본 높이 */
  defaultHeight?: number
  /** 스크롤 컨테이너 셀렉터 — 없으면 뷰포트 */
  rootSelector?: string
  className?: string
}

const HAS_IO = typeof window !== 'undefined' && typeof IntersectionObserver !== 'undefined'

export function LazyMount({ children, label, defaultHeight = 330, rootSelector = '.auto-mode__rooms', className = '' }: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!HAS_IO)
  const heightRef = useRef(defaultHeight)

  useEffect(() => {
    if (!HAS_IO) return
    const el = ref.current
    if (!el) return
    const root = (el.closest(rootSelector) as Element | null) ?? null
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) setVisible(e.isIntersecting) },
      { root, rootMargin: '600px 0px 600px 0px', threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootSelector])

  // 보이는 동안 실제 높이를 기억해 두었다가 자리 표시에 쓴다.
  useEffect(() => {
    if (!visible || !ref.current) return
    const h = ref.current.offsetHeight
    if (h > 40) heightRef.current = h
  })

  return (
    <div
      ref={ref}
      className={`evo-lazy ${visible ? 'is-live' : 'is-placeholder'} ${className}`.trim()}
      style={visible ? undefined : { minHeight: heightRef.current }}
      aria-busy={!visible}
    >
      {visible ? children : (label ? <span className="evo-lazy__label">{label}</span> : null)}
    </div>
  )
}

export default LazyMount
