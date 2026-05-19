// AutoMode 서비스 모듈 인덱스
// Clean Architecture: Application Layer
// 2000+ lines의 AutoModeService를 SRP에 따라 분해

// ==================== Types ====================
export * from './types'

// ==================== Managers ====================
export {
  MartingaleManager,
  getMartingaleManager,
  resetMartingaleManager,
  type IMartingaleManager,
} from './MartingaleManager'

// ==================== Services ====================
export {
  BettingDecisionService,
  createBettingDecisionService,
  type IBettingDecisionService,
} from './BettingDecisionService'

export {
  ResultProcessor,
  createResultProcessor,
  type IResultProcessor,
} from './ResultProcessor'

export {
  PatternPredictionService,
  createPatternPredictionService,
  type IPatternPredictionService,
  type PatternMatch,
  type PatternPredictionConfig,
} from './PatternPredictionService'

// ==================== Orchestrator ====================
export {
  AutoModeOrchestrator,
  getAutoModeOrchestrator,
  resetAutoModeOrchestrator,
  type IAutoModeOrchestrator,
} from './AutoModeOrchestrator'

// ==================== Repository ====================
export {
  LocalStorageAutoModeRepository,
  getAutoModeRepository,
  setAutoModeRepository,
  resetAutoModeRepository,
  type IAutoModeRepository,
} from './AutoModeRepository'
