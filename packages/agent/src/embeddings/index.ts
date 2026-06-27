// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export {
    resolveEmbeddingAdapter,
    resolveEmbeddingAdapterFromEnv,
    resolveEmbeddingAdapterAsync,
    checkDimensionCompatibility,
    checkProviderLineage,
    type EmbeddingRouterResult,
    type EmbeddingResolution,
    type DimensionCheck,
    type EmbeddingAdapter,
} from './router.js'

export {
    HashEmbeddingAdapter,
    GatewayEmbeddingAdapter,
    type EmbeddingProviderStatus,
    EMBEDDING_CAPABLE_PROVIDERS,
    EMBEDDING_INCAPABLE_PROVIDERS,
    DEFAULT_EMBEDDING_MODELS,
} from './adapters.js'
