import { redirect } from 'next/navigation'
import { LoginForm } from './login-form'

export default async function LoginPage() {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

    try {
        const res = await fetch(`${apiBase}/api/v1/auth/setup-status`, { cache: 'no-store' })
        if (res.ok) {
            const data = await res.json() as { needsSetup: boolean }
            if (data.needsSetup) {
                redirect('/register')
            }
        }
    } catch {
        // assume properly configured if api unroutable or dead at start
    }

    return <LoginForm />
}
