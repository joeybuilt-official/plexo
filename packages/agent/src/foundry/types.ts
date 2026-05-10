// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export interface TrainingJobConfig {
    domainBucket: string
    baseModel: string
    trainingData: Array<{ input: string; output: string }>
    hyperparams?: Record<string, unknown>
}

export interface TrainingJobStatus {
    status: 'pending' | 'running' | 'completed' | 'failed'
    progress?: number
    error?: string
}

/**
 * Training provider interface — swappable between Together AI, Fireworks, Modal, etc.
 */
export interface TrainingProvider {
    name: string
    submitJob(config: TrainingJobConfig): Promise<string> // returns job ID
    checkStatus(jobId: string): Promise<TrainingJobStatus>
    getModelId(jobId: string): Promise<string> // returns deployable model ID
}

export interface BucketStats {
    domainBucket: string
    exampleCount: number
    hasModel: boolean
    modelStatus?: string
    lastTrainedExamples?: number
}

export const FOUNDRY_DEFAULTS = {
    MIN_TRAINING_THRESHOLD: 2000,
    RETRAIN_INCREMENT: 2000,
    SHADOW_MIN_COMPARISONS: 100,
    PROMOTION_THRESHOLD: 0.90,
    BASE_MODEL: 'meta-llama/Llama-3.2-3B-Instruct',
} as const
