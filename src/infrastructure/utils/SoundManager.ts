// SoundManager - Play notification sounds for semi-auto mode
// Uses Web Audio API for reliable playback across rounds
// Sound files are located in public/sound/
//
// IMPORTANT: Call init() on first user interaction (click) to enable audio

type SoundType = 'banker' | 'player' | 'move' | 'data' | 'tie'

// 디버그 로그 (개발 모드에서만 출력)
const DEBUG = import.meta.env?.DEV || false
const log = (msg: string, ...args: unknown[]) => {
  if (DEBUG) console.log(`[SoundManager] ${msg}`, ...args)
}
const warn = (msg: string, ...args: unknown[]) => {
  if (DEBUG) console.warn(`[SoundManager] ${msg}`, ...args)
}

class SoundManagerImpl {
  private enabled = true
  private basePath = '/sound/'
  private volume = 0.7
  private audioContext: AudioContext | null = null
  private audioBuffers: Map<SoundType, AudioBuffer> = new Map()
  private isLoading = false
  private loadPromise: Promise<void> | null = null
  private isInitialized = false

  /**
   * Initialize AudioContext on user interaction (click/tap)
   * MUST be called from a user gesture event handler
   */
  async init(): Promise<void> {
    if (this.isInitialized && this.audioContext?.state === 'running') {
      log('Already initialized, state:', this.audioContext?.state)
      return
    }

    try {
      const ctx = this.getAudioContext()
      log('AudioContext state before init:', ctx.state)

      // Resume if suspended - this will work because it's called from user gesture
      if (ctx.state === 'suspended') {
        await ctx.resume()
        log('AudioContext resumed, new state:', ctx.state)
      }

      this.isInitialized = true
      log('Initialized successfully')

      // Preload sounds after init
      this.preload()
    } catch (e) {
      warn('Init failed:', e)
    }
  }

