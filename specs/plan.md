# Spec: Intelligent LLM Router

## Why
Plexo currently relies on a static, manual configuration block `DEFAULT_MODEL_ROUTING` and single-threaded fallback chains tied strictly to hard-coded configurations. This prevents intelligent cost vs. quality arbitration, lacks true "auto" fallback routing to cheaper inference providers for simple tasks, and intimately couples API keys (vault) with the execution mapping (arbiter). To support autonomous scaling and 4-Mode model selection (Full Auto, BYOK, Managed Proxy, Override), we must build the Intelligent LLM Router.

## How

### Phase 1: Portkey Registry Sync
- Modify the `syncModelKnowledge()` cron task (`packages/agent/src/providers/knowledge.ts`) to pull the open-source `Portkey-AI/models` registry.
- Introduce `Layer 1: Provider Allowlist` filtering, validating only approved providers (Anthropic, OpenAI, Gemini, Groq, Together, DeepSeek) are retained.
- Update `packages/db/src/schema.ts` to reflect a more robust `models_knowledge` table to handle context windows, costs, and dynamic strength flags properly derived from the external registry.

### Phase 2: Credential & Parameter Uncoupling (The Vault)
- Refactor `WorkspaceAISettings` schema to untangle credentials from routing configuration.
- Write a backward-compatible adapter inside `apps/api/src/routes/ai-provider-creds.ts` that safely decrypts existing legacy credentials into a pure "Vault" structure without exposing keys to the agent execution loop's logic trees.

### Phase 3: The 4-Mode Arbitration Engine
- Construct a new `Router` singleton that receives task requests and enforces the correct mode:
   - **Mode 1 (Full Auto)**: Select most cost-effective capabilities from a Plexo managed inference pool.
   - **Mode 2 (BYOK)**: Select optimally across user-provisioned vault keys.
   - **Mode 3 (Proxy)**: Use Plexo proxy keys but run inference locally.
   - **Mode 4 (Override)**: Hardened constraints placed at the task/project level overrides all cost optimizations.

### Phase 4: Executor Integration
- Update `buildModel()` within `packages/agent/src/providers/registry.ts` to defer mapping and capability selection to the new `Router` rather than parsing config maps directly.
- Add telemetry tags to clearly surface the selected model and reasoning trace (cost vs bounds) in `sprintLogs` for observability.

## Risks
- **Data Migration Drift:** Transitioning `workspaces.settings.aiProviders` represents a very high risk one-way door. If the migration misaligns properties, existing automated teams go dark.
- **Latency Overheads:** Resolving database checks against `models_knowledge` during active `executeTask` runs could stack latency unacceptably. 

## Verification
- **Unit (Routers):** Enforce strict input/output matching for all 4 routing modes under TDD principles.
- **Integration (Migration):** Test existing encrypted keys successfully map onto the new split schema without failing the decryption routine.
- **End-to-End:** Validate Playwright specs executing arbitrary tasks (research, development) properly fall backing based on simulated 429 response codes across completely different cloud providers without task disruption.
