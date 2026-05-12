// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export type RuntimeContext = 'tauri' | 'capacitor' | 'browser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- global runtime bridges have no typings
const _win = typeof window !== 'undefined' ? (window as any) : {}

export function getRuntimeContext(): RuntimeContext {
  if (typeof window === 'undefined') return 'browser'
  if (typeof _win.__TAURI__ !== 'undefined') return 'tauri'
  if (typeof _win.Capacitor !== 'undefined') return 'capacitor'
  return 'browser'
}

export const isDesktop = typeof window !== 'undefined' && getRuntimeContext() === 'tauri'
export const isMobile = typeof window !== 'undefined' && getRuntimeContext() === 'capacitor'
export const isNative = isDesktop || isMobile
