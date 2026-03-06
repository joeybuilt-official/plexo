import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import GitHub from 'next-auth/providers/github'
import type { NextAuthConfig } from 'next-auth'

// Edge-safe config (no Node.js APIs) used in middleware
export const authConfig: NextAuthConfig = {
    providers: [
        // Credentials listed here without the authorize() function
        // (authorize runs only in the server route handler, not middleware)
        Credentials({ credentials: {} }),
        GitHub,
    ],
    session: { strategy: 'jwt' },
    pages: { signIn: '/login' },
    callbacks: {
        async jwt({ token, user, account }) {
            const email = user?.email || (token.email as string | undefined)
            const isUnsynced = token.id && typeof token.id === 'string' && !token.id.includes('-')

            if ((user || isUnsynced) && email) {
                const apiUrl = process.env.INTERNAL_API_URL ?? 'http://api:3001'
                try {
                    const res = await fetch(`${apiUrl}/api/v1/auth/sync-oauth`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: email,
                            name: user?.name || (token.name as string | undefined),
                            image: user?.image || (token.picture as string | undefined),
                            provider: account?.provider || 'github',
                            providerAccountId: account?.providerAccountId || (token.id as string),
                        }),
                    })
                    if (res.ok) {
                        const dbUser = await res.json() as { id: string }
                        token.id = dbUser.id
                    } else if (res.status === 403) {
                        throw new Error('AccessDenied: Registration is closed')
                    } else {
                        if (user) token.id = user.id
                    }
                } catch {
                    if (user) token.id = user.id
                }
            } else if (user) {
                token.id = user.id
            }
            return token
        },
        async session({ session, token }) {
            if (session.user && token.id) session.user.id = token.id as string
            return session
        },
    },
}

// Full server config with the actual credentials authorize logic
export const { handlers, auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            name: 'Email',
            credentials: {
                email: { label: 'Email', type: 'email' },
                password: { label: 'Password', type: 'password' },
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) return null

                const apiUrl = process.env.INTERNAL_API_URL ?? 'http://api:3001'
                const res = await fetch(`${apiUrl}/api/v1/auth/verify-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: credentials.email,
                        password: credentials.password,
                    }),
                })

                if (!res.ok) return null

                const user = await res.json() as { id: string; email: string; name: string }
                return { id: user.id, email: user.email, name: user.name }
            },
        }),
        GitHub({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
    ],
})
