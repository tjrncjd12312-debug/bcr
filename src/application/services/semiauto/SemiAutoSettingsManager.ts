// Clean Architecture: Import domain entities
import {
    type SemiAutoSettings,
    type PatternBetConfig,
    type RoomBetConfig,
    type RoomFilterType,
    type PatternBetDirection,
    DEFAULT_SEMI_AUTO_SETTINGS,
    DEFAULT_PATTERN_CONFIGS,
} from '../../../domain/entities'

// Re-export for backward compatibility
export type { SemiAutoSettings, PatternBetConfig, RoomBetConfig }
export const DEFAULT_SETTINGS = DEFAULT_SEMI_AUTO_SETTINGS

// localStorage key for settings persistence
const SETTINGS_STORAGE_KEY = 'bcr-multiroom-settings'

export class SemiAutoSettingsManager {
    private settings: SemiAutoSettings

    constructor(initialSettings?: Partial<SemiAutoSettings>) {
        // 1. Try to load from localStorage
        const saved = this.loadFromStorage()
        // 2. Merge with defaults and initial settings (initialSettings takes precedence)
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...saved,
            ...initialSettings,
            // ⚠️ CRITICAL: Always start disabled - never auto-start from saved state
            // This prevents the bug where auto betting starts without user action
            enabled: false,
            // Ensure patternConfigs is properly merged
            patternConfigs: this.mergePatternConfigs(
                DEFAULT_SETTINGS.patternConfigs,
                saved?.patternConfigs,
                initialSettings?.patternConfigs
            ),
        }
        // Save merged settings to ensure consistency
        if (saved) {
            this.saveToStorage()
        }
    }

    /**
     * Merge pattern configs from multiple sources
     */
    private mergePatternConfigs(
        defaults: PatternBetConfig[],
        saved?: PatternBetConfig[],
        initial?: PatternBetConfig[]
    ): PatternBetConfig[] {
        // Start with defaults
        const result = new Map<RoomFilterType, PatternBetConfig>()
        defaults.forEach(c => result.set(c.patternType, { ...c }))

        // Apply saved configs
        if (saved) {
            saved.forEach(c => {
                if (result.has(c.patternType)) {
                    result.set(c.patternType, { ...result.get(c.patternType)!, ...c })
                } else {
                    result.set(c.patternType, { ...c })
                }
            })
        }

        // Apply initial overrides
        if (initial) {
            initial.forEach(c => {
                if (result.has(c.patternType)) {
                    result.set(c.patternType, { ...result.get(c.patternType)!, ...c })
                } else {
                    result.set(c.patternType, { ...c })
                }
            })
        }

        return Array.from(result.values())
    }

    /**
     * Load settings from localStorage
     */
    private loadFromStorage(): Partial<SemiAutoSettings> | null {
        try {
            const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
            if (!stored) return null
            const parsed = JSON.parse(stored)
            console.log('[SemiAutoSettings] Loaded from storage:', Object.keys(parsed))
            return parsed
        } catch (e) {
            console.warn('[SemiAutoSettings] Failed to load from storage:', e)
            return null
        }
    }

    /**
     * Save settings to localStorage
     */
    private saveToStorage(): void {
        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings))
        } catch (e) {
            console.warn('[SemiAutoSettings] Failed to save to storage:', e)
        }
    }

    getSettings(): SemiAutoSettings {
        return { ...this.settings }
    }

    updateSettings(newSettings: Partial<SemiAutoSettings>): void {
        this.settings = { ...this.settings, ...newSettings }
        this.saveToStorage()  // Auto-save on every update
    }

    isEnabled(): boolean {
        return this.settings.enabled
    }

    setEnabled(enabled: boolean): void {
        this.settings.enabled = enabled
        this.saveToStorage()
    }

    // Helper getters for common settings (with defaults for legacy optional fields)
    get autoFindRoom(): boolean { return this.settings.autoFindRoom ?? false }
    get continuousSearch(): boolean { return this.settings.continuousSearch ?? false }
    get skipFirstRound(): boolean { return this.settings.skipFirstRound ?? false }
    // ✅ FIX: winThreshold 기본값을 0으로 변경 (0 = 무제한, 방이동 안함)
    get winThreshold(): number { return this.settings.winThreshold ?? 0 }
    get lossThreshold(): number { return this.settings.lossThreshold ?? 0 }
    get maxMartin(): number { return this.settings.maxMartin }
    get minHistoryLength(): number { return this.settings.minHistoryLength ?? 10 }
    get baseUrl(): string { return this.settings.baseUrl }
    get useAiPrediction(): boolean { return this.settings.useAiPrediction }
    get autoBetting(): boolean { return this.settings.autoBetting }

    // ==================== Room Round Limits (Fixed Values) ====================
    /** 최소 라운드 수 (고정값 5) - 5라운드 미만 방은 제외 */
    get minRounds(): number { return 5 }
    /** 최대 라운드 수 (고정값 35) - 35라운드 초과 방은 제외 */
    get maxRounds(): number { return 35 }

    // ==================== Room Config Methods ====================

    /**
     * 방이 활성화되어 있는지 확인
     * roomConfigs가 비어있으면 모든 방 활성화
     */
    isRoomEnabled(roomId: string): boolean {
        if (this.settings.roomConfigs.length === 0) return true
        const config = this.settings.roomConfigs.find(c => c.roomId === roomId)
        return config?.enabled ?? false
    }

    /**
     * 방 활성화/비활성화 토글
     */
    toggleRoom(roomId: string, enabled: boolean): void {
        const existingIndex = this.settings.roomConfigs.findIndex(c => c.roomId === roomId)
        if (existingIndex >= 0) {
            this.settings.roomConfigs[existingIndex].enabled = enabled
        } else {
            this.settings.roomConfigs.push({
                roomId,
                enabled,
                maxConsecutiveLosses: this.settings.globalMaxConsecutiveLosses,
            })
        }
        this.saveToStorage()
    }

    /**
     * 방 설정 업데이트
     */
    updateRoomConfig(roomId: string, config: Partial<RoomBetConfig>): void {
        const existingIndex = this.settings.roomConfigs.findIndex(c => c.roomId === roomId)
        if (existingIndex >= 0) {
            this.settings.roomConfigs[existingIndex] = {
                ...this.settings.roomConfigs[existingIndex],
                ...config,
            }
        } else {
            this.settings.roomConfigs.push({
                roomId,
                enabled: config.enabled ?? true,
                maxConsecutiveLosses: config.maxConsecutiveLosses ?? this.settings.globalMaxConsecutiveLosses,
                currentRestUntil: config.currentRestUntil,
            })
        }
        this.saveToStorage()
    }

    /**
     * 방이 휴식 중인지 확인 (연패로 인한 휴식)
     */
    isRoomResting(roomId: string): boolean {
        const config = this.settings.roomConfigs.find(c => c.roomId === roomId)
        if (!config?.currentRestUntil) return false
        return Date.now() < config.currentRestUntil
    }

    /**
     * 방 휴식 설정 (연패 발생시 호출)
     */
    setRoomResting(roomId: string): void {
        const restDurationMs = this.settings.restDurationMinutes * 60 * 1000
        this.updateRoomConfig(roomId, {
            currentRestUntil: Date.now() + restDurationMs,
        })
    }

    /**
     * 방 휴식 해제
     */
    clearRoomRest(roomId: string): void {
        this.updateRoomConfig(roomId, {
            currentRestUntil: undefined,
        })
    }

    /**
     * 방의 연패 휴식 기준 가져오기
     */
    getRoomMaxLosses(roomId: string): number {
        const config = this.settings.roomConfigs.find(c => c.roomId === roomId)
        return config?.maxConsecutiveLosses ?? this.settings.globalMaxConsecutiveLosses
    }

    // ==================== Pattern Config Methods ====================

    /**
     * 패턴별 배팅 방향 가져오기
     */
    getPatternBetDirection(patternType: RoomFilterType): PatternBetDirection {
        const config = this.settings.patternConfigs.find(c => c.patternType === patternType)
        return config?.betDirection ?? 'ai'
    }

    /**
     * 패턴 설정 활성화 여부
     */
    isPatternEnabled(patternType: RoomFilterType): boolean {
        const config = this.settings.patternConfigs.find(c => c.patternType === patternType)
        return config?.enabled ?? true
    }

    /**
     * 패턴에 타이 포함 여부
     */
    patternIncludesTie(patternType: RoomFilterType): boolean {
        const config = this.settings.patternConfigs.find(c => c.patternType === patternType)
        return config?.includeTie ?? false
    }

    /**
     * 패턴 설정 업데이트
     */
    updatePatternConfig(patternType: RoomFilterType, config: Partial<PatternBetConfig>): void {
        const existingIndex = this.settings.patternConfigs.findIndex(c => c.patternType === patternType)
        if (existingIndex >= 0) {
            this.settings.patternConfigs[existingIndex] = {
                ...this.settings.patternConfigs[existingIndex],
                ...config,
            }
        } else {
            this.settings.patternConfigs.push({
                patternType,
                betDirection: config.betDirection ?? 'ai',
                includeTie: config.includeTie ?? false,
                enabled: config.enabled ?? true,
            })
        }
        this.saveToStorage()
    }

    /**
     * 패턴 설정 초기화
     */
    resetPatternConfigs(): void {
        this.settings.patternConfigs = [...DEFAULT_PATTERN_CONFIGS]
        this.saveToStorage()
    }

    /**
     * 모든 활성화된 방 목록 가져오기
     */
    getEnabledRoomIds(): string[] {
        // roomConfigs가 비어있으면 빈 배열 (모든 방 활성화 상태)
        if (this.settings.roomConfigs.length === 0) return []
        return this.settings.roomConfigs
            .filter(c => c.enabled)
            .map(c => c.roomId)
    }
}
