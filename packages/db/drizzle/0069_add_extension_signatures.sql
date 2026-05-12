-- Migration 0069 — extension registry signature columns
-- Corresponds to docs/security/extension-security-model.md §Q1, §Q2.
--
-- Every registry row gains four nullable fields so the install route can
-- verify the package traces back to a known signer. v1 stores metadata only;
-- real cosign/Rekor verification is a follow-up (see packages/sdk/src/
-- validation/signature.ts).
--
-- Pre-existing rows are left unsigned on purpose — they surface in the Hub UI
-- with an "unverified" badge and the install dialog downgrades them to
-- community tier until the publisher resigns.

ALTER TABLE extension_registry
    ADD COLUMN IF NOT EXISTS signature TEXT,
    ADD COLUMN IF NOT EXISTS signature_type TEXT,
    ADD COLUMN IF NOT EXISTS signer_identity TEXT,
    ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

COMMENT ON COLUMN extension_registry.signature IS 'Opaque signature payload — base64 for ECDSA, Sigstore bundle JSON otherwise.';
COMMENT ON COLUMN extension_registry.signature_type IS 'Signature scheme: sigstore | ecdsa-p256 | NULL (unsigned).';
COMMENT ON COLUMN extension_registry.signer_identity IS 'Signer identity string — e.g. plexo-bot@joeybuilt-official for owner-tier.';
COMMENT ON COLUMN extension_registry.signed_at IS 'Timestamp the signature was produced (registry trust only — not chained).';

CREATE INDEX IF NOT EXISTS extension_registry_signer_idx
    ON extension_registry (signer_identity)
    WHERE signer_identity IS NOT NULL;
