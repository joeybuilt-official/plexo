// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import Link from 'next/link'

export const metadata = {
    title: 'Privacy Policy | Plexo',
    description: 'Plexo Privacy Policy',
}

export default function PrivacyPage() {
    return (
        <main className="mx-auto max-w-2xl px-6 py-16">
            <h1 className="text-3xl font-bold text-text-primary mb-2">Privacy Policy</h1>
            <p className="text-sm text-text-muted mb-8">Last updated: April 2026</p>

            <div className="prose prose-sm prose-invert max-w-none space-y-6 text-text-secondary">
                <section>
                    <h2 className="text-lg font-semibold text-text-primary">1. Information We Collect</h2>
                    <p>We collect information you provide directly (account details, workspace settings) and information generated through your use of the service (conversations, tasks, agent interactions).</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">2. How We Use Information</h2>
                    <p>We use collected information to provide and improve the service, authenticate users, process requests through AI providers, and maintain system security.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">3. Data Storage</h2>
                    <p>Data is stored in the database and object storage configured for your deployment. For self-hosted instances, all data remains within your infrastructure. For managed deployments, data is stored in our secure cloud infrastructure.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">4. Third-Party AI Providers</h2>
                    <p>When you configure AI providers (e.g., OpenAI, Anthropic, Google), your prompts and conversations are sent to those providers according to their respective privacy policies. Plexo does not control how third-party providers handle data.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">5. Data Sharing</h2>
                    <p>We do not sell your data. We share data only as necessary to provide the service (e.g., with configured AI providers) or as required by law.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">6. Data Export and Deletion</h2>
                    <p>You can export your workspace data at any time via the Settings page. To request account deletion, contact us at privacy@getplexo.com.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">7. Cookies</h2>
                    <p>We use essential cookies for authentication and session management. We do not use tracking or advertising cookies.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">8. Security</h2>
                    <p>We implement industry-standard security measures including encryption at rest and in transit, credential redaction in logs, and application-layer access control.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">9. Changes to This Policy</h2>
                    <p>We may update this policy from time to time. We will notify users of material changes through the service.</p>
                </section>

                <section>
                    <h2 className="text-lg font-semibold text-text-primary">10. Contact</h2>
                    <p>For privacy-related inquiries, contact us at privacy@getplexo.com.</p>
                </section>
            </div>

            <div className="mt-12 border-t border-border pt-6">
                <Link href="/" className="text-sm text-text-muted hover:text-text-secondary transition-colors">
                    Back to home
                </Link>
            </div>
        </main>
    )
}
