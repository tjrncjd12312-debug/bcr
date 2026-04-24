import { useState, useEffect, FormEvent, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './LoginScreen.css'
import { loadStoredLogin, persistLogin, type StoredLoginData } from './loginStorage'
import type { AppMode } from '../../../domain/entities'

/**
 * ✅ Security: 에러 메시지에서 URL 패턴 제거
 * 로그인 실패 시 사이트 주소가 노출되지 않도록 함
 */
function sanitizeErrorMessage(message: string): string {
  // URL 패턴 제거 (http://, https://, domain.com 등)
  const urlPattern = /https?:\/\/[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}[^\s]*/gi
  let sanitized = message.replace(urlPattern, '[주소]')

  // IP 주소 패턴 제거
  const ipPattern = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g
  sanitized = sanitized.replace(ipPattern, '[서버]')

  return sanitized
}

interface LoginScreenProps {
  onLogin: (username: string, password: string, siteUrl: string, appMode: AppMode) => Promise<void>
  isLoading: boolean
}

export default function LoginScreen({ onLogin, isLoading: propIsLoading }: LoginScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [focusedField, setFocusedField] = useState<string | null>(null)
  const [rememberProfile, setRememberProfile] = useState(true)
  const [rememberPassword, setRememberPassword] = useState(false)
  const [hasLoadedSavedLogin, setHasLoadedSavedLogin] = useState(false)
  const [appMode, setAppMode] = useState<AppMode>('predict')  // 🔥 기본값: 예측 모드

  useEffect(() => {
    const saved = loadStoredLogin()
    setRememberProfile(saved.rememberProfile)
    setRememberPassword(saved.rememberPassword)

    if (saved.username) {
      setUsername(saved.username)
    }
    if (saved.siteUrl) {
      setSiteUrl(saved.siteUrl)
    }
    if (saved.rememberPassword && saved.password) {
      setPassword(saved.password)
    }
    // 🔥 저장된 모드 불러오기
    if (saved.appMode) {
      setAppMode(saved.appMode)
    }

    setHasLoadedSavedLogin(true)
  }, [])

  useEffect(() => {
    if (!hasLoadedSavedLogin) {
      return
    }

    const sanitized: StoredLoginData = {
      username: rememberProfile ? username.trim() : '',
      siteUrl: rememberProfile ? siteUrl.trim() : '',
      password: rememberPassword ? password : '',
      rememberPassword,
      rememberProfile,
      appMode,  // 🔥 선택한 모드 저장
    }

    persistLogin(sanitized)
  }, [username, password, siteUrl, rememberPassword, rememberProfile, appMode, hasLoadedSavedLogin])

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    if (!username.trim()) {
      setError('아이디를 입력해주세요.')
      setIsLoading(false)
      return
    }
    if (!password.trim()) {
      setError('비밀번호를 입력해주세요.')
      setIsLoading(false)
      return
    }
    if (!siteUrl.trim()) {
      setError('사이트 주소를 입력해주세요.')
      setIsLoading(false)
      return
    }

    let formattedUrl = siteUrl.trim()
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = 'https://' + formattedUrl
    }

    try {
      await onLogin(username.trim(), password, formattedUrl, appMode)
    } catch (err) {
      // ✅ Security: 에러 메시지에서 URL 제거
      const rawMessage = err instanceof Error ? err.message : String(err)

      // 버전 불일치 에러 체크
      if (rawMessage.includes('"type":"version_mismatch"')) {
        try {
          const errorData = JSON.parse(rawMessage)
          if (errorData.type === 'version_mismatch') {
            setIsUpdating(true)
            setUpdateMessage(`최신 버전(${errorData.requiredVersion})으로 업데이트를 시작합니다...`)

            try {
              const result = await invoke('download_client_update', {
                downloadUrl: errorData.downloadUrl,
                fileName: errorData.fileName || ''
              })

              // 🎨 UX 개선: alert() 제거하고 화면 메시지로 안내
              // setUpdateMessage(String(result)) 
              setUpdateMessage("설치 프로그램이 준비되었습니다.\n잠시 후 앱이 종료되며 설치가 시작됩니다.")

              // ⏳ 사용자가 메시지를 읽을 시간을 줌 (3초)
              await new Promise(resolve => setTimeout(resolve, 3000));

              // MSI 설치 프로그램이 실행된 경우 또는 업데이트 완료 후 앱 종료
              if (String(result).includes('설치 프로그램') || String(result).includes('완료') || String(result).includes('재시작')) {
                await invoke('exit_app')
              }
            } catch (updateErr) {
              setError(`업데이트 실패: ${updateErr}`)
              setIsUpdating(false)
            }
            return
          }
        } catch (parseErr) {
          // JSON 파싱 실패 시 일반 에러로 처리
        }
      }

      setError(sanitizeErrorMessage(rawMessage))
    } finally {
      setIsLoading(false)
    }
  }, [username, password, siteUrl, appMode, onLogin])

  const currentLoadingState = isLoading || propIsLoading || isUpdating;

  return (
    <div className="login">
      {/* Background Effects */}
      <div className="login__bg-grid" />
      <div className="login__bg-glow login__bg-glow--1" />
      <div className="login__bg-glow login__bg-glow--2" />

      <div className="login__container">
        {/* Header */}
        <div className="login__header">
          <div className="login__logo">
            <span className="login__logo-text">S</span>
            <div className="login__logo-ring" />
          </div>
          <h1 className="login__title">SmartHelper</h1>
          <p className="login__subtitle">INTELLIGENT BETTING ASSISTANT</p>
        </div>

        {/* Mode Selection */}
        <div className="login__mode-section">
          <div className="login__mode-header">
            <span className="login__mode-title">모드 선택</span>
          </div>
          <div className="login__mode-cards">
            {/* 🔥 예측 분석이 왼쪽 */}
            <button
              type="button"
              className={`login__mode-card ${appMode === 'predict' ? 'active' : ''}`}
              onClick={() => setAppMode('predict')}
              disabled={currentLoadingState}
            >
              <div className="login__mode-card-icon login__mode-card-icon--predict">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 3v18h18" />
                  <path d="M18 9l-5 5-4-4-3 3" />
                </svg>
              </div>
              <div className="login__mode-card-content">
                <span className="login__mode-card-title">예측 분석</span>
                <span className="login__mode-card-desc">패턴 분석 · 예측 확인</span>
              </div>
              {appMode === 'predict' && <div className="login__mode-card-check">✓</div>}
            </button>

            {/* 🔥 오토 배팅이 오른쪽 */}
            <button
              type="button"
              className={`login__mode-card ${appMode === 'auto' ? 'active' : ''}`}
              onClick={() => setAppMode('auto')}
              disabled={currentLoadingState}
            >
              <div className="login__mode-card-icon login__mode-card-icon--auto">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="login__mode-card-content">
                <span className="login__mode-card-title">오토 배팅</span>
                <span className="login__mode-card-desc">자동 분석 · 자동 실행</span>
              </div>
              {appMode === 'auto' && <div className="login__mode-card-check">✓</div>}
            </button>
          </div>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="login__form">
          <div className={`login__field ${focusedField === 'username' ? 'focused' : ''}`}>
            <label className="login__label">아이디</label>
            <input
              type="text"
              className="login__input"
              placeholder="아이디를 입력하세요"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onFocus={() => setFocusedField('username')}
              onBlur={() => setFocusedField(null)}
              disabled={currentLoadingState}
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className={`login__field ${focusedField === 'password' ? 'focused' : ''}`}>
            <label className="login__label">비밀번호</label>
            <div className="login__input-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                className="login__input"
                placeholder="비밀번호를 입력하세요"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField(null)}
                disabled={currentLoadingState}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="login__toggle"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? '숨김' : '보기'}
              </button>
            </div>
          </div>

          <div className={`login__field ${focusedField === 'site' ? 'focused' : ''}`}>
            <label className="login__label">사이트 주소</label>
            <input
              type="text"
              className="login__input"
              placeholder="example.com"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              onFocus={() => setFocusedField('site')}
              onBlur={() => setFocusedField(null)}
              disabled={currentLoadingState}
              autoComplete="url"
            />
          </div>

          <div className="login__options">
            <label className="login__option">
              <input
                type="checkbox"
                checked={rememberProfile}
                onChange={(e) => setRememberProfile(e.target.checked)}
                disabled={currentLoadingState}
              />
              <span className="login__option-check" />
              <span>로그인 정보 저장</span>
            </label>
            <label className="login__option">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={(e) => setRememberPassword(e.target.checked)}
                disabled={currentLoadingState}
              />
              <span className="login__option-check" />
              <span>비밀번호 저장</span>
            </label>
          </div>

          {error && (
            <div className="login__error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className={`login__submit ${currentLoadingState ? 'loading' : ''}`}
            disabled={currentLoadingState}
          >
            {currentLoadingState ? (
              <>
                <span className="login__submit-spinner" />
                {isUpdating ? '업데이트 중...' : '연결 중...'}
              </>
            ) : (
              '로그인'
            )}
          </button>
        </form>

        <div className="login__footer">
          <span>SmartHelper v2.0</span>
          <span className="login__footer-dot">·</span>
          <span>Intelligent Assistant</span>
        </div>
      </div>

      {isUpdating && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          color: 'white',
          backdropFilter: 'blur(5px)'
        }}>
          <div style={{ marginBottom: '24px', fontSize: '1.25rem', fontWeight: 600, textAlign: 'center', padding: '0 20px' }}>
            {updateMessage}
          </div>
          <div style={{
            width: '48px',
            height: '48px',
            border: '3px solid rgba(255,255,255,0.1)',
            borderTopColor: '#3b82f6',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}></div>
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      )}
    </div>
  )
}
