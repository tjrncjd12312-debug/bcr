// StartWizard — 통합 디자인시스템: 자동맡기기 시작 마법사(한 번 탭 시작 차단, 의도적 마찰)
// 리디자인 4단계. 1.방 고르기 → 2.금액·한도 → 3.확인. 평문 요약 + 구체 동작 라벨('자동 배팅 시작').
// '확인'·'계속' 금지. 위험 옵션엔 인라인 한글 경고. 순수 표현(콜백으로 config 전달).
import { useState } from 'react'
import './StartWizard.css'

export interface WizardRoom {
  id: string
  name: string
  lastResult: 'B' | 'P' | 'T' | null
}

export interface AutoStartConfig {
  autoPick: boolean
  roomIds: string[]
  baseBet: number
  winCut: number
  lossCut: number
  strategy: 'martin' | 'fixed'
  isReal: boolean
}

interface StartWizardProps {
  rooms: WizardRoom[]
  defaultConfig?: Partial<AutoStartConfig>
  formatCurrency?: (n: number) => string
  onCancel: () => void
  onStart: (config: AutoStartConfig) => void
  className?: string
}

const WINNER_KO: Record<string, string> = { B: '뱅커', P: '플레이어', T: '타이' }
const defaultFormat = (n: number) => `${n.toLocaleString()}원`

function Stepper({ value, step, min, onChange, format }: {
  value: number; step: number; min: number; onChange: (v: number) => void; format: (n: number) => string
}) {
  return (
    <div className="wizard__stepper">
      <button type="button" aria-label="줄이기" onClick={() => onChange(Math.max(min, value - step))}>－</button>
      <span className="wizard__stepper-value">{format(value)}</span>
      <button type="button" aria-label="늘리기" onClick={() => onChange(value + step)}>＋</button>
    </div>
  )
}

