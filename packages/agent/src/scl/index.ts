// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export { classifyDomainRegion, classifyInferenceLog, DOMAIN_REGIONS, type DomainRegion } from './classifier.js'
export { extractSclS, extractAndStoreSclS, type SclSGraph, type CompletedTaskMeta } from './extractor.js'
export { compressToMindsetObject, mergeMindsetObject } from './compressor.js'
export { expandMindsetObject, type ExpansionStimulus } from './expander.js'
export type { MindsetObject, MindsetRegion, ConceptAttractor, TransformationRule, ExpandedContext } from './types.js'
