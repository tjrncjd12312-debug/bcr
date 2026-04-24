// ErrorBoundary - Catches React rendering errors
import { Component, type ReactNode, type ErrorInfo } from 'react'
import './ErrorBoundary.css'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo })

    // Log error
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)

    // Call optional error handler
    this.props.onError?.(error, errorInfo)
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="error-boundary">
          <div className="error-boundary__content">
            <div className="error-boundary__icon">⚠️</div>
            <h2 className="error-boundary__title">오류가 발생했습니다</h2>
            <p className="error-boundary__message">
              {this.state.error?.message || '알 수 없는 오류가 발생했습니다.'}
            </p>
            {this.state.errorInfo && (
              <details className="error-boundary__details">
                <summary>상세 정보</summary>
                <pre>{this.state.errorInfo.componentStack}</pre>
              </details>
            )}
            <div className="error-boundary__actions">
              <button
                className="error-boundary__btn error-boundary__btn--primary"
                onClick={this.handleReset}
              >
                다시 시도
              </button>
              <button
                className="error-boundary__btn error-boundary__btn--secondary"
                onClick={() => window.location.reload()}
              >
                새로고침
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
