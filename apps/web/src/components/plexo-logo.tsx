// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

/**
 * PlexoMark — Delta Frame brand mark.
 *
 * Open triangle with gap in the base, dots at all three vertices.
 * Matches brand/plexo-symbol-mono.svg geometry.
 *
 * Props:
 *   idle    — default; soft breathing pulse on nodes (2.4s cycle)
 *   working — agent is processing; faster pulse (0.9s cycle)
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
  const mode = working ? 'mark-working' : idle ? 'mark-anim' : ''
  return (
    <svg
      className={`plexo-mark ${mode} ${className || ''}`}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          /* ── Idle: soft staggered breathe ───────────────────────────── */
          @keyframes think-line {
            0%, 100% { opacity: 0.25; }
            50%       { opacity: 0.9; }
          }
          @keyframes think-core {
            0%, 100% { opacity: 0.7; }
            50%       { opacity: 1; }
          }

          /* ── Entry: lines draw in ──────────────────────────────────── */
          @keyframes line-draw {
            from { stroke-dashoffset: 60; }
            to   { stroke-dashoffset: 0; }
          }
          @keyframes fade-in {
            from { opacity: 0; }
            to   { opacity: 1; }
          }

          /* ── Idle state ────────────────────────────────────────────── */
          .mark-anim .df-left {
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.4s cubic-bezier(0.16,1,0.3,1) 0.4s forwards,
                       think-line 2.4s ease-in-out 1.4s infinite;
          }
          .mark-anim .df-right {
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.4s cubic-bezier(0.16,1,0.3,1) 0.55s forwards,
                       think-line 2.4s ease-in-out 1.8s infinite;
          }
          .mark-anim .df-base-l {
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.3s cubic-bezier(0.16,1,0.3,1) 0.7s forwards,
                       think-line 2.4s ease-in-out 2.0s infinite;
          }
          .mark-anim .df-base-r {
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.3s cubic-bezier(0.16,1,0.3,1) 0.8s forwards,
                       think-line 2.4s ease-in-out 2.2s infinite;
          }
          .mark-anim .df-node {
            animation: fade-in 0.4s cubic-bezier(0.16,1,0.3,1) 0.3s both,
                       think-core 2.4s ease-in-out 1.4s infinite;
          }

          /* ── Working: faster simultaneous pulse ────────────────────── */
          @keyframes work-line {
            0%, 100% { opacity: 0.3; }
            50%       { opacity: 1; }
          }
          @keyframes work-core {
            0%, 100% { opacity: 0.8; transform: scale(1); }
            50%       { opacity: 1;   transform: scale(1.15); }
          }

          .mark-working .df-left,
          .mark-working .df-right,
          .mark-working .df-base-l,
          .mark-working .df-base-r {
            animation: work-line 0.9s ease-in-out infinite;
          }
          .mark-working .df-right  { animation-delay: 0.1s; }
          .mark-working .df-base-l { animation-delay: 0.2s; }
          .mark-working .df-base-r { animation-delay: 0.3s; }
          .mark-working .df-node {
            animation: work-core 0.9s ease-in-out infinite;
          }
          .mark-working .df-node-top    { transform-origin: 24px 10px; }
          .mark-working .df-node-bl     { transform-origin: 12px 34px; }
          .mark-working .df-node-br     { transform-origin: 36px 34px; }
        `}
      </style>
      <g>
        {/* Left edge: top -> bottom-left */}
        <line className="df-left" x1="24" y1="10" x2="12" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Right edge: top -> bottom-right */}
        <line className="df-right" x1="24" y1="10" x2="36" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Base left segment (gap in center) */}
        <line className="df-base-l" x1="12" y1="34" x2="20" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Base right segment (gap in center) */}
        <line className="df-base-r" x1="28" y1="34" x2="36" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        {/* Vertex dots */}
        <circle className="df-node df-node-top" cx="24" cy="10" r="3" fill="currentColor"/>
        <circle className="df-node df-node-bl" cx="12" cy="34" r="3" fill="currentColor"/>
        <circle className="df-node df-node-br" cx="36" cy="34" r="3" fill="currentColor"/>
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
        <span className="font-display font-medium text-xl tracking-tight text-text-primary leading-none -mt-1 pt-1">plexo</span>
      )}
    </div>
  )
}
