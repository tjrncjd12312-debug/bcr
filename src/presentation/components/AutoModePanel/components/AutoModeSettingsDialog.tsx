// AutoModeSettingsDialog - SmartHelper 오토모드 설정창
// Clean Architecture: Presentation Layer
// NOTE: Filter thresholds and the 새 슈 타이 마틴 toggle now live in
// FilterSettingsDialog (consolidated filter settings).

import { useEffect, useState, useMemo } from 'react'
import type { BetStrategyType } from '../../../../domain/entities'
import type { AutoModeSettings } from '../../../../application/services/AutoModeService'
import VirtualBettingService from '../../../../application/services/VirtualBettingService'
import { NumberFieldWithSuffix } from '../../common/NumberFieldWithSuffix'
import { SettingsDialogFrame, type SettingsTabDef } from '../../common/SettingsDialogFrame'
import { StatCard } from '../../common/StatCard'
import './AutoModeSettingsDialog.css'

type SettingsTab = 'general' | 'strategy' | 'safety'

const BET_STRATEGY_OPTIONS: { value: BetStrategyType; label: string; desc: string }[] = [
  { value: 'martingale', label: '마틴게일', desc: '패배시 2배 증가' },
  { value: 'flat', label: '플랫', desc: '고정 금액 유지' },
  { value: 'fibonacci', label: '피보나치', desc: '피보나치 수열' },
  { value: 'paroli', label: '파롤리', desc: '승리시 2배 증가' },
  { value: 'custom', label: '커스텀', desc: '단계별 직접 설정' },
]

const TABS: SettingsTabDef<SettingsTab>[] = [
  { value: 'general', label: '일반' },
  { value: 'strategy', label: '배팅 전략' },
  { value: 'safety', label: '안전 장치' },
]

interface AutoModeSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  settings: AutoModeSettings
  onUpdateSettings: (settings: Partial<AutoModeSettings>) => void
  onResetStats: () => void
  totalWins: number
  totalLosses: number
  cumulativeProfit: number
  realBalance: number | null
}

