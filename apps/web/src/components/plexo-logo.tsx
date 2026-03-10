import React from 'react'

export function PlexoMark({ className, idle = true }: { className?: string, idle?: boolean }) {
  return (
    <svg 
      className={`plexo-mark ${className || ''}`}
      viewBox="0 0 44 44" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          @keyframes think-line {
            0%, 100% { opacity: 0.15; }
            50%       { opacity: 0.8; }
          }
        
          @keyframes think-glow {
            0%, 100% { opacity: 0.2; r: 5; }
            50%       { opacity: 0.6; r: 9; }
          }
        
          @keyframes think-core {
            0%, 100% { opacity: 0.7; }
            50%       { opacity: 1; }
          }

          @keyframes fly-in-tl {
            from { transform: translate(-20px,-20px); opacity: 0; }
            to   { transform: translate(0,0); opacity: 1; }
          }
          @keyframes fly-in-bl {
            from { transform: translate(-20px,20px); opacity: 0; }
            to   { transform: translate(0,0); opacity: 1; }
          }
          @keyframes fly-in-r {
            from { transform: translate(20px,0); opacity: 0; }
            to   { transform: translate(0,0); opacity: 1; }
          }
          @keyframes line-draw {
            from { stroke-dashoffset: 60; }
            to   { stroke-dashoffset: 0; }
          }
        
          .mark-anim .line-1 { 
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.4s cubic-bezier(0.16,1,0.3,1) 0.55s forwards, think-line 2.4s ease-in-out 1.55s infinite; 
          }
          .mark-anim .line-2 { 
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.4s cubic-bezier(0.16,1,0.3,1) 0.7s forwards, think-line 2.4s ease-in-out 1.95s infinite; 
          }
          .mark-anim .line-3 { 
            stroke-dasharray: 60; stroke-dashoffset: 60;
            animation: line-draw 0.4s cubic-bezier(0.16,1,0.3,1) 0.85s forwards, think-line 2.4s ease-in-out 2.35s infinite; 
          }
        
          .mark-anim .glow-ring { opacity: 0; animation: think-glow 2.4s ease-in-out 1.95s infinite; }
          .mark-anim .node-tl   { animation: fly-in-tl 0.5s cubic-bezier(0.16,1,0.3,1) 0s both, think-core 2.4s ease-in-out 1.55s infinite; transform-origin: 10px 10px; }
          .mark-anim .node-bl   { animation: fly-in-bl 0.5s cubic-bezier(0.16,1,0.3,1) 0.1s both, think-core 2.4s ease-in-out 2.35s infinite; transform-origin: 10px 34px; }
          .mark-anim .node-r-outer { animation: fly-in-r 0.6s cubic-bezier(0.16,1,0.3,1) 0.2s both, think-core 2.4s ease-in-out 1.95s infinite; transform-origin: 34px 22px; }
          .mark-anim .node-r-inner { animation: fly-in-r 0.6s cubic-bezier(0.16,1,0.3,1) 0.2s both; transform-origin: 34px 22px; }
        `}
      </style>
      <g className={idle ? 'mark-anim' : ''}>
        <circle className="glow-ring" cx="34" cy="22" r="5" fill="var(--color-indigo)" opacity="0.2"/>
        <line className="line-1" x1="10" y1="10" x2="10" y2="34" stroke="var(--color-indigo)" strokeWidth="1.8" strokeLinecap="round"/>
        <line className="line-2" x1="10" y1="10" x2="34" y2="22" stroke="var(--color-indigo)" strokeWidth="1.8" strokeLinecap="round"/>
        <line className="line-3" x1="10" y1="34" x2="34" y2="22" stroke="var(--color-indigo)" strokeWidth="1.8" strokeLinecap="round"/>
        <circle className="node-tl" cx="10" cy="10" r="3.5" fill="var(--color-indigo)"/>
        <circle className="node-bl" cx="10" cy="34" r="3.5" fill="var(--color-indigo)"/>
        <circle className="node-r-outer" cx="34" cy="22" r="6" fill="var(--color-indigo)"/>
        <circle className="node-r-inner" cx="34" cy="22" r="3" fill="var(--color-emerald)"/>
      </g>
    </svg>
  )
}

export function PlexoLogo({ className, showWordmark = true, idle = true }: { className?: string, showWordmark?: boolean, idle?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${className || ''}`}>
      <PlexoMark className="w-8 h-8 shrink-0" idle={idle} />
      {showWordmark && (
        <span className="font-display font-bold text-xl tracking-tight text-text-primary leading-none -mt-1 pt-1">plexo</span>
      )}
    </div>
  )
}
