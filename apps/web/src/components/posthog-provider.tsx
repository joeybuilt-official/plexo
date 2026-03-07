'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-js/react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, Suspense } from 'react'

// Defaults point at Plexo's self-hosted instance.
// Override via env vars; disable entirely with NEXT_PUBLIC_TELEMETRY_DISABLED=true.
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? 'phc_NNJrGRLnopoR73cofmbbHEG05S2kSfCz93nQVOJlxQH'
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://telemetry.getplexo.com'

function PostHogPageView() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const ph = usePostHog()

  useEffect(() => {
    if (!ph) return
    let url = window.origin + pathname
    const search = searchParams.toString()
    if (search) url += `?${search}`
    ph.capture('$pageview', { $current_url: url })
  }, [pathname, searchParams, ph])

  return null
}

interface PostHogProviderProps {
  children: React.ReactNode
  userId?: string
  userEmail?: string | null
  userName?: string | null
}

export function PostHogProvider({ children, userId, userEmail, userName }: PostHogProviderProps) {
  // Init once on mount
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true') return
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
      person_profiles: 'identified_only',
      autocapture: false,
      capture_exceptions: true,
      persistence: 'localStorage',
    })
  }, [])

  // Identify separately so init doesn't re-run on user changes
  useEffect(() => {
    if (!userId) return
    posthog.identify(userId, {
      ...(userEmail && { email: userEmail }),
      ...(userName && { name: userName }),
    })
  }, [userId, userEmail, userName])

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </PHProvider>
  )
}
