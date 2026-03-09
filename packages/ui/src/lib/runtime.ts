// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export type RuntimeContext = 'tauri' | 'capacitor' | 'browser'

export function getRuntimeContext(): RuntimeContext {
  if (typeof window === 'undefined') return 'browser'
  if (typeof (window as any).__TAURI__ !== 'undefined') return 'tauri'
  if (typeof (window as any).Capacitor !== 'undefined') return 'capacitor'
  return 'browser'
}

export const isDesktop = typeof window !== 'undefined' && getRuntimeContext() === 'tauri'
export const isMobile = typeof window !== 'undefined' && getRuntimeContext() === 'capacitor'
export const isNative = isDesktop || isMobile
