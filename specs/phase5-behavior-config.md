# Agent Behavior Configuration System
## Execution Plan — Plexo

**Status:** Planning
**Phase:** Post-Phase 4 (Dashboard MVP) insertion
**Scope:** Data model, backend API, UI layer, composability engine
**Owner:** Dustin
**Insert into:** Phase 5, before marketplace browser
**Dependencies:** Phase 4 complete, behavior_rules schema, plugin SDK

---

## THE PROBLEM WITH AGENTS.MD

A flat markdown file is being used to store what is fundamentally a structured data problem. The consequences:

- No inheritance — workspace rules and project rules live in the same flat space
- No enforcement signals — safety constraints look identical to tone preferences
- No version history with meaningful diffs — it's just text changing
- No UI — only developers can meaningfully edit it
- No composability — can't layer team defaults under project overrides
- Update frequency mismatch — personality changes rarely, domain knowledge changes constantly, and they're all mixed together

---

## CORE CONCEPT: BEHAVIOR AS A LAYERED GRAPH

Agent behavior is not a document. It is a directed graph of rule layers with inheritance, overrides, and scoped applicability.

```
Platform Defaults (read-only, Plexo-maintained)
    inherited by
Workspace Defaults (user-controlled)
    inherited by
Project Overrides (project-level)
    inherited by
Task Context (ephemeral, per-task injection)
```

Each layer can override parent values. Conflicts surface visually. The agent always knows which layer a rule came from.

---

## DATA MODEL

### Rule Types

```typescript
type RuleType =
  | 'safety_constraint'    // Structural — maps to SAFETY_LIMITS constants
  | 'operational_rule'     // How agent executes work (retry logic, confirmation thresholds)
  | 'communication_style'  // Tone, verbosity, channel preferences
  | 'domain_knowledge'     // Project-specific context the agent should always carry
  | 'persona_trait'        // Personality characteristics
  | 'tool_preference'      // Which tools to prefer / avoid for given tasks
  | 'quality_gate'         // Custom rubric additions per task type
```

### Rule Schema

```typescript
interface BehaviorRule {
  id: string
  workspaceId: string
  projectId: string | null        // null = workspace-level
  type: RuleType
  key: string                     // machine-readable identifier, unique per scope
  label: string                   // human-readable display name
  description: string
  value: RuleValue
  locked: boolean                 // true = safety constraint, cannot be deleted or toggled off
  source: 'platform' | 'workspace' | 'project' | 'task'
  overrides: string | null        // id of parent rule this overrides
  tags: string[]
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

type RuleValue =
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number; min?: number; max?: number }
  | { type: 'enum'; value: string; options: string[] }
  | { type: 'text_block'; value: string }
  | { type: 'json'; value: unknown }
```

### Database Tables

```sql
-- behavior_rules
id uuid PK
workspace_id uuid FK
project_id uuid FK nullable
type rule_type_enum
key text
label text
description text
value jsonb
locked boolean DEFAULT false
source source_enum
overrides_rule_id uuid FK nullable (self-referential)
tags text[]
created_at timestamptz
updated_at timestamptz
deleted_at timestamptz nullable

-- behavior_groups (seeded, not user-editable at schema level)
id uuid PK
label text
description text
icon text
rule_types rule_type_enum[]
locked boolean
color text
display_order integer

-- behavior_snapshots (version history)
id uuid PK
workspace_id uuid FK
project_id uuid FK nullable
snapshot jsonb           -- full resolved behavior at time of snapshot
triggered_by text        -- 'manual' | 'task_start' | 'sprint_start'
created_at timestamptz
```

---

## RESOLUTION ENGINE

Runs before every task execution. Produces a ResolvedBehavior and compiles it into a system prompt fragment.

```typescript
async function resolveBehavior(
  workspaceId: string,
  projectId: string | null,
  taskContext?: Partial<BehaviorRule>[]
): Promise<ResolvedBehavior> {
  const platformRules = await getPlatformDefaults()
  const workspaceRules = await getWorkspaceRules(workspaceId)
  const projectRules = projectId ? await getProjectRules(workspaceId, projectId) : []
  const merged = mergeRuleLayers(platformRules, workspaceRules, projectRules, taskContext ?? [])
  const systemPrompt = compileToPrompt(merged)
  await snapshotBehavior(workspaceId, projectId, merged)
  return { rules: merged, generatedSystemPrompt: systemPrompt }
}

// Later layers win on key conflicts
function mergeRuleLayers(...layers: BehaviorRule[][]): ResolvedRule[] {
  const map = new Map<string, ResolvedRule>()
  for (const layer of layers) {
    for (const rule of layer) {
      const existing = map.get(rule.key)
      map.set(rule.key, {
        ...rule,
        effectiveSource: rule.source,
        overriddenBy: existing ? { ruleId: existing.id, source: existing.source } : null,
      })
    }
  }
  return Array.from(map.values())
}
```

### Prompt Compiler

```typescript
const COMPILERS: Record<RuleType, (rules: ResolvedRule[]) => string> = {
  safety_constraint: (rules) =>
    `Safety constraints (non-negotiable):\n${rules.map(r => `- ${r.label}: ${formatValue(r.value)}`).join('\n')}`,
  communication_style: (rules) =>
    `Communication style:\n${rules.map(r => `- ${r.label}: ${formatValue(r.value)}`).join('\n')}`,
  domain_knowledge: (rules) =>
    `Project context:\n${rules.map(r => r.value.value).join('\n\n')}`,
  // ...
}
```

