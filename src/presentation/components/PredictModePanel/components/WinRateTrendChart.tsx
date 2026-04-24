import { memo, useMemo, useEffect, useRef } from 'react'
import './WinRateTrendChart.css'

interface WinRateTrendChartProps {
  history: any[]
}

function WinRateTrendChart({ history }: WinRateTrendChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<any>(null)

  const dataPoints = useMemo(() => {
    const accuracyHistory = history
      .filter(h => h.isCorrect !== undefined)
      .slice(-30)

    if (accuracyHistory.length === 0) return null

    let correct = 0
    const points = accuracyHistory.map((h, i) => {
      if (h.isCorrect) correct++
      return (correct / (i + 1)) * 100
    })

    return {
      labels: points.map((_, i) => i + 1),
      data: points,
    }
  }, [history])

  useEffect(() => {
    if (!dataPoints || !canvasRef.current) return

    let cancelled = false

    Promise.all([
      import('chart.js/auto'),
    ]).then(([{ Chart }]) => {
      if (cancelled || !canvasRef.current) return

      // Destroy previous instance
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }

      chartRef.current = new Chart(canvasRef.current, {
        type: 'line',
        data: {
          labels: dataPoints.labels,
          datasets: [
            {
              label: '승률 추이',
              data: dataPoints.data,
              borderColor: 'rgba(212, 175, 55, 0.8)',
              backgroundColor: 'rgba(212, 175, 55, 0.1)',
              fill: true,
              tension: 0.4,
              pointRadius: 0,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              backgroundColor: 'rgba(15, 15, 20, 0.9)',
              titleColor: '#fff',
              bodyColor: '#fff',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              callbacks: {
                label: (context: any) => `승률: ${(context.parsed.y ?? 0).toFixed(1)}%`,
              },
            },
          },
          scales: {
            x: { display: false },
            y: {
              min: 0,
              max: 100,
              ticks: {
                color: 'rgba(255,255,255,0.4)',
                font: { size: 10 },
                callback: (val: any) => `${val}%`,
                stepSize: 25,
              },
              grid: {
                color: 'rgba(255,255,255,0.05)',
              },
            },
          },
        },
      })
    })

    return () => {
      cancelled = true
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
    }
  }, [dataPoints])

  if (!dataPoints) return null

  return (
    <div className="room-detail__winrate-chart anim-fade-in">
      <div className="chart-label">실시간 예측 적중률 분석</div>
      <div className="chart-wrapper">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

export default memo(WinRateTrendChart)
