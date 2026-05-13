// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase F per-app graphiti schema mirror (ADR 0029).
 *
 * The canonical schemas live in YAML at
 *   services/graphiti-sidecar/schemas/<app>.yaml
 * loaded by services/graphiti-sidecar/schema_registry.py.
 *
 * This file mirrors them as TypeScript so JB apps (the plexo bridge,
 * Levio, Frame Forge, Helm) can pre-validate writes before issuing the
 * sidecar HTTPS round-trip. Drift between this file and the YAML is
 * caught by the nightly cardinality report (Phase F exit gate); the
 * primary source of truth for the SIDECAR is still the YAML.
 *
 * Validate locally:
 *   import { validateNode } from '@joeybuilt/plexo-sdk/graphiti-schema';
 *   const result = validateNode('plexo', 'Entity', { name: 'foo' });
 *   if (!result.ok) throw new Error(result.error);
 *
 * Behavior matches schema_registry.py:
 *   - unknown app → error
 *   - unknown label → error
 *   - missing required prop → error
 *   - unknown property key → error
 *
 * Strict mode is the caller's choice — this module returns structured
 * results; the caller decides whether to throw or log+allow.
 */

export interface LabelSchema {
  required: readonly string[];
  optional: readonly string[];
}

export interface EdgeSchema {
  from: string;
  to: string;
  props: readonly string[];
}

export interface AppSchema {
  app: string;
  graphTemplate: string;
  nodeLabels: Record<string, LabelSchema>;
  edgeTypes: Record<string, EdgeSchema>;
  predicateVocabulary: readonly string[];
}

export const PLEXO_SCHEMA: AppSchema = {
  app: 'plexo',
  graphTemplate: 'plexo:<workspace_id>',
  nodeLabels: {
    Episodic: {
      required: ['content', 'source_description'],
      optional: [
        'name',
        'source',
        'valid_at',
        'episode_type',
        // Phase A2 (ADR 0018) — confidence lifecycle + kNN on graph nodes.
        'tier',
        'last_retrieved_at',
        'is_anchored',
        'confidence',
        'superseded_by',
        'embedding',
        // A3 S1 (ADR 0031, Path a) — plexo-side identity, REQUIRED at S4.
        'plexo_memory_id',
      ],
    },
    Entity: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    IdentityFact: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    PreferenceFact: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    SkillFact: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    ContextFact: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    ConstraintFact: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    Generic: { required: ['name'], optional: ['summary', 'plexo_memory_type'] },
    // Phase B1 (ADR 0020) — task execution DAG on graph.
    Task: {
      required: ['id', 'description', 'status'],
      optional: ['priority', 'scope', 'acceptance', 'branch', 'sprint_id'],
    },
    // Phase B2 (ADR 0021) — conversation threading on graph.
    Message: {
      required: ['id', 'source', 'message', 'created_at'],
      optional: [
        'reply',
        'error_msg',
        'status',
        'intent',
        'task_id',
        'channel_ref',
        'attachments',
      ],
    },
    Session: {
      required: ['id'],
      optional: ['source', 'session_key', 'last_activity_at'],
    },
  },
  edgeTypes: {
    RELATES_TO: {
      from: 'Entity',
      to: 'Entity',
      props: ['fact', 'plexo_memory_id', 'plexo_memory_type'],
    },
    HAS_EPISODE_OF: { from: 'Episodic', to: 'Entity', props: [] },
    // Phase A2 — kNN edges between Episodic nodes; weight = cosine similarity.
    SIMILAR_TO: { from: 'Episodic', to: 'Episodic', props: ['weight'] },
    // Phase B1 — task DAG.
    DEPENDS_ON: { from: 'Task', to: 'Task', props: [] },
    // Phase B2 — message-to-session membership + sibling chain.
    IN_SESSION: { from: 'Message', to: 'Session', props: [] },
    NEXT: { from: 'Message', to: 'Message', props: [] },
  },
  predicateVocabulary: [],
};;

export const LEVIO_SCHEMA: AppSchema = {
  app: 'levio',
  graphTemplate: 'levio:<workspace_id>',
  nodeLabels: {
    Contact: { required: ['email'], optional: ['name', 'company', 'last_seen_at'] },
    Thread: { required: ['subject'], optional: ['started_at', 'last_msg_at', 'message_count'] },
    Email: {
      required: ['body', 'sent_at'],
      optional: ['subject', 'from_email', 'to_emails', 'message_id'],
    },
    Entity: { required: ['name'], optional: ['summary', 'type'] },
  },
  edgeTypes: {
    PARTICIPATES_IN: { from: 'Contact', to: 'Thread', props: ['role'] },
    MENTIONS: { from: 'Email', to: 'Entity', props: ['confidence'] },
    IN_THREAD: { from: 'Email', to: 'Thread', props: [] },
  },
  predicateVocabulary: [],
};

