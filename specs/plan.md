# Spec: Multi-Model Logic Verification & Graceful Fallback (Automated)

## Why
Currently, Plexo relies on static, manually configured default models and only falls back when encountering API-level errors (rate limits, 503s). It lacks resilience to LLM hallucination or bad formatting, leading to complete task failures. To achieve "multiple nines" of logical correctness and automatically adapt to the fast-moving AI landscape, Plexo needs an Automated Knowledge Refresh (AKR) pipeline for model capabilities, along with a Consultative Semantic Router and a deterministic Actor/Evaluator executor fallback.

## How

### Phase 1: Dynamic Knowledge Base (`models_knowledge`)
- Define a new DB table `models_knowledge` inside `packages/db/src/schema.ts` holding:
  - `id`, `provider`, `modelId`
  - `contextWindow` (int)
  - `costPerMIn` / `costPerMOut` (numeric)
  - `strengths` (jsonb array: e.g. "coding", "reasoning", "speed")
  - `reliabilityScore` (numeric 0-1) - Starts at 1.0, decays linearly on failure telemetry.
  - `lastSyncedAt` (timestamp)
- Create an internal cron job inside `apps/api/src/cron.ts` that triggers `syncModelKnowledge()` daily.
- The sync fetches data from `api.openrouter.ai/api/v1/models` (or uses a bundled static fallback) to populate the initial list and token costs.

### Phase 2: Pre-Flight Consultative Routing
- Update `apps/api/src/routes/chat.ts` intent classifier.
- When intent is classified as `TASK` or `PROJECT`, fetch the user's configured providers.
- Compare the required strengths (e.g. coding tasks require high reasoning models) against their available models in the `models_knowledge` table.
- If the best model != workspace default model, prompt the user with a recommendation. 
  "I recommend switching from your default `claude-haiku-4-5` to `claude-sonnet-4-5` for this complex logic task..."
- Add a field `recommendedModel` in the pushed task payload.

### Phase 3: The Actor/Evaluator Fallback Loop
- Update `packages/agent/src/providers/registry.ts`'s `withFallback` function to gracefully handle `TypeValidationError` (AI SDK parsing errors) and local `LogicError`s. Let it degrade sequentially through the fallback chain instead of immediately throwing.
- In `packages/agent/src/executor/index.ts`, when a task tool `shell` returns an error or constraints fail:
  - Record the tool output. 
  - Instead of failing the task directly, reflect on it and prompt a fix. If the retry cap hits, throw a `LogicError` to trigger the `withFallback` chain and downgrade the model's telemetry reliability.

## Risks
- **Cost/Latency**: Multiplying models increases token usage and execution time. We will cap retries to 2 to mitigate infinite loops.
- **Complexity**: Pre-flight analysis takes time. We will use a fast model (e.g., Haiku) for the `chat.ts` intent routing step.

## Verification
- **Unit**: Mock `generateText` in `chat.ts` to simulate a highly complex coding task. Assert that the returned intent includes a recommendation to use a capable model (e.g., Sonnet 3.5) over a basic one (e.g., Haiku), if the user has both configured.
- **Integration**: Force an executor tool failure (e.g. exit code 1) and assert the agent falls back to the next model.

## Approvals
- Evaluated by Principal Engineering Panel: Tradeoffs declared. Scope approved.
