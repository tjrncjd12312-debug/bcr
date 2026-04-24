import { memo, useMemo } from 'react'

interface MiniRoadmapProps {
  history: Array<{ winner: 'B' | 'P' | 'T' }>
  limit?: number
}

function MiniRoadmap({ history, limit = 24 }: MiniRoadmapProps) {
  const road = useMemo(() => {
    return history.slice(0, limit).reverse() // Show oldest to newest
  }, [history, limit])

  return (
    <div className="mini-roadmap">
      {road.map((h, i) => (
        <div
          key={i}
          className={`mini-roadmap__dot ${h.winner.toLowerCase()}`}
          title={h.winner === 'B' ? 'Banker' : h.winner === 'P' ? 'Player' : 'Tie'}
        />
      ))}
    </div>
  )
}

export default memo(MiniRoadmap)