export function StartWizard({
  rooms,
  defaultConfig,
  formatCurrency = defaultFormat,
  onCancel,
  onStart,
  className = '',
}: StartWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [autoPick, setAutoPick] = useState(defaultConfig?.autoPick ?? true)
  const [selected, setSelected] = useState<Set<string>>(new Set(defaultConfig?.roomIds ?? []))
  const [baseBet, setBaseBet] = useState(defaultConfig?.baseBet ?? 10000)
  const [winCut, setWinCut] = useState(defaultConfig?.winCut ?? 100000)
  const [lossCut, setLossCut] = useState(defaultConfig?.lossCut ?? 100000)
  const [strategy, setStrategy] = useState<'martin' | 'fixed'>(defaultConfig?.strategy ?? 'martin')
  const [isReal, setIsReal] = useState(defaultConfig?.isReal ?? false)

  const toggleRoom = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const roomCount = autoPick ? '추천' : `${selected.size}개`

  const finish = () => {
    onStart({
      autoPick,
      roomIds: Array.from(selected),
      baseBet,
      winCut,
      lossCut,
      strategy,
      isReal,
    })
  }

  return (
    <div className={`wizard ${className}`}>
      <ol className="wizard__steps" aria-label="진행 단계">
        {[1, 2, 3].map((s) => (
          <li key={s} className={`wizard__step ${step === s ? 'is-current' : ''} ${step > s ? 'is-done' : ''}`}>
            <span className="wizard__step-dot" aria-hidden="true">{step > s ? '●' : s}</span>
            <span className="wizard__step-label">{s === 1 ? '방 고르기' : s === 2 ? '금액·한도' : '확인'}</span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="wizard__body">
          <h2 className="wizard__title">어떤 방을 맡기시겠어요?</h2>
          <label className="wizard__radio">
            <input type="radio" name="pick" checked={autoPick} onChange={() => setAutoPick(true)} />
            <span>제가 좋은 방을 알아서 고를게요 <em>(추천)</em></span>
          </label>
          <label className="wizard__radio">
            <input type="radio" name="pick" checked={!autoPick} onChange={() => setAutoPick(false)} />
            <span>내가 직접 방을 고를게요</span>
          </label>

          {!autoPick && (
            <div className="wizard__rooms">
              {rooms.map((r) => (
                <label key={r.id} className={`wizard__room ${selected.has(r.id) ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRoom(r.id)} />
                  <span className="wizard__room-name">{r.name}</span>
                  <span className="wizard__room-last">
                    마지막 {r.lastResult ? WINNER_KO[r.lastResult] : '—'}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="wizard__body">
          <h2 className="wizard__title">한 번에 얼마씩 거시겠어요?</h2>
          <div className="wizard__field">
            <span className="wizard__field-label">한 번에 거는 돈</span>
            <Stepper value={baseBet} step={10000} min={1000} onChange={setBaseBet} format={formatCurrency} />
          </div>
          <h2 className="wizard__title">언제 멈출까요?</h2>
          <div className="wizard__field">
            <span className="wizard__field-label">이만큼 따면 멈춤 (목표)</span>
            <Stepper value={winCut} step={50000} min={0} onChange={setWinCut} format={formatCurrency} />
          </div>
          <div className="wizard__field">
            <span className="wizard__field-label">이만큼 잃으면 멈춤 (손절)</span>
            <Stepper value={lossCut} step={50000} min={0} onChange={setLossCut} format={formatCurrency} />
          </div>
          <div className="wizard__field wizard__field--col">
            <span className="wizard__field-label">따라가기 방식</span>
            <label className="wizard__radio">
              <input type="radio" name="strategy" checked={strategy === 'martin'} onChange={() => setStrategy('martin')} />
              <span>잃으면 다음에 늘림 (마틴)</span>
            </label>
            <label className="wizard__radio">
              <input type="radio" name="strategy" checked={strategy === 'fixed'} onChange={() => setStrategy('fixed')} />
              <span>항상 같은 금액</span>
            </label>
            {strategy === 'martin' && (
              <p className="wizard__warn">잃으면 다음 판에 더 크게 거는 방식이에요. 위험할 수 있어요.</p>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="wizard__body">
          <h2 className="wizard__title">이대로 시작할까요?</h2>
          <ul className="wizard__summary">
            <li>방 {roomCount}에서 자동으로 배팅합니다.</li>
            <li>한 번에 {formatCurrency(baseBet)}씩</li>
            <li>{formatCurrency(winCut)} 따면 멈춥니다</li>
            <li>{formatCurrency(lossCut)} 잃으면 멈춥니다</li>
          </ul>
          <div className="wizard__mode">
            <span className={`wizard__mode-chip ${isReal ? 'is-real' : 'is-virtual'}`}>
              {isReal ? '실제 배팅' : '연습 모드'}
            </span>
            {isReal ? (
              <span className="wizard__mode-note wizard__mode-note--real">진짜 돈이 걸립니다.</span>
            ) : (
              <span className="wizard__mode-note">진짜 돈은 걸리지 않아요.</span>
            )}
            <button type="button" className="wizard__mode-toggle" onClick={() => setIsReal((v) => !v)}>
              {isReal ? '연습 모드로 바꾸기' : '진짜 돈으로 하려면 여기 ▸'}
            </button>
          </div>
        </div>
      )}

      <div className="wizard__nav">
        {step > 1 ? (
          <button type="button" className="wizard__back" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
            ← 이전
          </button>
        ) : (
          <button type="button" className="wizard__back" onClick={onCancel}>
            취소
          </button>
        )}
        {step < 3 ? (
          <button type="button" className="wizard__next" onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>
            다음 →
          </button>
        ) : (
          <button type="button" className={`wizard__start ${isReal ? 'is-real' : ''}`} onClick={finish}>
            {isReal ? '진짜 돈으로 자동 배팅 시작' : '자동 배팅 시작'}
          </button>
        )}
      </div>
    </div>
  )
}

export default StartWizard