export function AutoModeSettingsDialog({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onResetStats,
  totalWins,
  totalLosses,
  cumulativeProfit,
  realBalance,
}: AutoModeSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  // 가상 잔액 상태 - VirtualBettingService에서 초기화
  const [virtualBalance, setVirtualBalance] = useState(() =>
    VirtualBettingService.getSettings().initialBalance
  )

  // currentVirtualBalance must equal the header's calculation; do not switch
  // to VirtualBettingService.getGlobalBalance() — it has a sync race.
  const currentVirtualBalance = virtualBalance + cumulativeProfit

  useEffect(() => {
    if (isOpen) {
      setVirtualBalance(VirtualBettingService.getSettings().initialBalance)
    }
  }, [isOpen])

  const handleVirtualBalanceChange = (newBalance: number) => {
    setVirtualBalance(newBalance)
    VirtualBettingService.updateSettings({ initialBalance: newBalance })
    onResetStats()
  }

  const handleResetVirtualBalance = () => {
    VirtualBettingService.reset()
    onResetStats()
  }

  const betPreview = useMemo(() => {
    const base = settings.baseBetAmount || 10000
    const max = Math.min(settings.maxMartin || 5, 100) // 최대 100단계까지 지원
    const result: number[] = []
    // Generate fibonacci multipliers up to `max` (1, 1, 2, 3, 5, 8, ...) so the
    // preview matches MartingaleManager.calculateBetAmount for any allowed level.
    const fib: number[] = [1, 1]
    for (let i = 2; i < max; i++) fib.push(fib[i - 1] + fib[i - 2])

    for (let i = 0; i < max; i++) {
      switch (settings.betStrategy) {
        case 'flat':
          result.push(base)
          break
        case 'fibonacci':
          result.push(base * (fib[i] || fib[fib.length - 1]))
          break
        case 'custom':
          // 커스텀: 사용자 설정 금액 또는 기본값
          result.push(settings.customBetAmounts?.[i] ?? base)
          break
        case 'paroli':
        case 'martingale':
        default:
          result.push(base * Math.pow(2, i))
          break
      }
    }
    return result
  }, [settings.baseBetAmount, settings.maxMartin, settings.betStrategy, settings.customBetAmounts])

  const totalRequired = useMemo(() => betPreview.reduce((sum, v) => sum + v, 0), [betPreview])
  
  const winRate = useMemo(() => {
    return totalWins + totalLosses > 0
      ? Math.round((totalWins / (totalWins + totalLosses)) * 100)
      : 0
  }, [totalWins, totalLosses])

  return (
    <SettingsDialogFrame
      isOpen={isOpen}
      onClose={onClose}
      title="오토 배팅 설정"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      footer={
        <button className="ams-btn-primary" onClick={onClose}>
          확인
        </button>
      }
    >
      {/* ========== Tab: 일반 ========== */}
      {activeTab === 'general' && (
        <>
          {/* 배팅 모드 */}
          <div className="ams-section">
            <div className="ams-section-title">배팅 모드</div>
            <div className="ams-mode-toggle">
              <button
                className={`ams-mode-btn ${settings.isVirtualMode ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ isVirtualMode: true, autoBetting: false })}
              >
                <span className="ams-mode-label">가상 배팅</span>
                <span className="ams-mode-desc">시뮬레이션 모드</span>
              </button>
              <button
                className={`ams-mode-btn real ${!settings.isVirtualMode ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ isVirtualMode: false, autoBetting: true })}
              >
                <span className="ams-mode-label">실제 배팅</span>
                <span className="ams-mode-desc">실금액 배팅</span>
              </button>
            </div>
            {!settings.isVirtualMode && (
              <div className="ams-warning">
                실제 금액이 배팅됩니다. 신중하게 사용하세요.
              </div>
            )}
          </div>

          {/* 가상 잔액 설정 - 가상 모드일 때만 표시 */}
          {settings.isVirtualMode && (
            <div className="ams-section">
              <div className="ams-section-title">가상 잔액 설정</div>
              <div className="settings-field-row">
                <NumberFieldWithSuffix
                  label="초기 잔액"
                  value={virtualBalance}
                  suffix="원"
                  min={100000}
                  step={100000}
                  onChange={handleVirtualBalanceChange}
                />
                <div className="ams-input-group">
                  <label>현재 잔액</label>
                  <div className="ams-virtual-balance-display">
                    <span className={currentVirtualBalance >= virtualBalance ? 'positive' : 'negative'}>
                      {currentVirtualBalance.toLocaleString()}원
                    </span>
                    <button
                      className="ams-btn-small"
                      onClick={handleResetVirtualBalance}
                      title="초기 잔액으로 리셋"
                    >
                      리셋
                    </button>
                  </div>
                </div>
              </div>
              <div className="ams-hint">초기 잔액 변경 시 자동으로 리셋됩니다 · 다음 실행에도 저장됨</div>
            </div>
          )}

          {/* 현재 상태 */}
          <div className="ams-section">
            <div className="ams-section-title">현재 상태</div>
            <div className="settings-stat-grid">
              <StatCard
                label={settings.isVirtualMode ? '가상 잔액' : '잔액'}
                value={
                  settings.isVirtualMode
                    ? currentVirtualBalance.toLocaleString()
                    : realBalance !== null ? realBalance.toLocaleString() : '-'
                }
              />
              <StatCard
                label="승률"
                value={`${winRate}%`}
                tone={winRate >= 50 ? 'positive' : winRate > 0 ? 'negative' : 'neutral'}
              />
              <StatCard
                label="승/패"
                value={
                  <>
                    <span className="settings-stat-card__wins">{totalWins}</span>
                    <span className="settings-stat-card__sep">/</span>
                    <span className="settings-stat-card__losses">{totalLosses}</span>
                  </>
                }
              />
              <StatCard
                label="손익"
                value={`${cumulativeProfit > 0 ? '+' : ''}${cumulativeProfit.toLocaleString()}`}
                tone={cumulativeProfit > 0 ? 'positive' : cumulativeProfit < 0 ? 'negative' : 'neutral'}
              />
            </div>
          </div>

          {/* 데이터 관리 */}
          <div className="ams-section">
            <div className="ams-section-title">데이터 관리</div>
            <div className="ams-data-actions">
              <button className="ams-btn-outline" onClick={onResetStats}>
                통계 초기화
              </button>
              <button
                className="ams-btn-outline ams-btn-danger"
                onClick={() => {
                  onResetStats()
                  VirtualBettingService.reset()
                  handleResetVirtualBalance()
                }}
              >
                전체 세션 초기화
              </button>
            </div>
            <div className="ams-hint">전체 세션 초기화: 통계 + 가상잔액 + 마틴레벨 모두 리셋</div>
          </div>
        </>
      )}

      {/* ========== Tab: 배팅 전략 ========== */}
      {activeTab === 'strategy' && (
        <>
          {/* 배팅 전략 선택 */}
          <div className="ams-section">
            <div className="ams-section-title">배팅 전략</div>
            <div className="ams-strategy-grid">
              {BET_STRATEGY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`ams-strategy-btn ${settings.betStrategy === opt.value ? 'active' : ''}`}
                  onClick={() => {
                    // 커스텀 전략 선택 시 배열 초기화 (기존 값 없으면)
                    if (opt.value === 'custom' && !settings.customBetAmounts) {
                      const baseAmount = settings.baseBetAmount || 10000
                      const maxLevel = settings.maxMartin || 5
                      const initialAmounts = Array(maxLevel).fill(baseAmount)
                      onUpdateSettings({ betStrategy: opt.value, customBetAmounts: initialAmounts })
                    } else {
                      onUpdateSettings({ betStrategy: opt.value })
                    }
                  }}
                >
                  <span className="ams-strategy-label">{opt.label}</span>
                  <span className="ams-strategy-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 배팅 금액 설정 */}
          <div className="ams-section">
            <div className="ams-section-title">배팅 금액</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="기본 배팅금"
                value={settings.baseBetAmount || 10000}
                suffix="원"
                min={1000}
                step={1000}
                onChange={(n) => onUpdateSettings({ baseBetAmount: n })}
              />
              <NumberFieldWithSuffix
                label="최대 단계"
                value={settings.maxMartin || 5}
                suffix="단계"
                min={1}
                max={100}
                onChange={(n) => {
                  // 커스텀 전략일 때 배열 크기 조정
                  if (settings.betStrategy === 'custom') {
                    const baseAmount = settings.baseBetAmount || 10000
                    const currentAmounts = settings.customBetAmounts || []
                    const newAmounts = Array(n).fill(baseAmount).map((def, i) =>
                      currentAmounts[i] ?? def
                    )
                    onUpdateSettings({ maxMartin: n, customBetAmounts: newAmounts })
                  } else {
                    onUpdateSettings({ maxMartin: n })
                  }
                }}
              />
            </div>
          </div>

          {/* 단계별 미리보기 / 커스텀 입력 */}
          <div className="ams-section">
            <div className="ams-section-title">
              {settings.betStrategy === 'custom' ? '단계별 배팅금 설정' : '단계별 배팅금 미리보기'}
            </div>
            <div className="ams-preview">
              <div className="ams-preview-steps">
                {betPreview.map((amount, i) =>
                  settings.betStrategy === 'custom' ? (
                    <div key={i} className="ams-preview-step">
                      <NumberFieldWithSuffix
                        label={`${i + 1}단계`}
                        value={settings.customBetAmounts?.[i] ?? (settings.baseBetAmount || 10000)}
                        suffix="원"
                        min={1000}
                        step={1000}
                        onChange={(n) => {
                          const baseAmount = settings.baseBetAmount || 10000
                          const maxLevel = settings.maxMartin || 5
                          const newAmounts = [...(settings.customBetAmounts || Array(maxLevel).fill(baseAmount))]
                          newAmounts[i] = n
                          onUpdateSettings({ customBetAmounts: newAmounts })
                        }}
                      />
                    </div>
                  ) : (
                    <div key={i} className="ams-preview-step">
                      <span className="ams-preview-level">{i + 1}단계</span>
                      <span className="ams-preview-amount">{amount.toLocaleString()}원</span>
                    </div>
                  )
                )}
              </div>
              <div className="ams-preview-total">
                총 필요 자금: <strong>{totalRequired.toLocaleString()}원</strong>
              </div>
            </div>
          </div>

          <div className="ams-section">
            <div className="ams-section-title">동시 배팅 제한</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="최대 동시 배팅 수"
                value={settings.maxConcurrentBets ?? 0}
                suffix="개"
                min={0}
                onChange={(n) => onUpdateSettings({ maxConcurrentBets: Math.max(0, n) })}
              />
            </div>
            <div className="ams-hint" style={{ fontSize: '0.75rem', color: '#888', marginTop: '4px' }}>
              0 = 전체 방 배팅 (동시배팅 제한없음)
            </div>
          </div>
        </>
      )}

      {/* NOTE: 방 필터 탭 제거됨 - 헤더에서 직접 방 선택 */}

      {/* ========== Tab: 안전 장치 ========== */}
      {activeTab === 'safety' && (
        <>
          {/* 윈컷/로스컷 */}
          <div className="ams-section">
            <div className="ams-section-title">손익 제한</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="윈컷 (목표 수익)"
                value={settings.winCutAmount || 0}
                suffix="원"
                min={0}
                step={10000}
                onChange={(n) => onUpdateSettings({ winCutAmount: n })}
              />
              <NumberFieldWithSuffix
                label="로스컷 (최대 손실)"
                value={settings.lossCutAmount || 0}
                suffix="원"
                min={0}
                step={10000}
                onChange={(n) => onUpdateSettings({ lossCutAmount: n })}
              />
            </div>
            <div className="ams-hint">0 = 무제한 (제한 없음)</div>
          </div>

          {/* 연패 설정 */}
          <div className="ams-section">
            <div className="ams-section-title">연패 제한</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="연패 기준 (해당 방 배팅 중지)"
                value={settings.globalMaxConsecutiveLosses || 5}
                suffix="연패"
                min={1}
                max={20}
                onChange={(n) => onUpdateSettings({ globalMaxConsecutiveLosses: n })}
              />
            </div>
            <div className="ams-hint">설정한 연패 횟수 도달 시 해당 방 배팅 중지</div>
          </div>

          {/* 중지 시 마틴 리셋 */}
          <div className="ams-section">
            <div className="ams-section-title">중지 시 마틴 처리</div>
            <div className="ams-toggle-row">
              <label className="ams-toggle-label">
                <input
                  type="checkbox"
                  checked={settings.resetMartinOnStop ?? true}
                  onChange={(e) => onUpdateSettings({ resetMartinOnStop: e.target.checked })}
                />
                <span className="ams-toggle-text">중지 시 마틴 레벨 초기화</span>
              </label>
            </div>
            <div className="ams-hint">
              {settings.resetMartinOnStop ?? true
                ? '중지 후 재시작 시 1단계부터 시작'
                : '중지 후 재시작 시 이전 마틴 레벨 유지'}
            </div>
          </div>
        </>
      )}
    </SettingsDialogFrame>
  )
}
