// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

/**
 * PlexoMark — Tesseract Frame brand mark (brand/README.md, V2 Geometric
 * Precision). Outer square + inner 45°-rotated square + four projection lines
 * + center node. The four lines map to Plexo's four primitives: agents,
 * memory, cognition, execution.
 *
 * Geometry mirrors `brand/plexo-symbol-on-dark.svg` (48-unit viewBox) so the
 * app, launcher, favicon, and desktop all render the same mark.
 *
 * Props:
 *   idle    — default; projection lines shimmer in (500ms)
 *   working — agent processing; inner square rotates slowly (8s/rev)
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
  const mode = working ? 'tf-working' : idle ? 'tf-idle' : ''
  return (
    <svg
      className={`plexo-mark ${mode} ${className || ''}`}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          @keyframes tf-proj-draw {
            from { opacity: 0; }
            to   { opacity: 0.5; }
          }
          .tf-idle .tf-proj {
            animation: tf-proj-draw 0.5s cubic-bezier(0.16,1,0.3,1) 0.2s both;
          }
          @keyframes tf-node-pulse {
            0%, 100% { opacity: 0.7; }
            50%       { opacity: 1; }
          }
          .tf-idle .tf-node {
            animation: tf-node-pulse 2.4s ease-in-out 0.6s infinite;
          }
          /* Inner square rotates during agent work — 8s/rev, linear (per brand). */
          @keyframes tf-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          .tf-working .tf-inner {
            transform-origin: 24px 24px;
            animation: tf-spin 8s linear infinite;
          }
          .tf-working .tf-proj { opacity: 0.5; }
        `}
      </style>
      <g>
        {/* Outer square */}
        <rect x="8" y="8" width="32" height="32" stroke="currentColor" strokeWidth="1.5" />
        {/* Projection lines (four corners of outer to nearest inner vertex) */}
        <line className="tf-proj" x1="8" y1="8" x2="8" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
        <line className="tf-proj" x1="40" y1="8" x2="40" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
        <line className="tf-proj" x1="8" y1="40" x2="8" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
        <line className="tf-proj" x1="40" y1="40" x2="40" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
        {/* Inner rotated square (45deg) */}
        <polygon
          className="tf-inner"
          points="24,8 40,24 24,40 8,24"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Center node */}
        <circle className="tf-node" cx="24" cy="24" r="2.5" fill="currentColor" />
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
