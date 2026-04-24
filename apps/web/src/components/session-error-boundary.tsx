// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import React, { Component, ErrorInfo, ReactNode } from 'react'
import { logClientSideError } from '@web/lib/log-action'

interface Props {
  children: ReactNode
  personaId?: string
  sessionId?: string
}

interface State {
  hasError: boolean
}

export class SessionErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  }

  public static getDerivedStateFromError(_: Error): State {
    return { hasError: true }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const route = typeof window !== 'undefined' ? window.location.pathname : 'server-side'
    
    // Fire and forget logging
    void logClientSideError({
      sessionId: this.props.sessionId,
      personaId: this.props.personaId,
      route,
      errorMessage: `${error.message}\n${errorInfo.componentStack}`,
    })
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h2 className="mb-2 text-xl font-bold text-red">Something went wrong</h2>
          <p className="mb-4 text-sm text-text-muted">The error has been logged for remediation.</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-surface-2 px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-3"
          >
            Try Refreshing
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
