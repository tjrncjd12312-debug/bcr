// AutoModeSettingsDialog - SmartHelper 오토모드 설정창
// Clean Architecture: Presentation Layer
// NOTE: Filter thresholds and the 새 슈 타이 마틴 toggle now live in
// FilterSettingsDialog (consolidated filter settings).

import { useEffect, useState, useMemo } from 'react'
import type { BetStrategyType } from '../../../../domain/entities'
import type { CustomStrategyDefinitionV1 } from '../../../../domain/strategies/customStrategy'
import type { AutoModeSettings, AutoModeState } from '../../../../application/services/AutoModeService'
import VirtualBettingService from '../../../../application/services/VirtualBettingService'
import { useManualBet } from '../../../hooks/useManualBet'
import { NumberFieldWithSuffix } from '../../common/NumberFieldWithSuffix'
import { SettingsDialogFrame, type SettingsTabDef } from '../../common/SettingsDialogFrame'
import { StatCard } from '../../common/StatCard'
import './AutoModeSettingsDialog.css'

type SettingsTab = 'general' | 'strategy' | 'safety' | 'rooms' | 'manual'
const PRESET_CONFIDENCE = [55, 60, 65, 70, 75, 80].map(v => ({ label: `${v}%`, value: v }))

// 빠른 선택 칩 — 타이핑 없이 흔한 값을 한 번에(2026-09-05 설정 UX)
const KRW = (n: number) => (n >= 10000 ? `${n / 10000}만` : n >= 1000 ? `${n / 1000}천` : `${n}`)
const PRESET_BALANCE = [100_000, 300_000, 500_000, 1_000_000, 3_000_000, 5_000_000].map(v => ({ label: `${KRW(v)}원`, value: v }))
const PRESET_BET = [1_000, 5_000, 10_000, 30_000, 50_000, 100_000].map(v => ({ label: `${KRW(v)}원`, value: v }))
const PRESET_STAGE = [3, 5, 7, 10].map(v => ({ label: `${v}단계`, value: v }))
const PRESET_CUT = [{ label: '끄기', value: 0 }, ...[50_000, 100_000, 300_000, 500_000, 1_000_000].map(v => ({ label: `${KRW(v)}원`, value: v }))]
const PRESET_STREAK = [3, 5, 7, 10].map(v => ({ label: `${v}연패`, value: v }))
const PRESET_CONCURRENT = [{ label: '제한 없음', value: 0 }, ...[1, 3, 6, 10].map(v => ({ label: `${v}개`, value: v }))]

const BET_STRATEGY_OPTIONS: { value: BetStrategyType; label: string; desc: string }[] = [
  { value: 'martingale', label: '마틴게일', desc: '패배시 2배 증가' },
  { value: 'flat', label: '플랫', desc: '고정 금액 유지' },
  { value: 'fibonacci', label: '피보나치', desc: '피보나치 수열' },
  { value: 'paroli', label: '파롤리', desc: '승리시 2배 증가' },
  { value: 'custom', label: '단계별 금액', desc: '기본 단계 금액 직접 설정' },
]

// 도메인 순서: 무엇으로(가상/실제) → 얼마씩(전략) → 언제 멈출지(위험 관리) → 어디에(방·조건) → 손으로 할 때(수동)
const TABS: SettingsTabDef<SettingsTab>[] = [
  { value: 'general', label: '배팅 모드' },
  { value: 'strategy', label: '배팅 전략' },
  { value: 'safety', label: '위험 관리' },
  { value: 'rooms', label: '방·조건' },
  { value: 'manual', label: '수동 배팅' },
]

