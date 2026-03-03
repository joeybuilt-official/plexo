import { redirect } from 'next/navigation'

/**
 * /projects redirects to /sprints — they are the same concept.
 * The sidebar shows "Projects" linking here; sprints is the canonical route.
 */
export default function ProjectsPage() {
    redirect('/sprints')
}