export const FRAME_FORGE_SCHEMA: AppSchema = {
  app: 'frame-forge',
  graphTemplate: 'frame-forge:<workspace_id>',
  nodeLabels: {
    Brand: { required: ['name'], optional: ['tone', 'voice', 'palette'] },
    StyleRule: {
      required: ['rule'],
      optional: ['category', 'source_doc', 'confidence'],
    },
    Decision: { required: ['text', 'made_at'], optional: ['author', 'pitch_id'] },
    Asset: { required: ['uri'], optional: ['kind', 'brand_id', 'created_at'] },
    Pitch: { required: ['title'], optional: ['client', 'status', 'created_at'] },
  },
  edgeTypes: {
    APPLIES_TO: { from: 'StyleRule', to: 'Brand', props: [] },
    DERIVED_FROM: { from: 'Decision', to: 'Pitch', props: [] },
    IN_PITCH: { from: 'Asset', to: 'Pitch', props: ['position'] },
  },
  predicateVocabulary: [],
};

export const HELM_SCHEMA: AppSchema = {
  app: 'helm',
  graphTemplate: 'helm:<workspace_id>',
  nodeLabels: {
    Deploy: {
      required: ['commit', 'deployed_at'],
      optional: ['actor', 'environment', 'status'],
    },
    Service: { required: ['name'], optional: ['repo', 'owner_team'] },
    Incident: {
      required: ['title', 'started_at'],
      optional: ['severity', 'resolved_at', 'postmortem_url'],
    },
    Runbook: { required: ['doc'], optional: ['title', 'last_reviewed_at'] },
  },
  edgeTypes: {
    OF_SERVICE: { from: 'Deploy', to: 'Service', props: [] },
    RESPONDS_TO: { from: 'Runbook', to: 'Incident', props: [] },
    REFERENCES: { from: 'Incident', to: 'Service', props: ['role'] },
  },
  predicateVocabulary: [],
};

export const SCHEMA_REGISTRY: Readonly<Record<string, AppSchema>> = Object.freeze({
  plexo: PLEXO_SCHEMA,
  levio: LEVIO_SCHEMA,
  'frame-forge': FRAME_FORGE_SCHEMA,
  helm: HELM_SCHEMA,
});

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function getAppSchema(app: string): AppSchema | undefined {
  return SCHEMA_REGISTRY[app];
}

export function graphName(app: string, workspaceId: string): string {
  const spec = SCHEMA_REGISTRY[app];
  // Back-compat: unknown app falls back to bare workspace_id (legacy plexo
  // sidecar named graphs by workspace_id alone before Phase F).
  if (!spec) return workspaceId;
  return spec.graphTemplate.replace('<workspace_id>', workspaceId);
}

export function validateNode(
  app: string,
  label: string,
  properties: Record<string, unknown> | null | undefined,
): ValidationResult {
  const spec = SCHEMA_REGISTRY[app];
  if (!spec) return { ok: false, error: `app '${app}' has no registered schema` };

  const labelSpec = spec.nodeLabels[label];
  if (!labelSpec) {
    return { ok: false, error: `app '${app}' has no registered label '${label}'` };
  }

  const props = properties ?? {};
  const missing = labelSpec.required.filter((k) => !(k in props));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `app '${app}' label '${label}' missing required props: ${JSON.stringify(missing.sort())}`,
    };
  }

  const allowed = new Set<string>([...labelSpec.required, ...labelSpec.optional]);
  const extra = Object.keys(props).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      error: `app '${app}' label '${label}' has unregistered props: ${JSON.stringify(extra.sort())}`,
    };
  }

  return { ok: true };
}

export function validateEdge(
  app: string,
  edgeType: string,
  opts: {
    fromLabel?: string;
    toLabel?: string;
    properties?: Record<string, unknown> | null;
  } = {},
): ValidationResult {
  const spec = SCHEMA_REGISTRY[app];
  if (!spec) return { ok: false, error: `app '${app}' has no registered schema` };

  const edgeSpec = spec.edgeTypes[edgeType];
  if (!edgeSpec) {
    return { ok: false, error: `app '${app}' has no registered edge type '${edgeType}'` };
  }

  if (opts.fromLabel && edgeSpec.from && opts.fromLabel !== edgeSpec.from) {
    return {
      ok: false,
      error: `edge '${edgeType}' expects from=${edgeSpec.from}, got ${opts.fromLabel}`,
    };
  }
  if (opts.toLabel && edgeSpec.to && opts.toLabel !== edgeSpec.to) {
    return {
      ok: false,
      error: `edge '${edgeType}' expects to=${edgeSpec.to}, got ${opts.toLabel}`,
    };
  }

  if (edgeSpec.props.length > 0) {
    const allowed = new Set<string>(edgeSpec.props);
    const props = opts.properties ?? {};
    const extra = Object.keys(props).filter((k) => !allowed.has(k));
    if (extra.length > 0) {
      return {
        ok: false,
        error: `edge '${edgeType}' has unregistered props: ${JSON.stringify(extra.sort())}`,
      };
    }
  }

  return { ok: true };
}
