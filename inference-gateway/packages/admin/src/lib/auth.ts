import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { db } from './db'
import bcrypt from 'bcrypt'

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        
        const user = await db.query.adminUsers.findFirst({
          where: (users, { eq }) => eq(users.email, credentials.email as string)
        })

        if (!user) return null

        const isMatch = await bcrypt.compare(credentials.password as string, user.passwordHash)
        if (!isMatch) return null

        return { id: user.id, email: user.email }
      }
    })
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub
      }
      return session
    }
  }
})
