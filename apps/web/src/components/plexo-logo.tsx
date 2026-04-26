// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

/**
 * PlexoMark — Delta Frame brand mark.
 *
 * Open triangle with gap in base, 3 dots at vertices.
 * The gap reads as a threshold — an open platform.
 *
 * Props:
 *   idle    — default; subtle vertex-dot pulse (2.4s cycle)
 *   working — agent processing; dots pulse faster, edges brighten
 */
export function PlexoMark({
  className,
  idle = true,
  working = false,
}: {
  className?: string
  idle?: boolean
  working?: boolean
}) {
  const mode = working ? 'df-working' : idle ? 'df-idle' : ''
  return (
    <svg
      className={`plexo-mark ${mode} ${className || ''}`}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          @keyframes df-dot-pulse {
            0%, 100% { opacity: 0.7; }
            50%       { opacity: 1; }
          }
          @keyframes df-edge-draw {
            from { stroke-dashoffset: 100; }
            to   { stroke-dashoffset: 0; }
          }
          .df-idle .df-edge {
            stroke-dasharray: 100; stroke-dashoffset: 100;
            animation: df-edge-draw 0.5s cubic-bezier(0.16,1,0.3,1) 0.2s forwards;
          }
          .df-idle .df-dot {
            animation: df-dot-pulse 2.4s ease-in-out 0.6s infinite;
          }
          @keyframes df-work-pulse {
            0%, 100% { opacity: 0.6; r: 3; }
            50%       { opacity: 1; r: 3.5; }
          }
          .df-working .df-dot {
            animation: df-work-pulse 1s ease-in-out infinite;
          }
          .df-working .df-edge {
            opacity: 0.9;
          }
        `}
      </style>
      <g>
        {/* Left edge */}
        <line className="df-edge" x1="24" y1="10" x2="12" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Right edge */}
        <line className="df-edge" x1="24" y1="10" x2="36" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Base left segment */}
        <line className="df-edge" x1="12" y1="34" x2="20" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Base right segment */}
        <line className="df-edge" x1="28" y1="34" x2="36" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Vertex dots */}
        <circle className="df-dot" cx="24" cy="10" r="3" fill="currentColor"/>
        <circle className="df-dot" cx="12" cy="34" r="3" fill="currentColor"/>
        <circle className="df-dot" cx="36" cy="34" r="3" fill="currentColor"/>
      </g>
    </svg>
  )
}

export function PlexoLogo({
  className,
  showWordmark = true,
  idle = true,
  working = false,
}: {
  className?: string
  showWordmark?: boolean
  idle?: boolean
  working?: boolean
}) {
  return (
    <div className={`flex items-center gap-3 ${className || ''}`}>
      <PlexoMark className="w-8 h-8 shrink-0" idle={idle} working={working} />
      {showWordmark && (
        <span className="font-display font-semibold text-xl tracking-tight text-text-primary leading-none" style={{ letterSpacing: '-0.03em' }}>_plexo</span>
      )}
    </div>
  )
}
