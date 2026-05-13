// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export { getBucketStats, checkEligibility, createFoundryModel } from './bucket-monitor.js'
export { extractTrainingData, submitTrainingJob, pollTrainingStatus } from './training.js'
export { logShadowComparison } from './shadow.js'
export { checkPromotionCandidates, promoteModel, retireModel } from './promotion.js'
export { FOUNDRY_DEFAULTS } from './types.js'
export type { TrainingProvider, TrainingJobConfig, TrainingJobStatus, BucketStats } from './types.js'
