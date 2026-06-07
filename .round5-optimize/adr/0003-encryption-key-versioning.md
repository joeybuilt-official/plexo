# ADR 0003 — ENCRYPTION_SECRET key-versioning + service-key/X-App-Id hardening (WS F)

Date: 2026-06-06
Status: Proposed (awaiting operator gate)
Project: Plexo Round-5 optimization

## Context

Security audit findings:

1. **Single `ENCRYPTION_SECRET`, no versioning.** `crypto.ts:18-22` derives a per-workspace key via `HMAC-SHA256(ENCRYPTION_SECRET, workspaceId)`. Ciphertext format `enc:iv.ct.tag` has **no version byte**. Rotating the secret **instantly orphans every encrypted provider key** (decrypt → `__decrypt_failed__` sentinel, `ai-provider-creds.ts:158`), silently breaking all provider fallback chains. A referenced rotation script (`scripts/rotate-encryption-key.ts`, SEC-029) exists but there is no multi-key/versioned support.
2. **Single shared `PLEXO_SERVICE_KEY`** for all service-to-service calls; rotating it requires redeploying all sibling apps simultaneously.
3. **`X-App-Id` is spoofable.** It is authenticated only by the shared service key and used for lane/model routing decisions (`inference.ts:129-131` background-lane override + the D2 fast-model). Any service-key holder can send `X-App-Id: graphiti-sidecar` to get the background lane AND the D2 forced model. Today low-impact (single trusted mesh), but it couples a security boundary to a spoofable header.
4. **Provider-credential mutations are not audited** (`ai-provider-creds.ts` PUT path logs to app logger, not `audit_log`); super-admin actions + service-key calls also unaudited.

## Decision (proposed)

1. **Versioned ciphertext.** New format `enc:v2:<keyId>.iv.ct.tag`; `decryptKey` accepts both legacy (`enc:iv.ct.tag` ⇒ keyId=`v1`) and versioned. Maintain a small keyring (`ENCRYPTION_SECRET` = current + `ENCRYPTION_SECRET_PREVIOUS` = retiring). New writes use current; reads try the keyId's key. Rotation = add new key as current, lazily re-encrypt on next write (or a bounded backfill). ⚠ One-way door: ciphertext-format change; once v2 rows exist, the keyring must retain the keys that wrote them. Operator gate.
2. **Audit credential mutations + admin actions.** Add `audit(req, {action:'provider.update', resource:'ai_providers', ...})` to the provider PUT path; add an audit hook to `requireSuperAdmin`.
3. **X-App-Id integrity (lightweight).** Either (a) sign the app identity (per-app key or an HMAC over app-id with the service key) so background-lane/D2 routing can't be spoofed, or (b) accept the current trust model explicitly and document that lane/model override is a trusted-mesh-only privilege. Recommend (b) short-term + (a) if/when an untrusted caller is ever added — decide with operator.

(Per-app service keys = noted, deferred; larger blast-radius change, separate effort.)

## Conflicts surfaced (expert panel)

- **Security (Sasha) vs Maintainability (Mort):** versioned-keyring + lazy re-encrypt adds real complexity to a hot crypto path. Mort: "single key has worked; rotation is rare." Sasha: "no rotation path = a leaked secret is unrecoverable without manual re-entry per workspace." Recommend implementing read-side multi-key support now (cheap, unblocks rotation) and deferring automated backfill.
- **Security (Sasha) vs Performance (Pat):** signing X-App-Id adds an HMAC verify on the inference hot path (already cost-sensitive per Round-4). Pat resists per-call crypto on the hottest route. Recommend option (b) (document trust model) unless an untrusted caller exists — avoids hot-path cost.

## Pre-mortem (3 failure modes + fallback)

1. **Keyring misconfig (previous key dropped) orphans v1 rows.** Fallback: read-side tries all configured keys; startup asserts at least the keys referenced by sampled rows are present; never delete a key while v1/old rows exist.
2. **Versioned-format bug corrupts new writes.** Fallback: ship read-compat first (accept both formats, keep WRITING v1) in one deploy; flip writes to v2 in a SECOND deploy after read-compat is verified in prod.
3. **Audit writes add latency / fail closed on the credential path.** Fallback: audit is fire-and-forget (existing `audit.ts` pattern is non-blocking); never block the mutation on the audit write.
