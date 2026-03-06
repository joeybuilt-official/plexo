import { LoginForm } from './login-form'

export default function LoginPage() {
    const githubConfigured = !!(
        process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET
    )

    return <LoginForm githubConfigured={githubConfigured} />
}
