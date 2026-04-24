// PredictionIcon - B/P/PASS 예측 아이콘 컴포넌트
// Clean Architecture: Presentation Layer
// 3개 파일에서 중복되던 renderPredictionValue 로직을 통합

type PredictionValue = 'B' | 'P' | 'T' | 'SKIP' | string | null | undefined

interface PredictionIconProps {
  /** 예측 값 (B, P, T, SKIP) */
  prediction: PredictionValue
  /** 아이콘 크기 */
  size?: 'sm' | 'md' | 'lg'
  /** 스킵 여부 (true면 prediction 값 무시하고 패스 표시) */
  isSkip?: boolean
  /** 추가 클래스명 */
  className?: string
}

/**
 * B/P/PASS 예측 아이콘을 렌더링하는 컴포넌트
 *
 * @example
 * <PredictionIcon prediction="B" size="md" />
 * <PredictionIcon prediction="P" />
 * <PredictionIcon prediction={null} isSkip={true} />
 */
export function PredictionIcon({
  prediction,
  size = 'sm',
  isSkip = false,
  className = '',
}: PredictionIconProps) {
  const p = prediction?.toUpperCase()
  const isPass = p === 'T' || p === 'SKIP' || isSkip === true

  // 예측이 없고 패스도 아니면 렌더링하지 않음
  if (!prediction && !isPass) return null

  const baseClass = `pred-icon pred-icon--${size}`
  const extraClass = className ? ` ${className}` : ''

  if (isPass) {
    return <span className={`${baseClass} pred-icon--pass${extraClass}`}>패스</span>
  }
  if (p === 'B') {
    return <span className={`${baseClass} pred-icon--b${extraClass}`}>B</span>
  }
  if (p === 'P') {
    return <span className={`${baseClass} pred-icon--p${extraClass}`}>P</span>
  }

  return null
}

export default PredictionIcon
