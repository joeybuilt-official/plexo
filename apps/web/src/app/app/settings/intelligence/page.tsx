// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Root of /app/settings/intelligence — the real content lives in the
// sub-pages (providers, routing, embeddings, memory, scl, etc.). This
// file just bounces to the default sub-section.
import { redirect } from 'next/navigation'

export default function IntelligenceRoot() {
    redirect('/app/settings/intelligence/providers')
}
