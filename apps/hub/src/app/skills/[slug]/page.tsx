import { redirect } from 'next/navigation'

// Legacy path — `/skills/[slug]` is now `/ext/[slug]`.
// Preserved to avoid breaking bookmarks and external links.
export const dynamic = 'force-dynamic'

interface PageProps {
    params: Promise<{ slug: string }>
}

export default async function LegacySkillRedirect({ params }: PageProps) {
    const { slug } = await params
    redirect(`/ext/${slug}`)
}
