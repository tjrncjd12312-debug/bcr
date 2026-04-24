export class SemiAutoStatsManager {
    private _martin: number = 0
    private _displayMartin: number = 0
    private _winCount: number = 0
    private _totalWins: number = 0
    private _totalLosses: number = 0

    // First round logic state
    private _isFirstRound: boolean = true
    private _firstRoundBettingCount: number = 0

    constructor() { }

    // Getters
    get martin(): number { return this._martin }
    get displayMartin(): number { return this._displayMartin }
    get winCount(): number { return this._winCount }
    get totalWins(): number { return this._totalWins }
    get totalLosses(): number { return this._totalLosses }
    get isFirstRound(): boolean { return this._isFirstRound }
    get firstRoundBettingCount(): number { return this._firstRoundBettingCount }

    // Setters
    set isFirstRound(value: boolean) { this._isFirstRound = value }

    // Actions
    resetRoomStats(keepTotalStats: boolean = true): void {
        this._martin = 0
        this._displayMartin = 0
        this._winCount = 0
        this._firstRoundBettingCount = 0
        if (!keepTotalStats) {
            this._totalWins = 0
            this._totalLosses = 0
        }
    }

    incrementMartin(): void {
        this._martin++
        this._displayMartin = this._martin
    }

    resetMartin(): void {
        this._martin = 0
    }

    recordWin(): void {
        this._winCount++
        this._totalWins++
        this._martin = 0 // Win resets martin
        this._displayMartin = 0
    }

    recordLoss(): void {
        this._totalLosses++
        this._martin++
        this._displayMartin = this._martin
    }

    incrementFirstRoundBettingCount(): void {
        this._firstRoundBettingCount++
    }

    resetFirstRoundBettingCount(): void {
        this._firstRoundBettingCount = 0
    }

    getSnapshot() {
        return {
            martin: this._martin,
            displayMartin: this._displayMartin,
            winCount: this._winCount,
            totalWins: this._totalWins,
            totalLosses: this._totalLosses,
            isFirstRound: this._isFirstRound
        }
    }
}