---

## API SURFACE

```
GET    /api/behavior/:workspaceId
GET    /api/behavior/:workspaceId/projects/:projectId
POST   /api/behavior/:workspaceId/rules
PATCH  /api/behavior/:workspaceId/rules/:ruleId
DELETE /api/behavior/:workspaceId/rules/:ruleId
GET    /api/behavior/:workspaceId/resolve/:projectId
GET    /api/behavior/:workspaceId/snapshots
POST   /api/behavior/:workspaceId/rules/import
GET    /api/behavior/:workspaceId/rules/export
```

---

## UI LAYER

```
Settings
  Agent Behavior
    [Scope Selector] workspace | project
    [Inheritance View toggle]
    Groups as Cards:
      Safety Constraints      locked, red
      Operational Rules       amber, semi-locked
      Communication Style     blue, editable
      Domain Knowledge        green, editable
      Persona                 purple, editable
      Tool Preferences        slate, editable
      Quality Gates           orange, editable
```

### Components

**BehaviorCard** — collapse/expand, lock status, rule count, last-edited timestamp. Safety cards: dark bg, lock icon, no delete. All others: full CRUD, drag to reorder.

**RuleRow** — per-rule inline edit. Shape by value type:
- boolean: toggle
- string: inline text
- number: slider with min/max
- enum: dropdown
- text_block: expandable textarea

Locked rows: reduced opacity, lock icon, tooltip on hover.

**InheritanceView** — split panel. Left: workspace defaults. Right: project overrides. Diff highlighting. "Reset to workspace default" per rule.

**BehaviorScopeSelector** — page header dropdown. Switching scope reloads rules with source labels (inherited / local / override).

**SystemPromptPreview** — collapsible bottom panel. Live update, 500ms debounce. Read-only. Shows exactly what the agent receives.

### Add Rule Flow

Inline form below existing rules. Fields: Label, key (auto from label), value type, value, description. No modal.

### Import from AGENTS.md

Button opens modal: paste content, parser categorizes by type, preview shows proposed placement, user can reassign blocks, import creates DB rules.

---

## PLUGIN COMPOSABILITY

```typescript
export const behaviorRules: BehaviorRuleDefinition[] = [
  {
    key: 'github_ops.pr_title_format',
    label: 'PR Title Format',
    description: 'Template for pull request titles',
    type: 'communication_style',
    defaultValue: { type: 'string', value: 'feat: {task_title}' },
    locked: false,
  }
]
```

Plugin rules appear in their own card group "Plugin: GitHub Ops". Uninstalling soft-deletes the group's rules.

---

## TASK-LEVEL CONTEXT INJECTION

Ephemeral rules valid for a single task:

```
/sprint "Add Stripe webhook handler" --context "We use idempotency keys. Never skip signature verification."
```

Creates a task-source rule, appears in SystemPromptPreview, not persisted as a permanent rule, included in snapshot for auditing.

---

## VERSION HISTORY

Every behavior compilation (task start, sprint start, manual preview) saves a snapshot. History tab shows:
- Timestamp and trigger
- Diff from previous snapshot
- "Restore to this version" action

---

## MIGRATION PATH FROM AGENTS.MD

1. Phase 4: AGENTS.md stays as source of truth — no change
2. Phase 5: schema and resolution engine introduced; AGENTS.md auto-imported on first load
3. Phase 5 UI live: Agent Behavior settings page ships
4. AGENTS.md deprecated as editable source; becomes read-only export artifact
5. Export regenerated on every rule change — external tool compatibility maintained

---

## BUILD SEQUENCING

**5a. Data layer**
- Schema: behavior_rules, behavior_groups, behavior_snapshots
- Seed platform defaults and group definitions
- packages/agent/behavior/resolver.ts
- packages/agent/behavior/compiler.ts
- packages/agent/behavior/import.ts (AGENTS.md parser)
- packages/agent/behavior/export.ts (AGENTS.md generator)

**5b. API**
- All 9 endpoints
- Resolver integrated into task execution (before PLAN step)
- Snapshot on task start

**5c. UI**
- BehaviorCard, RuleRow (all value type variants), InheritanceView
- BehaviorScopeSelector, SystemPromptPreview
- Settings page routing, import modal

**5d. Plugin SDK**
- behaviorRules export in plugin manifest type
- Auto-registration on install, cleanup on uninstall

**5e. Tests**
- Unit: merge logic (all layer combinations)
- Unit: compiler output per rule type
- Integration: all API endpoints with real DB
- E2E (Playwright): add rule, verify in preview; lock prevents edit; scope switch loads correct rules

---

## WHAT THIS REPLACES

| Before | After |
|--------|-------|
| AGENTS.md flat text | Structured rule graph with types and inheritance |
| Text editor only | Settings UI for non-developers |
| No enforcement signals | Lock icons and disabled controls for safety constraints |
| No meaningful diffs | Snapshot diffs tied to task execution |
| No inheritance | Workspace to Project to Task layering |
| All rules look the same | Card groups with visual weight signaling editability |
| Plugin rules in AGENTS.md | Plugin-owned groups, auto-managed on install/uninstall |
| No compiled view | SystemPromptPreview shows exactly what agent receives |
