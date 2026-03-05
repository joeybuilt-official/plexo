import { redirect } from 'next/navigation'

export default function BehaviorRedirect() {
    redirect('/settings/agent?tab=behavior')
}
