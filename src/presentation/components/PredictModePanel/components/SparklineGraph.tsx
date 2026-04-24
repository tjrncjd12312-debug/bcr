import { memo, useMemo } from 'react'

interface SparklineGraphProps {
  history: Array<{ isCorrect?: boolean }>
  color?: string
}

function SparklineGraph({ history, color = 'rgba(255, 255, 255, 0.4)' }: SparklineGraphProps) {
  const { points, areaPoints } = useMemo(() => {
    // We need at least 2 points to draw a trend
    if (!history || history.length < 2) return { points: '', areaPoints: '' }

    // Filter history to only include items with a prediction result
    const predictionHistory = history.filter(h => h.isCorrect !== undefined).slice(-20)
    if (predictionHistory.length < 2) return { points: '', areaPoints: '' }

    const width = 300
    const height = 100
    const step = width / (predictionHistory.length - 1)

    // Calculate cumulative score: Win = +10, Loss = -10
    let currentScore = 50 // Start in the middle
    const pts = predictionHistory.map((h, i) => {
      if (h.isCorrect) currentScore = Math.min(currentScore + 15, 90)
      else currentScore = Math.max(currentScore - 15, 10)
      return `${i * step},${height - currentScore}`
    })

    const linePoints = pts.join(' ')
    const areaPts = `0,${height} ${linePoints} ${width},${height}`

    return { points: linePoints, areaPoints: areaPts }
  }, [history])

  if (!points) return null

  const gradientId = `sparkline-grad-${Math.random().toString(36).substr(2, 9)}`

  return (
    <div className="sparkline-container">
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="sparkline-svg">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
          style={{
            opacity: 0.6,
            filter: `drop-shadow(0 0 5px ${color})`
          }}
        />
      </svg>
    </div>
  )
}

export default memo(SparklineGraph)
