// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Errors that warrant skipping a workspace-pinned model and degrading to the
 * provider-agnostic router cascade: structured-output/parse failures, quota/
 * rate-limit, auth/missing-key, timeouts, network and provider-resolution
 * errors — a pin at a disabled/unkeyed/exhausted provider must never dead-end.
 *
 * Dep-free leaf shared by executor/quality-judge.ts (pinned judge) and
 * session-fabric/router-model-client.ts (pinned judging client) so this
 * error-classification policy can't silently drift between them.
 */
export const PIN_SKIPPABLE_ERROR =
    /json_schema|response format|structured|No object generated|JSON parsing failed|credit balance|insufficient_quota|rate.?limit|quota|tpd|401|403|invalid.?api.?key|authentication|unauthorized|x-api-key|missing.+key|no api key|429|ENOTFOUND|fetch failed|CALL_MODEL_TIMEOUT|CALL_MODEL_PARSE|NO_PROVIDER_AVAILABLE|ProviderResolutionError/i
