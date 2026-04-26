// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import React from 'react'

/**
 * PlexoMark — Tesseract Frame brand mark (V2 Geometric Precision).
 *
 * Outer square + inner rotated 45deg square, projection lines at corners,
 * center node. Reads as a 2D projection of higher-dimensional structure.
 *
 * Props:
 *   idle    — default; subtle projection-line shimmer (2.4s cycle)
 *   working — agent processing; inner square slow rotation (8s/rev)
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
          /* ── Entry: geometric draw-in ──────────────────────────────── */
          @keyframes tf-draw {
            from { stroke-dashoffset: 200; }
            to   { stroke-dashoffset: 0; }
          }
          @keyframes tf-fade {
            from { opacity: 0; }
            to   { opacity: 1; }
          }

          /* ── Idle: projection lines shimmer ────────────────────────── */
          @keyframes tf-proj-pulse {
            0%, 100% { opacity: 0.25; }
            50%       { opacity: 0.6; }
          }
          @keyframes tf-core-pulse {
            0%, 100% { opacity: 0.7; }
            50%       { opacity: 1; }
          }

          /* ── Idle state ────────────────────────────────────────────── */
          .tf-idle .tf-outer {
            stroke-dasharray: 200; stroke-dashoffset: 200;
            animation: tf-draw 0.6s cubic-bezier(0.16,1,0.3,1) 0.2s forwards;
          }
          .tf-idle .tf-inner {
            stroke-dasharray: 200; stroke-dashoffset: 200;
            animation: tf-draw 0.6s cubic-bezier(0.16,1,0.3,1) 0.4s forwards;
          }
          .tf-idle .tf-proj {
            animation: tf-fade 0.4s ease 0.6s both,
                       tf-proj-pulse 2.4s ease-in-out 1.2s infinite;
          }
          .tf-idle .tf-node {
            animation: tf-fade 0.4s ease 0.5s both,
                       tf-core-pulse 2.4s ease-in-out 1.2s infinite;
          }

          /* ── Working: inner square rotates ─────────────────────────── */
          @keyframes tf-rotate {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          @keyframes tf-work-proj {
            0%, 100% { opacity: 0.3; }
            50%       { opacity: 0.8; }
          }
          @keyframes tf-work-core {
            0%, 100% { opacity: 0.8; transform: scale(1); }
            50%       { opacity: 1;   transform: scale(1.2); }
          }

          .tf-working .tf-inner {
            transform-origin: 24px 24px;
            animation: tf-rotate 8s linear infinite;
          }
          .tf-working .tf-proj {
            animation: tf-work-proj 1.2s ease-in-out infinite;
          }
          .tf-working .tf-node {
            transform-origin: 24px 24px;
            animation: tf-work-core 1.2s ease-in-out infinite;
          }
        `}
      </style>
      <g>
        {/* Outer square */}
        <rect className="tf-outer" x="8" y="8" width="32" height="32" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        {/* Inner rotated square (diamond) */}
        <polygon className="tf-inner" points="24,8 40,24 24,40 8,24" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        {/* Projection lines (outer corners to nearest inner vertex) */}
        <line className="tf-proj" x1="8" y1="8" x2="8" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5"/>
        <line className="tf-proj" x1="40" y1="8" x2="40" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5"/>
        <line className="tf-proj" x1="8" y1="40" x2="8" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5"/>
        <line className="tf-proj" x1="40" y1="40" x2="40" y2="24" stroke="currentColor" strokeWidth="0.75" opacity="0.5"/>
        {/* Center node */}
        <circle className="tf-node" cx="24" cy="24" r="2.5" fill="currentColor"/>
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
        <span className="font-display font-semibold text-xl tracking-tight text-text-primary leading-none" style={{ letterSpacing: '-0.03em' }}>plexo</span>
      )}
    </div>
  )
}
