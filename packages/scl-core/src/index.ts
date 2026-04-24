// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export { boot } from './boot.js'
export { expand } from './expand.js'
export { mutate } from './mutate.js'
export { archive } from './archive.js'
export { resolveDrift } from './drift.js'
export { checkPromotions } from './promote.js'
export { splitRegion, autoSplit, SPLIT_THRESHOLD } from './split.js'
export { OpenAIEmbeddingProvider } from './embeddings/index.js'
export { cosineSimilarity, weightedAverage, centroid, euclideanDistance, magnitude } from './utils/vector.js'
export { generateId } from './utils/id.js'
export { DEFAULT_CONFIG, resolveConfig } from './config.js'
export type { SCLConfig } from './config.js'
export type {
    DepthClass, ResolutionLevel, ConceptType, RelationType, Modality,
    ConceptAttractor, DomainRegion, TransformationRule, LedgerPointer,
    GoldenRecord, ExpandRequest, ExpandedNode, ExpandedEdge, ExpansionResult,
    MutationInput, DriftWarning, MutationResult, BootConfig, EmbeddingProvider,
} from './types.js'