  /**
   * Get or create AudioContext
   */
  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    }
    return this.audioContext
  }

  /**
   * Resume AudioContext if suspended (browser autoplay policy)
   */
  private async resumeContext(): Promise<void> {
    const ctx = this.getAudioContext()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // Ignore resume errors
      }
    }
  }

  /**
   * Load a single audio file into buffer
   */
  private async loadSound(type: SoundType): Promise<void> {
    if (this.audioBuffers.has(type)) return

    try {
      const response = await fetch(`${this.basePath}${type}.wav`)
      if (!response.ok) return

      const arrayBuffer = await response.arrayBuffer()
      const ctx = this.getAudioContext()

      // Only decode if context is running
      if (ctx.state === 'running') {
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        this.audioBuffers.set(type, audioBuffer)
      } else {
        // Store raw array buffer for later decoding
        this.pendingBuffers.set(type, arrayBuffer)
      }
    } catch {
      // Silent fail - sound will just not play
    }
  }

  // Store raw buffers when context is not ready
  private pendingBuffers: Map<SoundType, ArrayBuffer> = new Map()

  /**
   * Decode pending buffers after context is resumed
   */
  private async decodePendingBuffers(): Promise<void> {
    const ctx = this.getAudioContext()
    if (ctx.state !== 'running') return

    for (const [type, arrayBuffer] of this.pendingBuffers) {
      if (!this.audioBuffers.has(type)) {
        try {
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
          this.audioBuffers.set(type, audioBuffer)
        } catch {
          // Silent fail
        }
      }
    }
    this.pendingBuffers.clear()
  }

  /**
   * Enable or disable sound playback
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * Check if sound is enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Play a sound by type using Web Audio API
   * 초기화 전이거나 AudioContext 상태가 좋지 않으면 HTML Audio fallback 사용
   */
  play(type: SoundType): void {
    if (!this.enabled) {
      log('Play blocked - sound disabled')
      return
    }

    log('Playing:', type, '| initialized:', this.isInitialized, '| context state:', this.audioContext?.state)

    // 🔥 FIX: AudioContext가 suspended면 resume 시도 후 재생
    if (this.audioContext?.state === 'suspended') {
      log('AudioContext suspended, attempting resume before play')
      this.audioContext.resume()
        .then(() => {
          log('AudioContext resumed, now playing:', type)
          this.playAsync(type).catch(() => this.playFallback(type))
        })
        .catch(() => {
          log('Resume failed, using fallback:', type)
          this.playFallback(type)
        })
      return
    }

    // 초기화 안 됐으면 fallback 사용
    if (!this.isInitialized) {
      log('Not initialized, using fallback:', type)
      this.playFallback(type)
      return
    }

    // Fire and forget - don't block, fallback on failure
    this.playAsync(type).catch((e) => {
      warn('Play failed, using fallback:', type, e)
      this.playFallback(type)
    })
  }

  /**
   * Async play implementation
   */
  private async playAsync(type: SoundType): Promise<void> {
    try {
      // Ensure context is resumed
      await this.resumeContext()

      // Decode pending buffers if context is now running
      if (this.pendingBuffers.size > 0) {
        await this.decodePendingBuffers()
      }

      // Load sound if not cached
      if (!this.audioBuffers.has(type)) {
        log('Loading sound:', type)
        await this.loadSound(type)
        // Try to decode again if it was pending
        if (this.pendingBuffers.has(type)) {
          await this.decodePendingBuffers()
        }
      }

      const buffer = this.audioBuffers.get(type)
      if (!buffer) {
        // Still no buffer - use fallback
        warn('No buffer for:', type, '- using fallback')
        this.playFallback(type)
        return
      }

      const ctx = this.getAudioContext()

      // Verify context is running
      if (ctx.state !== 'running') {
        warn('Context not running:', ctx.state, '- using fallback')
        this.playFallback(type)
        return
      }

      // Create new source node for each play
      const source = ctx.createBufferSource()
      source.buffer = buffer

      // Create gain node for volume control
      const gainNode = ctx.createGain()
      gainNode.gain.value = this.volume

      // Connect: source -> gain -> destination
      source.connect(gainNode)
      gainNode.connect(ctx.destination)

      // Play immediately
      source.start(0)
      log('Sound played via Web Audio API:', type)
    } catch (e) {
      // Fallback to HTML Audio API
      warn('Web Audio failed, trying fallback:', type, e)
      this.playFallback(type)
    }
  }

  /**
   * Fallback to HTML Audio API
   */
  private playFallback(type: SoundType): void {
    try {
      const audio = new Audio(`${this.basePath}${type}.wav`)
      audio.volume = this.volume
      audio.play()
        .then(() => log('Fallback played successfully:', type))
        .catch((e) => warn('Fallback play failed:', type, e))
    } catch (e) {
      warn('Fallback creation failed:', type, e)
    }
  }

  /**
   * Play prediction sound based on prediction type
   */
  playPrediction(prediction: 'B' | 'P' | null): void {
    log('playPrediction called with:', prediction)
    if (prediction === 'B') {
      this.play('banker')
    } else if (prediction === 'P') {
      this.play('player')
    } else {
      log('Prediction not B or P, skipping sound')
    }
  }

  /**
   * Play room move sound
   */
  playMove(): void {
    this.play('move')
  }

  /**
   * Play data/notification sound
   */
  playData(): void {
    this.play('data')
  }

  /**
   * Play tie sound
   */
  playTie(): void {
    this.play('tie')
  }

  /**
   * Preload all sounds into AudioBuffers
   */
  preload(): void {
    if (this.isLoading || this.loadPromise) return

    this.isLoading = true
    const types: SoundType[] = ['banker', 'player', 'move', 'data', 'tie']

    this.loadPromise = Promise.all(types.map(type => this.loadSound(type)))
      .then(() => {
        this.isLoading = false
      })
      .catch(() => {
        this.isLoading = false
      })
  }

  /**
   * 완전한 리소스 해제 (앱 종료 또는 재초기화 시 사용)
   * AudioContext를 닫고 모든 버퍼를 정리
   */
  async dispose(): Promise<void> {
    log('Disposing SoundManager...')

    // 1. AudioContext 닫기 (메모리 해제)
    if (this.audioContext) {
      try {
        // close()는 모든 오디오 처리를 중지하고 리소스 해제
        await this.audioContext.close()
        log('AudioContext closed')
      } catch (e) {
        warn('Failed to close AudioContext:', e)
      }
      this.audioContext = null
    }

    // 2. 버퍼 정리
    this.audioBuffers.clear()
    this.pendingBuffers.clear()

    // 3. 상태 초기화
    this.isInitialized = false
    this.isLoading = false
    this.loadPromise = null

    log('SoundManager disposed')
  }

  /**
   * 재초기화 (dispose 후 다시 사용할 때)
   * dispose() 후 다시 사운드를 사용하려면 이 메서드 호출
   */
  async reinitialize(): Promise<void> {
    // 기존 리소스가 있으면 정리
    if (this.audioContext) {
      await this.dispose()
    }

    // 새로 초기화
    await this.init()
  }
}

export const SoundManager = new SoundManagerImpl()
export default SoundManager
