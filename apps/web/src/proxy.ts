import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { authConfig } from './auth'

const { auth } = NextAuth(authConfig)

export default auth((req: NextRequest & { auth: unknown }) => {
    const isAuthenticated = !!req.auth
    const { pathname } = req.nextUrl

    if (!isAuthenticated) {
        const loginUrl = new URL('/login', req.url)
        loginUrl.searchParams.set('callbackUrl', req.url)
        return NextResponse.redirect(loginUrl)
    }
})

export const config = {
    matcher: ['/((?!api|_next/static|_next/image|favicon.ico|login|register|setup).*)'],
}
