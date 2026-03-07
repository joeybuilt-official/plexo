import { redirect } from 'next/navigation'

// Sprints are managed under /projects — redirect for backwards compatibility
export default function SprintsPage() {
    redirect('/projects')
}