interface AutoModeSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  settings: AutoModeSettings
  onUpdateSettings: (settings: Partial<AutoModeSettings>) => void
  onResetStats: (options?: { allModes?: boolean }) => void
  totalWins: number
  totalLosses: number
  cumulativeProfit: number
  realBalance: number | null
  activeStructuredStrategy?: CustomStrategyDefinitionV1 | null
  onOpenStrategyBuilder?: () => void
  /** 방·필터 탭(2026-09-05): 설정창 한곳에서 방 선택·필터·패턴으로 진입 */
  selectedRoomCount?: number
  totalRoomCount?: number
  activeFilterLabel?: string
  onOpenRoomSelector?: () => void
  onOpenFilterDialog?: () => void
  onOpenPatternManager?: () => void
  /** 가상/실제 각각의 세션 통계(각 모드 손익은 따로 쌓인다) */
  modeStats?: AutoModeState['modeStats']
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
  activeStructuredStrategy = null,
  onOpenStrategyBuilder,
  selectedRoomCount = 0,
  totalRoomCount = 0,
  activeFilterLabel = '전체',
  onOpenRoomSelector,
  onOpenFilterDialog,
  onOpenPatternManager,
  modeStats,
}: AutoModeSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const manual = useManualBet()
  const [presetDraft, setPresetDraft] = useState<string>(() => manual.chipPresets.join(', '))
  useEffect(() => { if (isOpen) setPresetDraft(manual.chipPresets.join(', ')) }, [isOpen, manual.chipPresets])
  const applyPresets = () => {
    const nums = presetDraft.split(/[,\s]+/).map(v => Number(v.replace(/[^0-9]/g, ''))).filter(n => Number.isFinite(n) && n >= 1000)
    if (nums.length > 0) manual.setChipPresets(nums)
  }

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
                  presets={PRESET_BALANCE}
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

          {/* 현재 상태 — 가상/실제 각각(손익·승패는 모드별로 따로 쌓인다) */}
          {modeStats && (
            <div className="ams-section">
              <div className="ams-section-title">모드별 세션 손익 (자동 배팅)</div>
              <div className="ams-mode-stats">
                {(['virtual', 'real'] as const).map((mode) => {
                  const st = modeStats[mode]
                  const games = st.totalWins + st.totalLosses
                  const rate = games > 0 ? Math.round((st.totalWins / games) * 100) : 0
                  const isCurrent = settings.isVirtualMode === (mode === 'virtual')
                  return (
                    <div key={mode} className={`ams-mode-stat ${mode === 'real' ? 'is-real' : ''} ${isCurrent ? 'is-current' : ''}`}>
                      <div className="ams-mode-stat__head">
                        <span>{mode === 'virtual' ? '가상' : '실제'}</span>
                        {isCurrent && <em>지금 모드</em>}
                      </div>
                      <strong className={st.cumulativeProfit > 0 ? 'positive' : st.cumulativeProfit < 0 ? 'negative' : ''}>
                        {st.cumulativeProfit > 0 ? '+' : ''}{st.cumulativeProfit.toLocaleString()}원
                      </strong>
                      <span className="ams-mode-stat__line">{st.totalWins}승 {st.totalLosses}패 · 적중률 {rate}% · 배팅 {st.totalBetAmount.toLocaleString()}원</span>
                      <span className="ams-mode-stat__line">최대 +{st.maxProfit.toLocaleString()} / {st.maxLoss.toLocaleString()}</span>
                    </div>
                  )
                })}
              </div>
              <div className="ams-hint">모드를 바꾸면 그 모드의 손익으로 이어서 셉니다. 통계 초기화는 지금 모드만 지웁니다.</div>
            </div>
          )}

          {/* 현재 상태 */}
          <div className="ams-section">
            <div className="ams-section-title">현재 모드 요약</div>
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
              <button className="ams-btn-outline" onClick={() => onResetStats()}>
                {settings.isVirtualMode ? '가상' : '실제'} 통계 초기화
              </button>
              <button
                className="ams-btn-outline ams-btn-danger"
                onClick={() => {
                  onResetStats({ allModes: true })
                  VirtualBettingService.reset()
                  handleResetVirtualBalance()
                }}
              >
                전체 세션 초기화
              </button>
            </div>
            <div className="ams-hint">통계 초기화는 지금 모드(가상/실제)만 지웁니다 · 전체 세션 초기화: 가상·실제 통계 + 가상잔액 + 마틴레벨 모두 리셋</div>
          </div>
        </>
      )}

      {/* ========== Tab: 배팅 전략 ========== */}
      {activeTab === 'strategy' && (
        <>
          {activeStructuredStrategy && (
            <div className="ams-strategy-owner" role="status">
              <div>
                <span className="ams-strategy-owner__eyebrow">현재 실행 기준</span>
                <strong>{activeStructuredStrategy.name}</strong>
                <p>
                  이 조건 전략이 배팅 방향, 단계, 각 단계의 1차·2차 금액을 직접 관리합니다.
                  아래 기본 배팅 전략은 중복 적용되지 않고 저장 상태로만 유지됩니다.
                </p>
              </div>
              {onOpenStrategyBuilder && (
                <button type="button" onClick={onOpenStrategyBuilder}>
                  조건 전략 편집
                </button>
              )}
            </div>
          )}

          <fieldset
            className="ams-strategy-fieldset"
            disabled={Boolean(activeStructuredStrategy)}
            aria-describedby={activeStructuredStrategy ? 'ams-structured-strategy-note' : undefined}
          >
            {activeStructuredStrategy && (
              <p id="ams-structured-strategy-note" className="ams-strategy-fieldset__note">
                조건 전략을 해제하면 아래 설정이 다시 실행 기준이 됩니다.
              </p>
            )}
          {/* 배팅 전략 선택 */}
          <div className="ams-section">
            <div className="ams-section-title">기본 배팅 전략</div>
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
                presets={PRESET_BET}
                onChange={(n) => onUpdateSettings({ baseBetAmount: n })}
              />
              <NumberFieldWithSuffix
                label="최대 단계"
                value={settings.maxMartin || 5}
                suffix="단계"
                min={1}
                max={100}
                presets={PRESET_STAGE}
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
          </fieldset>

          <div className="ams-section">
            <div className="ams-section-title">동시 배팅 제한</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="최대 동시 배팅 수"
                value={settings.maxConcurrentBets ?? 0}
                suffix="개"
                min={0}
                presets={PRESET_CONCURRENT}
                zeroLabel="제한 없음"
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
            <div className="ams-section-title">손익 제한 (멈춤 기준)</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="이익 도달 시 멈춤"
                value={settings.winCutAmount || 0}
                suffix="원"
                min={0}
                step={10000}
                presets={PRESET_CUT}
                zeroLabel="끄기"
                onChange={(n) => onUpdateSettings({ winCutAmount: n })}
              />
              <NumberFieldWithSuffix
                label="손실 도달 시 멈춤"
                value={settings.lossCutAmount || 0}
                suffix="원"
                min={0}
                step={10000}
                presets={PRESET_CUT}
                zeroLabel="끄기"
                onChange={(n) => onUpdateSettings({ lossCutAmount: n })}
              />
            </div>
            {(settings.lossCutAmount || 0) === 0 ? (
              <div className="ams-warning">
                ⚠️ 손실 제한이 꺼져있습니다. 손실이 무제한으로 커질 수 있어요. 잔액의 20~30% 정도를 권장합니다.
              </div>
            ) : (
              <div className="ams-hint">설정한 손실에 도달하면 자동으로 배팅이 멈춥니다.</div>
            )}
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
                presets={PRESET_STREAK}
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

      {/* ========== Tab: 수동 배팅 ========== */}
      {activeTab === 'manual' && (
        <>
          <div className="ams-section">
            <div className="ams-section-title">칩 액면 (트레이)</div>
            <div className="settings-field">
              <span className="settings-field__head"><span className="settings-field__label">칩 금액 목록 (쉼표로 구분, 최대 6개)</span></span>
              <span className="settings-field__input-wrap">
                <input
                  className="settings-field__input"
                  value={presetDraft}
                  onChange={(e) => setPresetDraft(e.target.value)}
                  onBlur={applyPresets}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyPresets() }}
                  aria-label="칩 금액 목록"
                />
                <span className="settings-field__suffix">원</span>
              </span>
              <span className="settings-field__presets">
                {[
                  { label: '1천·5천·1만·5만·10만', value: [1000, 5000, 10000, 50000, 100000] },
                  { label: '5천·1만·3만·5만·10만·30만', value: [5000, 10000, 30000, 50000, 100000, 300000] },
                  { label: '1만·2만·5만·10만·50만', value: [10000, 20000, 50000, 100000, 500000] },
                ].map((p) => (
                  <button key={p.label} type="button" className={`settings-field__preset ${p.value.join(',') === manual.chipPresets.join(',') ? 'is-active' : ''}`} onClick={() => { manual.setChipPresets(p.value); setPresetDraft(p.value.join(', ')) }}>
                    {p.label}
                  </button>
                ))}
              </span>
            </div>
            <div className="ams-hint">현재: {manual.chipPresets.map(n => n.toLocaleString()).join(' · ')}원</div>
          </div>

          <div className="ams-section">
            <div className="ams-section-title">마틴 따라가기</div>
            <div className="ams-toggle-row">
              <label className="ams-toggle-label">
                <input type="checkbox" checked={manual.followMartin} onChange={(e) => manual.setFollowMartin(e.target.checked)} />
                <span className="ams-toggle-text">방의 첫 칩을 그 방의 마틴 단계 금액으로 올리기</span>
              </label>
            </div>
            <div className="ams-hint">
              단계 금액은 '배팅 전략' 탭의 기본 배팅금·전략·최대 단계를 그대로 씁니다. 지면 다음 단계, 이기면 1단계, 최대 단계를 다 쓰면 1단계부터 다시.
              카드에 "마틴 n/최대단계 · 다음 금액"으로 보입니다.
            </div>
          </div>

          <div className="ams-section">
            <div className="ams-section-title">추천 방 기준</div>
            <div className="settings-field-row">
              <NumberFieldWithSuffix
                label="예측 신뢰도가 이 값 이상이면 '추천 방'"
                value={Math.round(manual.recommendConfidence * 100)}
                suffix="%"
                min={50}
                max={95}
                step={5}
                presets={PRESET_CONFIDENCE}
                onChange={(n) => manual.setRecommendConfidence(n / 100)}
              />
            </div>
            <div className="ams-hint">운영바의 '추천 방' 보기 필터와 카드의 추천 표시가 이 기준을 씁니다.</div>
          </div>

          <div className="ams-section">
            <div className="ams-section-title">수동 배팅 통계</div>
            <div className="settings-stat-grid">
              <StatCard label="손익" value={`${manual.stats.profit > 0 ? '+' : ''}${manual.stats.profit.toLocaleString()}`} tone={manual.stats.profit > 0 ? 'positive' : manual.stats.profit < 0 ? 'negative' : 'neutral'} />
              <StatCard label="승/패/무" value={`${manual.stats.wins} / ${manual.stats.losses} / ${manual.stats.ties}`} />
              <StatCard label="배팅 횟수" value={String(manual.stats.betCount)} />
              <StatCard label="총 배팅" value={manual.stats.totalBet.toLocaleString()} />
            </div>
            <div className="ams-data-actions" style={{ marginTop: 10 }}>
              <button className="ams-btn-outline" onClick={manual.resetStats}>수동 통계 초기화</button>
            </div>
            <div className="ams-hint">수동 배팅 손익도 가상/실제가 따로 쌓입니다(지금: {settings.isVirtualMode ? '가상' : '실제'}).</div>
          </div>
        </>
      )}

      {/* ========== Tab: 방·필터 ========== */}
      {activeTab === 'rooms' && (
        <>
          <div className="ams-section">
            <div className="ams-section-title">배팅 대상</div>
            <div className="ams-entry-grid">
              <button type="button" className="ams-entry-card" onClick={onOpenRoomSelector} disabled={!onOpenRoomSelector}>
                <span className="ams-entry-card__title">배팅할 방</span>
                <span className="ams-entry-card__value">
                  {selectedRoomCount > 0 ? `${selectedRoomCount} / ${totalRoomCount}방` : `전체 ${totalRoomCount}방`}
                </span>
                <span className="ams-entry-card__desc">
                  {selectedRoomCount > 0 ? '선택한 방에서만 배팅합니다.' : '방을 고르지 않으면 필터에 맞는 모든 방이 대상입니다.'}
                </span>
                <span className="ams-entry-card__cta">방 고르기 →</span>
              </button>
              <button type="button" className="ams-entry-card" onClick={onOpenFilterDialog} disabled={!onOpenFilterDialog}>
                <span className="ams-entry-card__title">진입 조건(필터)</span>
                <span className="ams-entry-card__value">{activeFilterLabel}</span>
                <span className="ams-entry-card__desc">타이 자동·커스텀 전략·패턴 필터와 필터별 방향·기준값을 정합니다.</span>
                <span className="ams-entry-card__cta">필터 설정 →</span>
              </button>
              {onOpenPatternManager && (
                <button type="button" className="ams-entry-card" onClick={onOpenPatternManager}>
                  <span className="ams-entry-card__title">커스텀 패턴</span>
                  <span className="ams-entry-card__value">B/P 순서</span>
                  <span className="ams-entry-card__desc">원하는 결과 순서(예: BBP)가 뜨면 정한 방향으로 배팅합니다.</span>
                  <span className="ams-entry-card__cta">패턴 관리 →</span>
                </button>
              )}
            </div>
            <div className="ams-hint">
              방과 필터는 언제든 바꿀 수 있고, 진행 중인 마틴 방은 승리할 때까지 대상에 남습니다.
            </div>
          </div>

          <div className="ams-section">
            <div className="ams-section-title">방 선택 방식</div>
            <div className="ams-toggle-row">
              <label className="ams-toggle-label">
                <input
                  type="checkbox"
                  checked={settings.onlySelectedRooms ?? false}
                  onChange={(e) => onUpdateSettings({ onlySelectedRooms: e.target.checked })}
                />
                <span className="ams-toggle-text">선택한 방만 화면에 표시</span>
              </label>
            </div>
            <div className="ams-hint">끄면 전체 방이 보이고, 선택한 방은 배팅 대상으로만 쓰입니다.</div>
          </div>
        </>
      )}
    </SettingsDialogFrame>
  )
}
