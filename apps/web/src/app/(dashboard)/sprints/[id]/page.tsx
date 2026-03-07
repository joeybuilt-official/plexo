import { redirect } from 'next/navigation'

export default function SprintDetailPage({ params }: { params: { id: string } }) {
    redirect(`/projects/${params.id}`)
}
