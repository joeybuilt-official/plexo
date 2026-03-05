import { redirect } from 'next/navigation'

/**
 * /sprints is the legacy route. Canonical URL is /projects.
 */
export default function SprintsRedirectPage() {
    redirect('/projects')
}
